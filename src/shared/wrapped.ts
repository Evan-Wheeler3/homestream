import type { Movie } from './types.js';

/** One viewing recorded by Wheelhouse's player. */
export interface WatchEvent {
  itemId: string;
  at: string;
  seconds: number;
  finished: boolean;
}

export interface Ranked {
  name: string;
  count: number;
}

export interface Wrapped {
  /** null = all time */
  year: number | null;
  /** Years with any watching, newest first. */
  years: number[];
  moviesWatched: number;
  hoursWatched: number;
  /** Viewings per month (January first); all zeros for "all time". */
  byMonth: number[];
  topGenres: Ranked[];
  topDirectors: Ranked[];
  topActors: Ranked[];
  topDecade: Ranked | null;
  longest: Movie | null;
  mostRewatched: { movie: Movie; plays: number } | null;
  first: Movie | null;
  latest: Movie | null;
  /** Everything watched, most recent first. */
  movies: Movie[];
  /** True when some of it comes from Jellyfin's "last played" dates rather than Wheelhouse's own history. */
  approximate: boolean;
}

interface Viewing {
  movie: Movie;
  at: string;
  seconds: number;
}

function rank(counts: Map<string, number>, limit = 5): Ranked[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

const yearOf = (iso: string) => Number(iso.slice(0, 4));

/**
 * A year in review. Wheelhouse's own history (each play through its player)
 * is used where it exists; movies watched elsewhere (Jellyfin's apps, or
 * before Wheelhouse recorded history) count once, at their last-played date.
 */
export function buildWrapped(movies: Movie[], events: WatchEvent[], year: number | null): Wrapped {
  const byId = new Map(movies.map((m) => [m.id, m]));
  const viewings: Viewing[] = [];
  const withHistory = new Set<string>();
  for (const e of events) {
    const movie = byId.get(e.itemId);
    if (!movie) continue;
    withHistory.add(movie.id);
    viewings.push({ movie, at: e.at, seconds: e.seconds });
  }
  let approximate = false;
  for (const m of movies) {
    if (withHistory.has(m.id) || !m.user.played || !m.user.lastPlayed) continue;
    approximate = true;
    viewings.push({ movie: m, at: m.user.lastPlayed, seconds: (m.runtimeMinutes ?? 0) * 60 });
  }

  const years = [...new Set(viewings.map((v) => yearOf(v.at)))]
    .filter((y) => y > 1900)
    .sort((a, b) => b - a);
  const inRange = viewings
    .filter((v) => year == null || yearOf(v.at) === year)
    .sort((a, b) => a.at.localeCompare(b.at));

  const watched = new Map<string, { movie: Movie; plays: number; latest: string }>();
  const byMonth = Array.from({ length: 12 }, () => 0);
  let seconds = 0;
  for (const v of inRange) {
    seconds += v.seconds;
    if (year != null) byMonth[Number(v.at.slice(5, 7)) - 1]!++;
    const entry = watched.get(v.movie.id) ?? { movie: v.movie, plays: 0, latest: v.at };
    entry.plays++;
    entry.latest = v.at;
    watched.set(v.movie.id, entry);
  }

  const genres = new Map<string, number>();
  const directors = new Map<string, number>();
  const actors = new Map<string, number>();
  const decades = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const { movie } of watched.values()) {
    movie.genres.forEach((g) => bump(genres, g));
    movie.directors.forEach((d) => bump(directors, d));
    movie.actors.slice(0, 5).forEach((a) => bump(actors, a));
    if (movie.year) bump(decades, `${Math.floor(movie.year / 10) * 10}s`);
  }

  const list = [...watched.values()];
  const longest = list
    .map((w) => w.movie)
    .filter((m) => m.runtimeMinutes)
    .sort((a, b) => b.runtimeMinutes! - a.runtimeMinutes!)[0];
  // Plays in this period, or Jellyfin's all-time play count when that is higher.
  const rewatched = list
    .map((w) => ({ movie: w.movie, plays: Math.max(w.plays, w.movie.user.playCount) }))
    .filter((w) => w.plays > 1)
    .sort((a, b) => b.plays - a.plays || a.movie.title.localeCompare(b.movie.title))[0];

  return {
    year,
    years,
    moviesWatched: watched.size,
    hoursWatched: Math.round((seconds / 3600) * 10) / 10,
    byMonth,
    topGenres: rank(genres),
    topDirectors: rank(directors).filter((d) => d.count > 1 || directors.size <= 3),
    topActors: rank(actors).filter((a) => a.count > 1),
    topDecade: rank(decades, 1)[0] ?? null,
    longest: longest ?? null,
    mostRewatched: rewatched ?? null,
    first: inRange[0]?.movie ?? null,
    latest: inRange.at(-1)?.movie ?? null,
    movies: list.sort((a, b) => b.latest.localeCompare(a.latest)).map((w) => w.movie),
    approximate,
  };
}
