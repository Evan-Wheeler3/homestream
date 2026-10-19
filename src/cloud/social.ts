// Movie night voting and movie requests: the Mac version's MovieNights and
// MovieRequests (src/server/nights.ts, requests.ts) on D1.
import { findInLibrary, titleKey } from '../shared/requests.js';
import type {
  Movie,
  MovieNight,
  MovieRequest,
  MovieRequestStatus,
  NightCandidate,
} from '../shared/types.js';
import { ApiError, badRequest, notFound } from '../server/errors.js';
import { nowIso, randomId, type Sql } from './db.js';

// -----------------------------------------------------------------------------
// Movie night

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

const randomIndex = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0]! % n;

/**
 * A shortlist everyone votes on from their phone with a short code. One vote
 * per person (changeable until voting closes); nights expire after half a day.
 */
export class MovieNights {
  constructor(private readonly sql: Sql) {}

  private row(where: 'id' | 'code' | 'host_user_id', value: string): Promise<NightRow | null> {
    const since = new Date(Date.now() - NIGHT_HOURS * 3600_000).toISOString();
    return this.sql.get<NightRow>(
      `SELECT * FROM movie_nights WHERE ${where} = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
      value,
      since,
    );
  }

  private async newCode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = Array.from(
        { length: 4 },
        () => CODE_LETTERS[randomIndex(CODE_LETTERS.length)],
      ).join('');
      const taken = await this.row('code', code);
      if (!taken || taken.status === 'closed') return code;
    }
    throw new ApiError('INTERNAL', 'Could not create a join code, try again.');
  }

  /** Candidate details are copied in, so voters' phones need no library access. */
  async create(host: { id: string; name: string }, movies: Movie[]): Promise<string> {
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
    const id = randomId();
    const now = nowIso();
    const code = await this.newCode();
    // One open night per host: starting a new one closes the old one.
    await this.sql.batch([
      this.sql.stmt(
        `UPDATE movie_nights SET status = 'closed', closed_at = ? WHERE host_user_id = ? AND status = 'open'`,
        now,
        host.id,
      ),
      this.sql.stmt(
        `INSERT INTO movie_nights (id, code, host_user_id, host_name, candidates, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        code,
        host.id,
        host.name,
        JSON.stringify(shortlist),
        now,
      ),
    ]);
    return id;
  }

  /** The host's current night (open, or closed within the last 12 hours). */
  async currentFor(hostUserId: string): Promise<string | null> {
    return (await this.row('host_user_id', hostUserId))?.id ?? null;
  }

  async idForCode(code: string): Promise<string> {
    const row = await this.row('code', code.trim().toUpperCase());
    if (!row) throw notFound('No movie night with that code. Check the code on the TV.');
    return row.id;
  }

  async vote(nightId: string, voter: { key: string; name: string }, itemId: string) {
    const row = await this.row('id', nightId);
    if (!row) throw notFound('This movie night has ended.');
    if (row.status !== 'open') throw badRequest('Voting has closed.');
    const candidates = (JSON.parse(row.candidates) as { id: string }[]).map((c) => c.id);
    if (!candidates.includes(itemId)) throw badRequest('That movie isn’t one of the choices.');
    const name = voter.name.trim().slice(0, 30);
    if (!name) throw badRequest('Enter your name.');
    if (!/^[\w-]{8,80}$/.test(voter.key)) throw badRequest('Invalid voter.');
    const count = await this.sql.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM night_votes WHERE night_id = ? AND voter_key != ?',
      nightId,
      voter.key,
    );
    if ((count?.n ?? 0) >= MAX_VOTERS) throw badRequest('This movie night is full.');
    await this.sql.run(
      `INSERT INTO night_votes (night_id, voter_key, voter_name, item_id, voted_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(night_id, voter_key) DO UPDATE SET item_id = excluded.item_id,
         voter_name = excluded.voter_name, voted_at = excluded.voted_at`,
      nightId,
      voter.key,
      name,
      itemId,
      nowIso(),
    );
  }

  async myVote(nightId: string, voterKey: string): Promise<string | null> {
    const row = await this.sql.get<{ item_id: string }>(
      'SELECT item_id FROM night_votes WHERE night_id = ? AND voter_key = ?',
      nightId,
      voterKey,
    );
    return row?.item_id ?? null;
  }

  async close(nightId: string, hostUserId: string) {
    const row = await this.row('id', nightId);
    if (!row || row.host_user_id !== hostUserId) throw notFound('Movie night not found.');
    if (row.status === 'closed') return;
    const { winners } = await this.tally(row);
    await this.sql.run(
      `UPDATE movie_nights SET status = 'closed', closed_at = ?, winner_id = ? WHERE id = ?`,
      nowIso(),
      winners.length === 1 ? winners[0]! : null,
      nightId,
    );
  }

  private async tally(row: NightRow) {
    const shortlist = JSON.parse(row.candidates) as Omit<NightCandidate, 'votes'>[];
    const candidates = shortlist.map((c) => c.id);
    const votes = await this.sql.all<{ voter_name: string; item_id: string }>(
      'SELECT voter_name, item_id FROM night_votes WHERE night_id = ? ORDER BY voted_at',
      row.id,
    );
    const counts = new Map(candidates.map((id) => [id, 0]));
    for (const v of votes) counts.set(v.item_id, (counts.get(v.item_id) ?? 0) + 1);
    const top = Math.max(0, ...counts.values());
    const winners = top > 0 ? candidates.filter((id) => counts.get(id) === top) : [];
    return { shortlist, counts, votes, winners };
  }

  /** The night as shown to the host and voters. */
  async view(nightId: string): Promise<MovieNight> {
    const row = await this.row('id', nightId);
    if (!row) throw notFound('This movie night has ended.');
    const { shortlist, counts, votes, winners } = await this.tally(row);
    return {
      id: row.id,
      code: row.code,
      hostName: row.host_name,
      status: row.status,
      candidates: shortlist.map((c) => ({ ...c, votes: counts.get(c.id) ?? 0 })),
      voters: votes.map((v) => ({ name: v.voter_name })),
      winners: row.status === 'closed' ? winners : [],
      createdAt: row.created_at,
    };
  }
}

