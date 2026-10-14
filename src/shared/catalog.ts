import type { Facets, FacetValue, Movie, MovieQuery, Page, SortDir, SortField } from './types.js';

/** Lowercase, strip diacritics and punctuation so "Amélie" matches "amelie". */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sort key that ignores leading articles ("The Kid" sorts under K). */
export function sortKey(title: string): string {
  return normalizeText(title).replace(/^(the|a|an) /, '');
}

function anyOf(haystack: string[], wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  return haystack.some((value) => wanted.includes(value));
}

/** Search score; 0 means no match. Title matches outrank director matches. */
export function searchScore(movie: Movie, q: string): number {
  const needle = normalizeText(q);
  if (!needle) return 1;
  const title = normalizeText(movie.title);
  const original = movie.originalTitle ? normalizeText(movie.originalTitle) : '';
  if (title === needle) return 100;
  if (title.startsWith(needle) || sortKey(movie.title).startsWith(needle)) return 80;
  if (title.split(' ').some((word) => word.startsWith(needle))) return 60;
  if (title.includes(needle)) return 50;
  if (original && original.includes(needle)) return 40;
  if (movie.directors.some((d) => normalizeText(d).includes(needle))) return 20;
  return 0;
}

export function matchesQuery(movie: Movie, query: MovieQuery): boolean {
  if (query.q && searchScore(movie, query.q) === 0) return false;
  if (!anyOf(movie.genres, query.genres)) return false;
  if (!anyOf(movie.directors, query.directors)) return false;
  if (!anyOf(movie.countries, query.countries)) return false;
  if (!anyOf(movie.tags, query.tags)) return false;
  if (!anyOf(movie.studios, query.studios)) return false;
  if (query.ratings?.length && !query.ratings.includes(movie.officialRating ?? 'Unrated')) {
    return false;
  }
  if (query.yearMin != null && (movie.year == null || movie.year < query.yearMin)) return false;
  if (query.yearMax != null && (movie.year == null || movie.year > query.yearMax)) return false;
  if (
    query.runtimeMin != null &&
    (movie.runtimeMinutes == null || movie.runtimeMinutes < query.runtimeMin)
  ) {
    return false;
  }
  if (
    query.runtimeMax != null &&
    (movie.runtimeMinutes == null || movie.runtimeMinutes > query.runtimeMax)
  ) {
    return false;
  }
  if (query.favorite && !movie.user.favorite) return false;
  if (query.watched === 'watched' && !movie.user.played) return false;
  if (query.watched === 'unwatched' && movie.user.played) return false;
  if (query.watched === 'inProgress' && !(movie.user.positionSeconds > 0 && !movie.user.played)) {
    return false;
  }
  return true;
}

/** Missing values always sort last, regardless of direction. */
function compareNullable(a: number | null, b: number | null, dir: SortDir): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === 'asc' ? a - b : b - a;
}

export function compareMovies(a: Movie, b: Movie, sort: SortField, dir: SortDir): number {
  let result = 0;
  switch (sort) {
    case 'year':
      result = compareNullable(a.year, b.year, dir);
      break;
    case 'runtime':
      result = compareNullable(a.runtimeMinutes, b.runtimeMinutes, dir);
      break;
    case 'rating':
      result = compareNullable(a.communityRating, b.communityRating, dir);
      break;
    case 'dateAdded':
      result = compareNullable(
        a.dateAdded ? Date.parse(a.dateAdded) : null,
        b.dateAdded ? Date.parse(b.dateAdded) : null,
        dir,
      );
      break;
    case 'title':
    case 'random':
      break;
  }
  if (result !== 0) return result;
  const byTitle = a.sortTitle.localeCompare(b.sortTitle);
  if (sort === 'title' && dir === 'desc') return -byTitle;
  return byTitle || a.id.localeCompare(b.id);
}

export const DEFAULT_PAGE_SIZE = 60;
export const MAX_PAGE_SIZE = 200;

export function queryMovies(movies: Movie[], query: MovieQuery): Page<Movie> {
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, query.limit ?? DEFAULT_PAGE_SIZE));
  let results = movies.filter((movie) => matchesQuery(movie, query));

  if (query.q && !query.sort) {
    // Relevance ordering when searching without an explicit sort.
    const q = query.q;
    results = results
      .map((movie) => ({ movie, score: searchScore(movie, q) }))
      .sort((a, b) => b.score - a.score || a.movie.sortTitle.localeCompare(b.movie.sortTitle))
      .map((entry) => entry.movie);
  } else {
    const sort = query.sort ?? 'title';
    const dir = query.dir ?? (sort === 'title' ? 'asc' : 'desc');
    results = [...results].sort((a, b) => compareMovies(a, b, sort, dir));
  }

  return { items: results.slice(offset, offset + limit), total: results.length, offset, limit };
}

function countValues(values: Iterable<string>): FacetValue[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

export function buildFacets(movies: Movie[]): Facets {
  const years = movies.map((m) => m.year).filter((y): y is number => y != null);
  const runtimes = movies.map((m) => m.runtimeMinutes).filter((r): r is number => r != null);
  return {
    genres: countValues(movies.flatMap((m) => m.genres)),
    directors: countValues(movies.flatMap((m) => m.directors)),
    countries: countValues(movies.flatMap((m) => m.countries)),
    tags: countValues(movies.flatMap((m) => m.tags)),
    studios: countValues(movies.flatMap((m) => m.studios)),
    ratings: countValues(movies.map((m) => m.officialRating ?? 'Unrated')),
    decades: countValues(years.map((y) => String(decadeOf(y)))).sort(
      (a, b) => Number(a.value) - Number(b.value),
    ),
    yearRange: years.length ? [Math.min(...years), Math.max(...years)] : null,
    runtimeRange: runtimes.length ? [Math.min(...runtimes), Math.max(...runtimes)] : null,
  };
}

/** Deterministic PRNG so "random" picks can be stable for a seed (e.g. the date). */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rand: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}
