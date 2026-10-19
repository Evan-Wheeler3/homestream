// Ratings from OMDb (omdbapi.com): the IMDb rating as the "community" score and
// Rotten Tomatoes as the critics score. TMDB's own score stays as the fallback.
import type { Sql } from './db.js';
import { nowIso } from './db.js';
import type { CloudEnv } from './env.js';
import type { StoredSummary } from './catalog.js';

export interface OmdbRatings {
  imdb: number | null;
  rottenTomatoes: number | null;
}

/** Ratings are checked again after this long. */
const REFRESH_DAYS = 30;
/**
 * Movies checked per run. Each one is a request to OMDb; the free plan allows
 * 1,000 a day, and a Worker on the free plan may make 50 requests per run.
 */
export const RATINGS_BATCH = 40;

/** Reads OMDb's answer for one movie ("8.3", "92%", or "N/A"). */
export function parseOmdb(body: unknown): OmdbRatings | null {
  const b = body as {
    Response?: string;
    imdbRating?: string;
    Ratings?: { Source?: string; Value?: string }[];
  };
  if (!b || b.Response === 'False') return null;
  const imdb = Number(b.imdbRating);
  const rt = b.Ratings?.find((r) => r.Source === 'Rotten Tomatoes')?.Value;
  const rtNumber = rt ? Number(rt.replace('%', '')) : NaN;
  return {
    imdb: Number.isFinite(imdb) && imdb > 0 ? Math.round(imdb * 10) / 10 : null,
    rottenTomatoes: Number.isFinite(rtNumber) ? Math.round(rtNumber) : null,
  };
}

export async function fetchOmdb(
  imdbId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OmdbRatings | null> {
  const url = `https://www.omdbapi.com/?${new URLSearchParams({ i: imdbId, apikey: apiKey })}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 401)
    throw new Error('OMDb rejected the API key (or today’s limit is used up).');
  if (!res.ok) throw new Error(`OMDb answered ${res.status}`);
  return parseOmdb(await res.json());
}

/** Puts IMDb/Rotten Tomatoes ratings into a movie's stored summary. */
export function applyRatings(summary: StoredSummary, ratings: OmdbRatings): StoredSummary {
  return {
    ...summary,
    communityRating: ratings.imdb ?? summary.communityRating,
    ratingSource: ratings.imdb != null ? 'IMDb' : (summary.ratingSource ?? 'TMDB'),
    criticRating: ratings.rottenTomatoes ?? summary.criticRating,
  };
}

/**
 * Refreshes ratings: the given movies, or the ones checked longest ago (never
 * checked first). Returns how many were updated. Does nothing without a key.
 */
export async function refreshRatings(
  env: CloudEnv,
  sql: Sql,
  options: { ids?: string[]; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ checked: number; updated: number; remaining: number }> {
  const key = env.OMDB_API_KEY;
  if (!key) return { checked: 0, updated: 0, remaining: 0 };
  const limit = Math.min(options.limit ?? RATINGS_BATCH, RATINGS_BATCH);
  const stale = new Date(Date.now() - REFRESH_DAYS * 86_400_000).toISOString();
  const rows = options.ids?.length
    ? await sql.all<{ id: string; imdb_id: string; summary: string }>(
        `SELECT id, imdb_id, summary FROM movies WHERE imdb_id IS NOT NULL AND id IN (${options.ids
          .map(() => '?')
          .join(',')})`,
        ...options.ids,
      )
    : await sql.all<{ id: string; imdb_id: string; summary: string }>(
        `SELECT id, imdb_id, summary FROM movies
         WHERE imdb_id IS NOT NULL AND (ratings_checked_at IS NULL OR ratings_checked_at < ?)
         ORDER BY ratings_checked_at IS NOT NULL, ratings_checked_at LIMIT ?`,
        stale,
        limit,
      );
  let updated = 0;
  for (const row of rows.slice(0, limit)) {
    const ratings = await fetchOmdb(row.imdb_id, key, options.fetchImpl);
    const summary = JSON.parse(row.summary) as StoredSummary;
    const next = ratings ? applyRatings(summary, ratings) : summary;
    if (ratings) updated++;
    await sql.run(
      'UPDATE movies SET summary = ?, ratings_checked_at = ? WHERE id = ?',
      JSON.stringify(next),
      nowIso(),
      row.id,
    );
  }
  const left = await sql.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM movies
     WHERE imdb_id IS NOT NULL AND (ratings_checked_at IS NULL OR ratings_checked_at < ?)`,
    stale,
  );
  return { checked: Math.min(rows.length, limit), updated, remaining: left?.n ?? 0 };
}
