import { randomInt, randomUUID } from 'node:crypto';
import type { Movie, MovieNight, NightCandidate } from '../shared/types.js';
import { nowIso, transaction, type Db } from './db.js';
import { ApiError, badRequest, notFound } from './errors.js';

// Join codes avoid letters that are easy to confuse (I/O vs 1/0).
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const NIGHT_HOURS = 12;
const MAX_VOTERS = 40;

interface NightRow {
  id: string;
  code: string;
  host_user_id: string;
  host_name: string;
  candidates: string;
  status: 'open' | 'closed';
  winner_id: string | null;
  created_at: string;
  closed_at: string | null;
}

/**
 * Movie night: a shortlist everyone votes on from their phone with a short
 * code. Votes are one per person (changeable until voting closes). Nights
 * expire after half a day, so codes stay short.
 */
export class MovieNights {
  constructor(private readonly db: Db) {}

  private row(where: string, value: string): NightRow | null {
    const since = new Date(Date.now() - NIGHT_HOURS * 3600_000).toISOString();
    return (
      (this.db
        .prepare(
          `SELECT * FROM movie_nights WHERE ${where} = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(value, since) as NightRow | undefined) ?? null
    );
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = Array.from(
        { length: 4 },
        () => CODE_LETTERS[randomInt(CODE_LETTERS.length)],
      ).join('');
      const taken = this.row('code', code);
      if (!taken || taken.status === 'closed') return code;
    }
    throw new ApiError('INTERNAL', 'Could not create a join code, try again.');
  }

  /** Candidate details are copied in, so voters' phones need no library access. */
  create(host: { id: string; name: string }, movies: Movie[]): string {
    if (movies.length < 2) throw badRequest('A movie night needs at least two movies.');
    const shortlist: Omit<NightCandidate, 'votes'>[] = movies.slice(0, 8).map((m) => ({
      id: m.id,
      title: m.title,
      year: m.year,
      runtimeMinutes: m.runtimeMinutes,
      genres: m.genres.slice(0, 3),
      overview: m.overview,
      poster: m.images.poster,
    }));
    const id = randomUUID();
    // One open night per host: starting a new one closes the old one.
    this.db
      .prepare(
        `UPDATE movie_nights SET status = 'closed', closed_at = ? WHERE host_user_id = ? AND status = 'open'`,
      )
      .run(nowIso(), host.id);
    this.db
      .prepare(
        `INSERT INTO movie_nights (id, code, host_user_id, host_name, candidates, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.newCode(), host.id, host.name, JSON.stringify(shortlist), nowIso());
    return id;
  }

  /** The host's current night (open, or closed within the last 12 hours). */
  currentFor(hostUserId: string): string | null {
    return this.row('host_user_id', hostUserId)?.id ?? null;
  }

  idForCode(code: string): string {
    const row = this.row('code', code.trim().toUpperCase());
    if (!row) throw notFound('No movie night with that code. Check the code on the TV.');
    return row.id;
  }

  vote(nightId: string, voter: { key: string; name: string }, itemId: string) {
    const row = this.row('id', nightId);
    if (!row) throw notFound('This movie night has ended.');
    if (row.status !== 'open') throw badRequest('Voting has closed.');
    const candidates = (JSON.parse(row.candidates) as { id: string }[]).map((c) => c.id);
    if (!candidates.includes(itemId)) throw badRequest('That movie isn’t one of the choices.');
    const name = voter.name.trim().slice(0, 30);
    if (!name) throw badRequest('Enter your name.');
    if (!/^[\w-]{8,80}$/.test(voter.key)) throw badRequest('Invalid voter.');
    transaction(this.db, () => {
      const count = this.db
        .prepare('SELECT COUNT(*) AS n FROM night_votes WHERE night_id = ? AND voter_key != ?')
        .get(nightId, voter.key) as { n: number };
      if (count.n >= MAX_VOTERS) throw badRequest('This movie night is full.');
      this.db
        .prepare(
          `INSERT INTO night_votes (night_id, voter_key, voter_name, item_id, voted_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(night_id, voter_key) DO UPDATE SET item_id = excluded.item_id,
             voter_name = excluded.voter_name, voted_at = excluded.voted_at`,
        )
        .run(nightId, voter.key, name, itemId, nowIso());
    });
  }

  myVote(nightId: string, voterKey: string): string | null {
    const row = this.db
      .prepare('SELECT item_id FROM night_votes WHERE night_id = ? AND voter_key = ?')
      .get(nightId, voterKey) as { item_id: string } | undefined;
    return row?.item_id ?? null;
  }

  close(nightId: string, hostUserId: string) {
    const row = this.row('id', nightId);
    if (!row || row.host_user_id !== hostUserId) throw notFound('Movie night not found.');
    if (row.status === 'closed') return;
    const winners = this.tally(row).winners;
    this.db
      .prepare(
        `UPDATE movie_nights SET status = 'closed', closed_at = ?, winner_id = ? WHERE id = ?`,
      )
      .run(nowIso(), winners.length === 1 ? winners[0]! : null, nightId);
  }

  private tally(row: NightRow) {
    const shortlist = JSON.parse(row.candidates) as Omit<NightCandidate, 'votes'>[];
    const candidates = shortlist.map((c) => c.id);
    const votes = this.db
      .prepare('SELECT voter_name, item_id FROM night_votes WHERE night_id = ? ORDER BY voted_at')
      .all(row.id) as { voter_name: string; item_id: string }[];
    const counts = new Map(candidates.map((id) => [id, 0]));
    for (const v of votes) counts.set(v.item_id, (counts.get(v.item_id) ?? 0) + 1);
    const top = Math.max(0, ...counts.values());
    const winners = top > 0 ? candidates.filter((id) => counts.get(id) === top) : [];
    return { shortlist, counts, votes, winners };
  }

  /** The night as shown to the host and voters. */
  view(nightId: string): MovieNight {
    const row = this.row('id', nightId);
    if (!row) throw notFound('This movie night has ended.');
    const { shortlist, counts, votes, winners } = this.tally(row);
    const list: NightCandidate[] = shortlist.map((c) => ({ ...c, votes: counts.get(c.id) ?? 0 }));
    return {
      id: row.id,
      code: row.code,
      hostName: row.host_name,
      status: row.status,
      candidates: list,
      voters: votes.map((v) => ({ name: v.voter_name })),
      winners: row.status === 'closed' ? winners : [],
      createdAt: row.created_at,
    };
  }

  hostOf(nightId: string): string | null {
    return this.row('id', nightId)?.host_user_id ?? null;
  }
}
