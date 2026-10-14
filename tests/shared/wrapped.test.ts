import { describe, expect, it } from 'vitest';
import { buildWrapped, type WatchEvent } from '../../src/shared/wrapped';
import { movie } from '../fixtures';

const films = [
  movie({
    id: 'a',
    title: 'Seven Samurai',
    year: 1954,
    runtimeMinutes: 207,
    genres: ['Action', 'Drama'],
    directors: ['Akira Kurosawa'],
    actors: ['Toshiro Mifune'],
  }),
  movie({
    id: 'b',
    title: 'Yojimbo',
    year: 1961,
    runtimeMinutes: 110,
    genres: ['Action'],
    directors: ['Akira Kurosawa'],
    actors: ['Toshiro Mifune'],
  }),
  movie({
    id: 'c',
    title: 'Heat',
    year: 1995,
    runtimeMinutes: 170,
    genres: ['Crime'],
    directors: ['Michael Mann'],
  }),
  // Watched in Jellyfin's own app: only its last-played date is known.
  movie({
    id: 'd',
    title: 'Charade',
    year: 1963,
    runtimeMinutes: 113,
    genres: ['Mystery'],
    directors: ['Stanley Donen'],
    user: { played: true, lastPlayed: '2026-03-03T20:00:00Z', playCount: 3 } as never,
  }),
];
const events: WatchEvent[] = [
  { itemId: 'a', at: '2026-01-10T20:00:00Z', seconds: 207 * 60, finished: true },
  { itemId: 'b', at: '2026-01-20T20:00:00Z', seconds: 110 * 60, finished: true },
  { itemId: 'a', at: '2026-06-01T20:00:00Z', seconds: 3600, finished: false },
  { itemId: 'c', at: '2025-12-24T20:00:00Z', seconds: 170 * 60, finished: true },
  { itemId: 'gone', at: '2026-02-01T20:00:00Z', seconds: 600, finished: false },
];

describe('Wheelhouse Wrapped', () => {
  it('sums up a year from Wheelhouse history plus last-played dates', () => {
    const w = buildWrapped(films, events, 2026);
    expect(w.years).toEqual([2026, 2025]);
    expect(w.moviesWatched).toBe(3); // Seven Samurai, Yojimbo, Charade
    expect(w.hoursWatched).toBeCloseTo((207 * 60 + 110 * 60 + 3600 + 113 * 60) / 3600, 1);
    expect(w.byMonth.slice(0, 6)).toEqual([2, 0, 1, 0, 0, 1]);
    expect(w.topGenres[0]).toEqual({ name: 'Action', count: 2 });
    expect(w.topDirectors[0]).toEqual({ name: 'Akira Kurosawa', count: 2 });
    expect(w.topActors[0]).toEqual({ name: 'Toshiro Mifune', count: 2 });
    expect(w.longest?.id).toBe('a');
    expect(w.mostRewatched).toMatchObject({ movie: { id: 'd' }, plays: 3 });
    expect(w.first?.id).toBe('a');
    expect(w.latest?.id).toBe('a');
    expect(w.movies.map((m) => m.id)).toEqual(['a', 'd', 'b']);
    expect(w.approximate).toBe(true);
  });

  it('covers all time, and is empty for a quiet year', () => {
    expect(buildWrapped(films, events, null).moviesWatched).toBe(4);
    const quiet = buildWrapped(films, events, 2020);
    expect(quiet.moviesWatched).toBe(0);
    expect(quiet.hoursWatched).toBe(0);
    expect(quiet.longest).toBeNull();
  });
});
