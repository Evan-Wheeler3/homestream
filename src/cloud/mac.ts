// The Mac's side door: it adds movies after uploading their files to R2,
// reports rip progress (and collects Discs-page actions taken in the cloud),
// and moves existing data across. Authenticated with the shared MAC_TOKEN.
import type { Movie, Person, RipJob, RipperHealth, RipsPayload } from '../shared/types.js';
import { ApiError, badRequest, notFound } from '../server/errors.js';
import { timingSafeEqual } from './auth.js';
import {
  loadSnapshot,
  mediaUrl,
  type StoredDetail,
  type StoredSubtitle,
  type StoredSummary,
} from './catalog.js';
import { nowIso, randomId, type Sql } from './db.js';
import type { CloudEnv } from './env.js';
import { isServableKey } from './media.js';
import { MovieRequests } from './social.js';

export function checkMacToken(env: CloudEnv, header: string | undefined) {
  const token = header?.replace(/^Bearer\s+/i, '') ?? '';
  if (!env.MAC_TOKEN || env.MAC_TOKEN.length < 32 || !timingSafeEqual(token, env.MAC_TOKEN)) {
    throw new ApiError('UNAUTHENTICATED', 'This needs the Mac’s upload token.');
  }
}

// -----------------------------------------------------------------------------
// Rip progress

/** The Mac counts as offline when it hasn't reported for this long. */
const MAC_OFFLINE_MS = 2 * 60_000;

interface MacReport {
  health: RipperHealth;
  jobs: RipJob[];
}

const OFFLINE_HEALTH: RipperHealth = {
  enabled: false,
  problems: [],
  warnings: [],
  watching: false,
  canSearch: true,
};

export async function readMacStatus(sql: Sql): Promise<RipsPayload> {
  const row = await sql.get<{ data: string; updated_at: string }>(
    `SELECT data, updated_at FROM mac_status WHERE id = 'mac'`,
  );
  if (!row) {
    return { health: OFFLINE_HEALTH, jobs: [], mac: { online: false, lastSeen: null } };
  }
  const report = JSON.parse(row.data) as MacReport;
  const online = Date.now() - Date.parse(row.updated_at) < MAC_OFFLINE_MS;
  return {
    health: { ...report.health, canSearch: true },
    jobs: report.jobs,
    mac: { online, lastSeen: row.updated_at },
  };
}

