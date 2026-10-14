import { randomUUID } from 'node:crypto';
import type { Movie, MovieRequest, MovieRequestStatus } from '../shared/types.js';
import { nowIso, type Db } from './db.js';
import { badRequest, notFound } from './errors.js';

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

/** Title comparison that ignores case, punctuation and a leading "The"/"A". */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

/** "Can you add …?" requests from family members, shown to the administrator. */
export class MovieRequests {
  constructor(private readonly db: Db) {}

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
  list(viewer: { id: string; isAdmin: boolean }): MovieRequest[] {
    const rows = (viewer.isAdmin
      ? this.db.prepare('SELECT * FROM movie_requests ORDER BY created_at DESC LIMIT 500').all()
      : this.db
          .prepare(
            'SELECT * FROM movie_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
          )
          .all(viewer.id)) as unknown as RequestRow[];
    // Open requests first, newest first within each group.
    const order: Record<MovieRequestStatus, number> = { open: 0, added: 1, declined: 2 };
    return rows
      .map((r) => this.toRequest(r, viewer.id))
      .sort((a, b) => order[a.status] - order[b.status]);
  }

  create(
    user: { id: string; name: string },
    input: { title?: unknown; year?: unknown; note?: unknown },
    library: Movie[],
  ): MovieRequest {
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
    const open = this.db
      .prepare(`SELECT * FROM movie_requests WHERE status = 'open'`)
      .all() as unknown as RequestRow[];
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
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO movie_requests (id, user_id, user_name, title, year, note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, user.id, user.name, title, year, note, now, now);
    return this.get(id, user.id);
  }

  get(id: string, viewerId: string): MovieRequest {
    const row = this.db.prepare('SELECT * FROM movie_requests WHERE id = ?').get(id) as
      RequestRow | undefined;
    if (!row) throw notFound('Request not found.');
    return this.toRequest(row, viewerId);
  }

  setStatus(
    id: string,
    status: MovieRequestStatus,
    viewerId: string,
    itemId: string | null = null,
  ) {
    const result = this.db
      .prepare(
        'UPDATE movie_requests SET status = ?, item_id = COALESCE(?, item_id), updated_at = ? WHERE id = ?',
      )
      .run(status, itemId, nowIso(), id);
    if (result.changes === 0) throw notFound('Request not found.');
    return this.get(id, viewerId);
  }

  /** Requesters can withdraw their own; administrators can remove any. */
  remove(id: string, viewer: { id: string; isAdmin: boolean }) {
    const request = this.get(id, viewer.id);
    if (!viewer.isAdmin && !request.mine) throw notFound('Request not found.');
    this.db.prepare('DELETE FROM movie_requests WHERE id = ?').run(id);
  }

  /**
   * Mark open requests as added when the movie shows up in the library.
   * Returns the requests that were fulfilled.
   */
  fulfil(library: Movie[]): MovieRequest[] {
    const open = this.db
      .prepare(`SELECT * FROM movie_requests WHERE status = 'open'`)
      .all() as unknown as RequestRow[];
    const done: MovieRequest[] = [];
    for (const row of open) {
      const movie = findInLibrary(library, row.title, row.year);
      if (movie) done.push(this.setStatus(row.id, 'added', '', movie.id));
    }
    return done;
  }
}

/** A library movie matching a requested title (and year, when given, ±1). */
export function findInLibrary(library: Movie[], title: string, year: number | null): Movie | null {
  const key = titleKey(title);
  return (
    library.find(
      (m) =>
        (titleKey(m.title) === key ||
          (m.originalTitle != null && titleKey(m.originalTitle) === key)) &&
        (year == null || m.year == null || Math.abs(m.year - year) <= 1),
    ) ?? null
  );
}
