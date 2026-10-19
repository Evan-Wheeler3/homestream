// The movie library as stored in D1, turned into the shared `Movie` shape with
// each person's own watch state.
import type { Movie, MovieDetail, MovieUserState } from '../shared/types.js';
import { nowIso, type Sql } from './db.js';

/** A subtitle file in R2. */
export interface StoredSubtitle {
  /** ISO 639-2, e.g. "eng". */
  language: string;
  label: string;
  key: string;
  source: 'disc' | 'opensubtitles';
  /** OpenSubtitles file id, when downloaded from there. */
  fileId?: number | null;
  release?: string | null;
}

export interface MovieRow {
  id: string;
  tmdb_id: string | null;
  imdb_id: string | null;
  title: string;
  year: number | null;
  summary: string;
  detail: string;
  video_key: string | null;
  video_bytes: number | null;
  video_sha256: string | null;
  duration_seconds: number | null;
  subtitles: string;
  subtitle_status: 'disc' | 'downloaded' | 'none';
  source_path: string | null;
  date_added: string;
  updated_at: string;
}

/** Everything in MovieDetail that isn't in Movie and isn't per-person. */
export type StoredDetail = Pick<
  MovieDetail,
  'cast' | 'trailers' | 'writers' | 'producers' | 'mediaInfo' | 'externalLinks'
>;

export type StoredSummary = Omit<Movie, 'user' | 'available'>;

interface StateRow {
  item_id: string;
  played: number;
  favorite: number;
  position_seconds: number;
  play_count: number;
  last_played: string | null;
}

export const EMPTY_STATE: MovieUserState = {
  played: false,
  favorite: false,
  positionSeconds: 0,
  progress: 0,
  playCount: 0,
  lastPlayed: null,
};

export function toUserState(
  row: Omit<StateRow, 'item_id'> | null | undefined,
  runtimeMinutes: number | null,
): MovieUserState {
  if (!row) return { ...EMPTY_STATE };
  const runtime = (runtimeMinutes ?? 0) * 60;
  return {
    played: row.played === 1,
    favorite: row.favorite === 1,
    positionSeconds: row.position_seconds,
    progress: runtime > 0 ? Math.min(1, row.position_seconds / runtime) : 0,
    playCount: row.play_count,
    lastPlayed: row.last_played,
  };
}

export function rowToMovie(row: MovieRow, state: Omit<StateRow, 'item_id'> | null): Movie {
  const summary = JSON.parse(row.summary) as StoredSummary;
  return {
    ...summary,
    id: row.id,
    user: toUserState(state, summary.runtimeMinutes),
    available: Boolean(row.video_key),
  };
}

export interface Snapshot {
  movies: Movie[];
  byId: Map<string, Movie>;
}

/** The whole library with this person's state. Loaded once per request. */
export async function loadSnapshot(sql: Sql, userId: string): Promise<Snapshot> {
  const rows = await sql.all<MovieRow & Partial<StateRow>>(
    `SELECT m.id, m.summary, m.video_key, s.played, s.favorite, s.position_seconds, s.play_count, s.last_played
     FROM movies m LEFT JOIN user_state s ON s.item_id = m.id AND s.user_id = ?`,
    userId,
  );
  const movies = rows.map((r) =>
    rowToMovie(
      r,
      r.played == null
        ? null
        : {
            played: r.played,
            favorite: r.favorite ?? 0,
            position_seconds: r.position_seconds ?? 0,
            play_count: r.play_count ?? 0,
            last_played: r.last_played ?? null,
          },
    ),
  );
  return { movies, byId: new Map(movies.map((m) => [m.id, m])) };
}

export async function getUserState(
  sql: Sql,
  userId: string,
  itemId: string,
  runtimeMinutes: number | null,
): Promise<MovieUserState> {
  const row = await sql.get<StateRow>(
    'SELECT * FROM user_state WHERE user_id = ? AND item_id = ?',
    userId,
    itemId,
  );
  return toUserState(row, runtimeMinutes);
}

/** Updates some of a person's state for an item (creating the row when needed). */
export async function patchUserState(
  sql: Sql,
  userId: string,
  itemId: string,
  patch: Partial<{
    played: boolean;
    favorite: boolean;
    positionSeconds: number;
    lastPlayed: string;
    addPlay: boolean;
  }>,
) {
  const now = nowIso();
  await sql.run(
    `INSERT INTO user_state (user_id, item_id, played, favorite, position_seconds, play_count, last_played, updated_at)
     VALUES (?1, ?2, COALESCE(?3, 0), COALESCE(?4, 0), COALESCE(?5, 0), ?6, ?7, ?8)
     ON CONFLICT(user_id, item_id) DO UPDATE SET
       played = COALESCE(?3, played),
       favorite = COALESCE(?4, favorite),
       position_seconds = COALESCE(?5, position_seconds),
       play_count = play_count + ?6,
       last_played = COALESCE(?7, last_played),
       updated_at = ?8`,
    userId,
    itemId,
    patch.played === undefined ? null : patch.played ? 1 : 0,
    patch.favorite === undefined ? null : patch.favorite ? 1 : 0,
    patch.positionSeconds ?? null,
    patch.addPlay ? 1 : 0,
    patch.lastPlayed ?? null,
    now,
  );
}

export async function movieRow(sql: Sql, id: string): Promise<MovieRow | null> {
  return sql.get<MovieRow>('SELECT * FROM movies WHERE id = ?', id);
}

// -----------------------------------------------------------------------------
// Where things live in R2

export const mediaKeys = {
  video: (id: string) => `movies/${id}/video.mp4`,
  image: (id: string, kind: 'poster' | 'backdrop' | 'logo', ext: string) =>
    `movies/${id}/${kind}.${ext}`,
  subtitle: (id: string, language: string, source: StoredSubtitle['source']) =>
    `movies/${id}/subtitles.${language}.${source}.vtt`,
  person: (file: string) => `people/${file}`,
};

/** The app's URL for something in R2 (all media goes through the signed-in Worker). */
export const mediaUrl = (key: string, version?: string | null) =>
  `/api/media/${key.split('/').map(encodeURIComponent).join('/')}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