/** Stores the Mac's report and hands it any Discs-page actions waiting for it. */
export async function receiveMacStatus(sql: Sql, body: unknown) {
  const report = body as Partial<MacReport>;
  if (!report || typeof report.health !== 'object' || !Array.isArray(report.jobs)) {
    throw badRequest('Send { health, jobs }.');
  }
  const now = nowIso();
  await sql.run(
    `INSERT INTO mac_status (id, data, updated_at) VALUES ('mac', ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    JSON.stringify({ health: report.health, jobs: report.jobs.slice(0, 50) }),
    now,
  );
  const commands = await sql.all<{ id: string; job_id: string; action: string; payload: string }>(
    `SELECT id, job_id, action, payload FROM mac_commands WHERE taken_at IS NULL ORDER BY created_at LIMIT 20`,
  );
  if (commands.length) {
    await sql.batch(
      commands.map((c) => sql.stmt('UPDATE mac_commands SET taken_at = ? WHERE id = ?', now, c.id)),
    );
  }
  return {
    commands: commands.map((c) => ({
      id: c.id,
      jobId: c.job_id,
      action: c.action,
      payload: JSON.parse(c.payload) as unknown,
    })),
  };
}

export async function finishCommand(sql: Sql, id: string, error: unknown) {
  await sql.run(
    'UPDATE mac_commands SET done_at = ?, error = ? WHERE id = ?',
    nowIso(),
    typeof error === 'string' && error ? error.slice(0, 500) : null,
    id,
  );
}

export const RIP_ACTIONS = ['choose', 'name', 'episodes', 'kind', 'retry', 'dismiss'] as const;
export type RipAction = (typeof RIP_ACTIONS)[number];

/** Queues an action for the Mac's disc drive itself (not one disc's rip), like Eject. */
export async function queueDriveAction(sql: Sql, action: 'eject', userId: string) {
  const status = await readMacStatus(sql);
  if (!status.mac?.online) {
    throw badRequest('The Mac is offline. Switch it on (and wake it up) to eject the disc.');
  }
  await sql.run(
    `INSERT INTO mac_commands (id, job_id, action, payload, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    randomId(),
    '',
    action,
    '{}',
    userId,
    nowIso(),
  );
}

/** Queues a Discs-page action for the Mac and returns the job as last reported. */
export async function queueRipAction(
  sql: Sql,
  jobId: string,
  action: RipAction,
  payload: unknown,
  userId: string,
): Promise<RipJob> {
  const status = await readMacStatus(sql);
  const job = status.jobs.find((j) => j.id === jobId);
  if (!job) throw notFound('That disc is no longer on the Mac’s list.');
  if (!status.mac?.online) {
    throw badRequest('The Mac is offline. Switch it on (and wake it up) to manage discs.');
  }
  await sql.run(
    `INSERT INTO mac_commands (id, job_id, action, payload, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    randomId(),
    jobId,
    action,
    JSON.stringify(payload ?? {}),
    userId,
    nowIso(),
  );
  return { ...job, message: 'Sent to the Mac…' };
}

// -----------------------------------------------------------------------------
// Adding a movie

export interface IngestMovie {
  tmdbId: string | null;
  imdbId: string | null;
  /** Movie fields except id, per-person state and images. */
  summary: Omit<StoredSummary, 'id' | 'images'>;
  detail: Omit<StoredDetail, 'cast'> & {
    cast: (Omit<Person, 'image'> & { imageKey: string | null })[];
  };
  images: { poster: string | null; backdrop: string | null; logo: string | null };
  video: { key: string; bytes: number; sha256: string; durationSeconds: number | null };
  /** Leave out to keep the movie's current subtitles. */
  subtitles?: StoredSubtitle[];
  subtitleStatus: 'disc' | 'downloaded' | 'none';
  franchise: { id: string; name: string; poster: string | null; backdrop: string | null } | null;
  sourcePath: string | null;
}

function key(value: unknown, what: string): string {
  if (typeof value !== 'string' || !isServableKey(value)) throw badRequest(`Invalid ${what} key.`);
  return value;
}

const optionalKey = (value: unknown, what: string) => (value == null ? null : key(value, what));

export async function ingestMovie(env: CloudEnv, sql: Sql, id: string, body: unknown) {
  if (!/^[\w-]{1,64}$/.test(id)) throw badRequest('Invalid movie id.');
  const input = body as IngestMovie;
  if (!input?.summary?.title || !input.video)
    throw badRequest('Send the movie’s details and video.');
  const videoKey = key(input.video.key, 'video');
  const object = await env.MEDIA.head(videoKey);
  if (!object) throw badRequest('The video isn’t in storage yet. Upload it first.');
  if (object.size !== input.video.bytes) {
    throw badRequest(`The stored video is ${object.size} bytes, not ${input.video.bytes}.`);
  }
  const version = input.video.sha256.slice(0, 12);
  const img = (k: string | null, what: string) => {
    const valid = optionalKey(k, what);
    return valid ? mediaUrl(valid, version) : null;
  };
  const summary: StoredSummary = {
    ...input.summary,
    id,
    images: {
      poster: img(input.images.poster, 'poster'),
      backdrop: img(input.images.backdrop, 'backdrop'),
      logo: img(input.images.logo, 'logo'),
    },
  };
  const detail: StoredDetail = {
    ...input.detail,
    cast: (input.detail.cast ?? []).slice(0, 40).map(({ imageKey, ...p }) => ({
      ...p,
      image: imageKey && isServableKey(imageKey) ? mediaUrl(imageKey) : null,
    })),
  };
  // No `subtitles` sent: keep whatever the movie already has.
  const previous = input.subtitles
    ? null
    : await sql.get<{ subtitles: string; subtitle_status: IngestMovie['subtitleStatus'] }>(
        'SELECT subtitles, subtitle_status FROM movies WHERE id = ?',
        id,
      );
  const subtitles = input.subtitles
    ? input.subtitles.filter((s) => isServableKey(s.key))
    : previous
      ? (JSON.parse(previous.subtitles) as StoredSubtitle[])
      : [];
  const subtitleStatus = input.subtitles
    ? input.subtitleStatus
    : (previous?.subtitle_status ?? 'none');
  const now = nowIso();
  const statements = [
    sql.stmt(
      `INSERT INTO movies (id, tmdb_id, imdb_id, title, year, summary, detail, video_key, video_bytes,
         video_sha256, duration_seconds, subtitles, subtitle_status, source_path, date_added, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tmdb_id = excluded.tmdb_id, imdb_id = excluded.imdb_id,
         title = excluded.title, year = excluded.year, summary = excluded.summary, detail = excluded.detail,
         video_key = excluded.video_key, video_bytes = excluded.video_bytes, video_sha256 = excluded.video_sha256,
         duration_seconds = excluded.duration_seconds, subtitles = excluded.subtitles,
         subtitle_status = excluded.subtitle_status, source_path = excluded.source_path,
         updated_at = excluded.updated_at`,
      id,
      input.tmdbId,
      input.imdbId,
      summary.title,
      summary.year,
      JSON.stringify(summary),
      JSON.stringify(detail),
      videoKey,
      input.video.bytes,
      input.video.sha256,
      input.video.durationSeconds,
      JSON.stringify(subtitles),
      subtitles.length ? subtitleStatus : 'none',
      input.sourcePath,
      summary.dateAdded ?? now,
      now,
    ),
    sql.stmt(
      `INSERT INTO item_snapshots (item_id, title, year, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET title = excluded.title, year = excluded.year, last_seen_at = excluded.last_seen_at`,
      id,
      summary.title,
      summary.year,
      now,
    ),
  ];
  if (input.franchise && /^[\w-]{1,64}$/.test(input.franchise.id)) {
    const f = input.franchise;
    const existing = await sql.get<{ movie_ids: string }>(
      'SELECT movie_ids FROM franchises WHERE id = ?',
      f.id,
    );
    const ids = new Set<string>(existing ? (JSON.parse(existing.movie_ids) as string[]) : []);
    ids.add(id);
    statements.push(
      sql.stmt(
        `INSERT INTO franchises (id, name, poster, backdrop, movie_ids, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, poster = COALESCE(excluded.poster, poster),
           backdrop = COALESCE(excluded.backdrop, backdrop), movie_ids = excluded.movie_ids, updated_at = excluded.updated_at`,
        f.id,
        f.name,
        img(f.poster, 'series poster'),
        img(f.backdrop, 'series backdrop'),
        JSON.stringify([...ids]),
        now,
      ),
    );
  }
  await sql.batch(statements);
  // Requests for this movie are now answered.
  const library = (await loadSnapshot(sql, '')).movies;
  const fulfilled = await new MovieRequests(sql).fulfil(library);
  return { id, fulfilled: fulfilled.map((r) => ({ userName: r.userName, title: r.title })) };
}

/**
 * Takes a movie out of the library (e.g. a disc that was named wrong): its files
 * and its place in lists and series. Watch history keeps its title.
 */
export async function removeMovie(env: CloudEnv, sql: Sql, id: string) {
  const movie = await sql.get<{ title: string }>('SELECT title FROM movies WHERE id = ?', id);
  if (!movie) throw notFound('That movie isn’t in the library.');
  const series = await sql.all<{ id: string; movie_ids: string }>(
    'SELECT id, movie_ids FROM franchises',
  );
  await sql.batch([
    sql.stmt('DELETE FROM movies WHERE id = ?', id),
    sql.stmt('DELETE FROM watchlist WHERE item_id = ?', id),
    sql.stmt('DELETE FROM collection_items WHERE item_id = ?', id),
    sql.stmt('DELETE FROM now_playing WHERE item_id = ?', id),
    ...series
      .filter((f) => (JSON.parse(f.movie_ids) as string[]).includes(id))
      .map((f) =>
        sql.stmt(
          'UPDATE franchises SET movie_ids = ?, updated_at = ? WHERE id = ?',
          JSON.stringify((JSON.parse(f.movie_ids) as string[]).filter((m) => m !== id)),
          nowIso(),
          f.id,
        ),
      ),
  ]);
  for (let cursor: string | undefined; ;) {
    const list = await env.MEDIA.list({ prefix: `movies/${id}/`, cursor, limit: 1000 });
    if (list.objects.length) await env.MEDIA.delete(list.objects.map((o) => o.key));
    if (!list.truncated) break;
    cursor = list.cursor;
  }
  return { title: movie.title };
}

export async function listIngested(sql: Sql) {
  return sql.all<{
    id: string;
    tmdb_id: string | null;
    title: string;
    year: number | null;
    video_bytes: number | null;
    video_sha256: string | null;
    subtitle_status: string;
    source_path: string | null;
  }>(
    'SELECT id, tmdb_id, title, year, video_bytes, video_sha256, subtitle_status, source_path FROM movies ORDER BY title',
  );
}

// -----------------------------------------------------------------------------
// Moving people's data across from Jellyfin and the Mac's database

interface ImportPerson {
  name: string;
  isAdmin?: boolean;
  state?: {
    itemId: string;
    played?: boolean;
    favorite?: boolean;
    positionSeconds?: number;
    playCount?: number;
    lastPlayed?: string | null;
  }[];
  watchlist?: { itemId: string; addedAt: string }[];
  personal?: { itemId: string; rating: number | null; notes: string; updatedAt: string }[];
  preferences?: unknown;
  events?: { itemId: string; at: string; seconds: number; finished: boolean }[];
  collections?: {
    name: string;
    description: string;
    kind: 'manual' | 'smart';
    rules: string | null;
    visibility: 'private' | 'shared';
    position: number;
    createdAt: string;
    items: string[];
  }[];
  requests?: {
    title: string;
    year: number | null;
    note: string;
    status: 'open' | 'added' | 'declined';
    itemId: string | null;
    createdAt: string;
  }[];
}

/**
 * Creates (or finds, by name) one person as a pending invite and merges their
 * data in. Safe to run again: everything is keyed so repeats don't duplicate.
 */
export async function importPerson(sql: Sql, body: unknown) {
  const p = body as ImportPerson;
  const name = typeof p?.name === 'string' ? p.name.trim().slice(0, 40) : '';
  if (!name) throw badRequest('Each person needs a name.');
  const now = nowIso();
  let user = await sql.get<{ id: string }>(
    'SELECT id FROM users WHERE display_name = ? COLLATE NOCASE',
    name,
  );
  let created = false;
  if (!user) {
    user = { id: randomId() };
    created = true;
    await sql.run(
      `INSERT INTO users (id, display_name, is_admin, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
      user.id,
      name,
      p.isAdmin ? 1 : 0,
      now,
      now,
    );
  }
  const uid = user.id;
  const s = (q: string, ...args: unknown[]) => sql.stmt(q, ...args);
  const statements = [
    ...(p.state ?? []).map((x) =>
      s(
        `INSERT INTO user_state (user_id, item_id, played, favorite, position_seconds, play_count, last_played, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, item_id) DO UPDATE SET played = excluded.played, favorite = excluded.favorite,
           position_seconds = excluded.position_seconds, play_count = MAX(play_count, excluded.play_count),
           last_played = COALESCE(excluded.last_played, last_played), updated_at = excluded.updated_at`,
        uid,
        x.itemId,
        x.played ? 1 : 0,
        x.favorite ? 1 : 0,
        x.positionSeconds ?? 0,
        x.playCount ?? 0,
        x.lastPlayed ?? null,
        now,
      ),
    ),
    ...(p.watchlist ?? []).map((x) =>
      s(
        'INSERT OR IGNORE INTO watchlist (user_id, item_id, added_at) VALUES (?, ?, ?)',
        uid,
        x.itemId,
        x.addedAt,
      ),
    ),
    ...(p.personal ?? []).map((x) =>
      s(
        `INSERT INTO personal_data (user_id, item_id, rating, notes, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, item_id) DO UPDATE SET rating = excluded.rating, notes = excluded.notes, updated_at = excluded.updated_at`,
        uid,
        x.itemId,
        x.rating,
        x.notes,
        x.updatedAt,
      ),
    ),
    ...(p.preferences
      ? [
          s(
            `INSERT INTO preferences (user_id, data, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
            uid,
            JSON.stringify(p.preferences),
            now,
          ),
        ]
      : []),
  ];
  // Watch history and requests have no natural key: only import them once.
  if (
    created ||
    !(await sql.get('SELECT 1 AS x FROM watch_events WHERE user_id = ? LIMIT 1', uid))
  ) {
    for (const e of p.events ?? []) {
      statements.push(
        s(
          'INSERT INTO watch_events (user_id, item_id, watched_at, seconds, finished) VALUES (?, ?, ?, ?, ?)',
          uid,
          e.itemId,
          e.at,
          Math.round(e.seconds),
          e.finished ? 1 : 0,
        ),
      );
    }
  }
  for (const r of p.requests ?? []) {
    statements.push(
      s(
        `INSERT INTO movie_requests (id, user_id, user_name, title, year, note, status, item_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM movie_requests WHERE user_id = ? AND title = ? AND created_at = ?)`,
        randomId(),
        uid,
        name,
        r.title,
        r.year,
        r.note,
        r.status,
        r.itemId,
        r.createdAt,
        now,
        uid,
        r.title,
        r.createdAt,
      ),
    );
  }
  for (const c of p.collections ?? []) {
    const existing = await sql.get<{ id: string }>(
      'SELECT id FROM collections WHERE owner_user_id = ? AND name = ? COLLATE NOCASE',
      uid,
      c.name,
    );
    const cid = existing?.id ?? randomId();
    if (!existing) {
      statements.push(
        s(
          `INSERT INTO collections (id, owner_user_id, name, description, kind, rules, visibility, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          cid,
          uid,
          c.name,
          c.description,
          c.kind,
          c.rules,
          c.visibility,
          c.position,
          c.createdAt,
          now,
        ),
      );
    }
    c.items.forEach((itemId, i) =>
      statements.push(
        s(
          'INSERT OR IGNORE INTO collection_items (collection_id, item_id, position, added_at) VALUES (?, ?, ?, ?)',
          cid,
          itemId,
          i,
          now,
        ),
      ),
    );
  }
  // D1 batches are limited in size; send them in chunks.
  for (let i = 0; i < statements.length; i += 50) await sql.batch(statements.slice(i, i + 50));
  return { id: uid, created, rows: statements.length };
}

/** For the import: library movies the Mac's data can point at. */
export async function libraryIndex(sql: Sql): Promise<Pick<Movie, 'id' | 'title' | 'year'>[]> {
  return sql.all('SELECT id, title, year FROM movies');
}