// -----------------------------------------------------------------------------
// Movie requests

const MAX_OPEN_PER_PERSON = 25;

interface RequestRow {
  id: string;
  user_id: string;
  user_name: string;
  title: string;
  year: number | null;
  note: string;
  status: MovieRequestStatus;
  item_id: string | null;
  created_at: string;
  updated_at: string;
}

/** "Can you add …?" requests from family members, shown to the administrator. */
export class MovieRequests {
  constructor(private readonly sql: Sql) {}

  private toRequest(row: RequestRow, viewerId: string): MovieRequest {
    return {
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      title: row.title,
      year: row.year,
      note: row.note,
      status: row.status,
      itemId: row.item_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      mine: row.user_id === viewerId,
    };
  }

  /** Administrators see everyone's requests; others see their own. */
  async list(viewer: { id: string; isAdmin: boolean }): Promise<MovieRequest[]> {
    const rows = viewer.isAdmin
      ? await this.sql.all<RequestRow>(
          'SELECT * FROM movie_requests ORDER BY created_at DESC LIMIT 500',
        )
      : await this.sql.all<RequestRow>(
          'SELECT * FROM movie_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
          viewer.id,
        );
    const order: Record<MovieRequestStatus, number> = { open: 0, added: 1, declined: 2 };
    return rows
      .map((r) => this.toRequest(r, viewer.id))
      .sort((a, b) => order[a.status] - order[b.status]);
  }

  async create(
    user: { id: string; name: string },
    input: { title?: unknown; year?: unknown; note?: unknown },
    library: Movie[],
  ): Promise<MovieRequest> {
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 150) : '';
    if (!title) throw badRequest('Enter a movie title.');
    const year =
      input.year === null || input.year === undefined || input.year === ''
        ? null
        : Number(input.year);
    if (year !== null && (!Number.isInteger(year) || year < 1880 || year > 2100)) {
      throw badRequest('Enter a year like 1977, or leave it empty.');
    }
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '';
    const have = findInLibrary(library, title, year);
    if (have) throw badRequest(`${have.title} is already in the library.`);
    const key = titleKey(title);
    const open = await this.sql.all<RequestRow>(
      `SELECT * FROM movie_requests WHERE status = 'open'`,
    );
    const duplicate = open.find(
      (r) => titleKey(r.title) === key && (r.year == null || year == null || r.year === year),
    );
    if (duplicate) {
      throw badRequest(
        duplicate.user_id === user.id
          ? 'You’ve already asked for this one.'
          : `${duplicate.user_name} has already asked for this one.`,
      );
    }
    if (open.filter((r) => r.user_id === user.id).length >= MAX_OPEN_PER_PERSON) {
      throw badRequest(`You have ${MAX_OPEN_PER_PERSON} open requests. Wait for a few first.`);
    }
    const id = randomId();
    const now = nowIso();
    await this.sql.run(
      `INSERT INTO movie_requests (id, user_id, user_name, title, year, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      id,
      user.id,
      user.name,
      title,
      year,
      note,
      now,
      now,
    );
    return this.get(id, user.id);
  }

  async get(id: string, viewerId: string): Promise<MovieRequest> {
    const row = await this.sql.get<RequestRow>('SELECT * FROM movie_requests WHERE id = ?', id);
    if (!row) throw notFound('Request not found.');
    return this.toRequest(row, viewerId);
  }

  async setStatus(
    id: string,
    status: MovieRequestStatus,
    viewerId: string,
    itemId: string | null = null,
  ) {
    const changed = await this.sql.run(
      'UPDATE movie_requests SET status = ?, item_id = COALESCE(?, item_id), updated_at = ? WHERE id = ?',
      status,
      itemId,
      nowIso(),
      id,
    );
    if (changed === 0) throw notFound('Request not found.');
    return this.get(id, viewerId);
  }

  /** Requesters can withdraw their own; administrators can remove any. */
  async remove(id: string, viewer: { id: string; isAdmin: boolean }) {
    const request = await this.get(id, viewer.id);
    if (!viewer.isAdmin && !request.mine) throw notFound('Request not found.');
    await this.sql.run('DELETE FROM movie_requests WHERE id = ?', id);
  }

  /** Marks open requests as added when the movie shows up in the library. */
  async fulfil(library: Movie[]): Promise<MovieRequest[]> {
    const open = await this.sql.all<RequestRow>(
      `SELECT * FROM movie_requests WHERE status = 'open'`,
    );
    const done: MovieRequest[] = [];
    for (const row of open) {
      const movie = findInLibrary(library, row.title, row.year);
      if (movie) done.push(await this.setStatus(row.id, 'added', '', movie.id));
    }
    return done;
  }
}
