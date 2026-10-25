import { randomUUID } from 'node:crypto';
import type {
  RipCandidate,
  RipDiscTitle,
  RipEpisode,
  RipJob,
  RipKind,
  RipStatus,
} from '../../shared/types.js';
import { nowIso, type Db } from '../db.js';

interface Row {
  id: string;
  status: RipStatus | 'dismissed';
  kind: RipKind;
  season: number | null;
  episodes: string | null;
  disc_label: string;
  disc_name: string;
  mount_path: string;
  drive_index: number | null;
  progress: number | null;
  message: string | null;
  guess: string | null;
  title: string | null;
  year: number | null;
  tmdb_id: string | null;
  imdb_id: string | null;
  candidates: string | null;
  disc_titles: string | null;
  title_index: number | null;
  source_seconds: number | null;
  movie_path: string | null;
  movie_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** Full job record used by the ripper (the API exposes a subset as RipJob). */
export interface JobRecord {
  id: string;
  status: RipStatus | 'dismissed';
  kind: RipKind;
  /** TV discs: the season and the episodes to rip. */
  season: number | null;
  episodes: RipEpisode[];
  discLabel: string;
  discName: string;
  mountPath: string;
  driveIndex: number | null;
  progress: number | null;
  message: string | null;
  guess: string | null;
  title: string | null;
  year: number | null;
  tmdbId: string | null;
  imdbId: string | null;
  candidates: RipCandidate[];
  discTitles: RipDiscTitle[];
  titleIndex: number | null;
  sourceSeconds: number | null;
  moviePath: string | null;
  movieId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const COLUMNS: Record<keyof Omit<JobRecord, 'id' | 'createdAt' | 'updatedAt'>, string> = {
  status: 'status',
  kind: 'kind',
  season: 'season',
  episodes: 'episodes',
  discLabel: 'disc_label',
  discName: 'disc_name',
  mountPath: 'mount_path',
  driveIndex: 'drive_index',
  progress: 'progress',
  message: 'message',
  guess: 'guess',
  title: 'title',
  year: 'year',
  tmdbId: 'tmdb_id',
  imdbId: 'imdb_id',
  candidates: 'candidates',
  discTitles: 'disc_titles',
  titleIndex: 'title_index',
  sourceSeconds: 'source_seconds',
  moviePath: 'movie_path',
  movieId: 'movie_id',
  finishedAt: 'finished_at',
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function fromRow(row: Row): JobRecord {
  return {
    id: row.id,
    status: row.status,
    kind: row.kind === 'tv' ? 'tv' : 'movie',
    season: row.season,
    episodes: parseJson(row.episodes, []),
    discLabel: row.disc_label,
    discName: row.disc_name,
    mountPath: row.mount_path,
    driveIndex: row.drive_index,
    progress: row.progress,
    message: row.message,
    guess: row.guess,
    title: row.title,
    year: row.year,
    tmdbId: row.tmdb_id,
    imdbId: row.imdb_id,
    candidates: parseJson(row.candidates, []),
    discTitles: parseJson(row.disc_titles, []),
    titleIndex: row.title_index,
    sourceSeconds: row.source_seconds,
    moviePath: row.movie_path,
    movieId: row.movie_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export function toPublicJob(job: JobRecord): RipJob {
  return {
    id: job.id,
    status: job.status === 'dismissed' ? 'done' : job.status,
    kind: job.kind,
    discLabel: job.discLabel,
    progress: job.progress,
    message: job.message,
    guess: job.guess,
    title: job.title,
    year: job.year,
    candidates: job.candidates,
    discTitles: job.discTitles,
    moviePath: job.moviePath,
    movieId: job.movieId,
    season: job.season,
    episodes: job.episodes,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  };
}

export const ACTIVE_STATUSES: RipStatus[] = [
  'scanning',
  'needs_choice',
  'needs_episodes',
  'ripping',
  'ripped',
  'encoding',
  'needs_name',
  'filing',
  'importing',
];

export class RipJobStore {
  constructor(private readonly db: Db) {}

  create(input: { discLabel: string; discName?: string; mountPath: string }): JobRecord {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO rip_jobs (id, status, disc_label, disc_name, mount_path, created_at, updated_at)
         VALUES (?, 'scanning', ?, ?, ?, ?, ?)`,
      )
      .run(id, input.discLabel, input.discName ?? '', input.mountPath, now, now);
    return this.get(id)!;
  }

  get(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM rip_jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  update(id: string, patch: Partial<Omit<JobRecord, 'id' | 'createdAt' | 'updatedAt'>>): JobRecord {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = COLUMNS[key as keyof typeof COLUMNS];
      if (!column) continue;
      sets.push(`${column} = ?`);
      values.push(
        Array.isArray(value)
          ? JSON.stringify(value)
          : ((value as string | number | null | undefined) ?? null),
      );
    }
    sets.push('updated_at = ?');
    values.push(nowIso());
    this.db.prepare(`UPDATE rip_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.get(id)!;
  }

  /** Jobs to show: everything not dismissed, newest first. */
  list(limit = 50): JobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM rip_jobs WHERE status != 'dismissed' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as Row[];
    return rows.map(fromRow);
  }

  withStatus(...statuses: RipStatus[]): JobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM rip_jobs WHERE status IN (${statuses.map(() => '?').join(',')})
         ORDER BY created_at ASC`,
      )
      .all(...statuses) as unknown as Row[];
    return rows.map(fromRow);
  }

  /**
   * The highest episode number already ripped for a season of a show, so the
   * next disc of the set carries on numbering where the last one stopped.
   */
  lastEpisode(show: { title: string; tmdbId: string | null }, season: number): number {
    const rows = this.db
      .prepare(
        `SELECT * FROM rip_jobs WHERE kind = 'tv' AND season = ?
           AND status NOT IN ('failed', 'needs_episodes')
           AND (title = ? OR (tmdb_id IS NOT NULL AND tmdb_id = ?))`,
      )
      .all(season, show.title, show.tmdbId ?? '') as unknown as Row[];
    let last = 0;
    for (const row of rows) {
      // A dismissed job only counts for the episodes it actually filed.
      const counts = (ep: RipEpisode) => row.status !== 'dismissed' || ep.state === 'filed';
      for (const ep of parseJson<RipEpisode[]>(row.episodes, [])) {
        if (counts(ep)) last = Math.max(last, ep.episode);
      }
    }
    return last;
  }

  /** A recent job for the same disc that did not fail (to avoid ripping a disc twice). */
  /**
   * The last disc with this label was ripped as a movie and then marked "It's a TV disc"
   * (so this time it's ripped as episodes).
   */
  markedTv(label: string, exceptId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT kind, status FROM rip_jobs WHERE disc_label = ? AND id != ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(label, exceptId) as { kind: string; status: string } | undefined;
    return row?.kind === 'tv' && row.status === 'dismissed';
  }

  recentForLabel(label: string, sinceMs: number): JobRecord | null {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT * FROM rip_jobs WHERE disc_label = ? AND created_at >= ?
           AND status NOT IN ('failed', 'dismissed')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(label, since) as Row | undefined;
    return row ? fromRow(row) : null;
  }
}
