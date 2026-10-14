import { describe, expect, it } from 'vitest';
import {
  buildFacets,
  normalizeText,
  lastWatched,
  personFilmography,
  queryMovies,
  recommendLike,
  searchPeople,
  searchScore,
  sortKey,
} from '../../src/shared/catalog';
import { movie } from '../fixtures';

const library = [
  movie({
    id: 'a',
    title: 'The General',
    year: 1926,
    runtimeMinutes: 78,
    genres: ['Comedy', 'War'],
    directors: ['Buster Keaton'],
    dateAdded: '2026-01-05T00:00:00Z',
  }),
  movie({
    id: 'b',
    title: 'Amélie',
    year: 2001,
    runtimeMinutes: 122,
    genres: ['Comedy', 'Romance'],
    countries: ['France'],
    dateAdded: '2026-03-01T00:00:00Z',
  }),
  movie({
    id: 'c',
    title: 'Seven Samurai',
    year: 1954,
    runtimeMinutes: 207,
    genres: ['Action'],
    directors: ['Akira Kurosawa'],
    countries: ['Japan'],
    user: { played: true } as never,
  }),
  movie({
    id: 'd',
    title: 'Rashomon',
    year: 1950,
    runtimeMinutes: 88,
    genres: ['Drama'],
    directors: ['Akira Kurosawa'],
    countries: ['Japan'],
    user: { positionSeconds: 600, favorite: true } as never,
  }),
  movie({ id: 'e', title: 'Untitled Home Video' }),
];

describe('text helpers', () => {
  it('normalises accents and punctuation', () => {
    expect(normalizeText('Amélie!')).toBe('amelie');
    expect(normalizeText('  D.O.A.  ')).toBe('d o a');
  });
  it('ignores leading articles when sorting', () => {
    expect(sortKey('The Kid')).toBe('kid');
    expect(sortKey('A Trip to the Moon')).toBe('trip to the moon');
  });
});

describe('search', () => {
  it('matches without accents and ranks title prefixes above director matches', () => {
    expect(searchScore(library[1]!, 'amelie')).toBeGreaterThan(0);
    expect(searchScore(library[2]!, 'seven')).toBeGreaterThan(searchScore(library[2]!, 'kurosawa'));
    expect(searchScore(library[0]!, 'zzz')).toBe(0);
  });
  it('orders search results by relevance when no sort is given', () => {
    const page = queryMovies(library, { q: 'kurosawa' });
    expect(page.items.map((m) => m.id).sort()).toEqual(['c', 'd']);
    const exact = queryMovies(library, { q: 'rashomon' });
    expect(exact.items[0]!.id).toBe('d');
  });
});

describe('filters', () => {
  it('filters by genre, director, country and year range', () => {
    expect(queryMovies(library, { genres: ['Comedy'] }).total).toBe(2);
    expect(
      queryMovies(library, { directors: ['Akira Kurosawa'], yearMax: 1951 }).items.map((m) => m.id),
    ).toEqual(['d']);
    expect(queryMovies(library, { countries: ['France'] }).items[0]!.id).toBe('b');
  });
  it('treats missing years/runtimes as non-matching for range filters', () => {
    expect(
      queryMovies(library, { runtimeMax: 99 })
        .items.map((m) => m.id)
        .sort(),
    ).toEqual(['a', 'd']);
    expect(queryMovies(library, { yearMin: 1900 }).items.some((m) => m.id === 'e')).toBe(false);
  });
  it('filters by runtime ranges', () => {
    const ids = (q: Parameters<typeof queryMovies>[1]) =>
      queryMovies(library, q)
        .items.map((m) => m.id)
        .sort();
    expect(ids({ runtimeMin: 90, runtimeMax: 120 })).toEqual([]);
    expect(ids({ runtimeMin: 121 })).toEqual(['b', 'c']);
    expect(ids({ runtimeMin: 150 })).toEqual(['c']);
    expect(ids({ runtimeMin: 80, runtimeMax: 125 })).toEqual(['b', 'd']);
  });
  it('filters by watch status and favorites', () => {
    expect(queryMovies(library, { watched: 'watched' }).items.map((m) => m.id)).toEqual(['c']);
    expect(queryMovies(library, { watched: 'inProgress' }).items.map((m) => m.id)).toEqual(['d']);
    expect(queryMovies(library, { watched: 'unwatched' }).total).toBe(4);
    expect(queryMovies(library, { favorite: true }).items.map((m) => m.id)).toEqual(['d']);
  });
  it('matches unrated items via the "Unrated" rating value', () => {
    expect(queryMovies(library, { ratings: ['Unrated'] }).total).toBe(5);
  });
});

describe('sorting and paging', () => {
  it('sorts by title ignoring "The"', () => {
    expect(queryMovies(library, { sort: 'title', dir: 'asc' }).items.map((m) => m.id)).toEqual([
      'b',
      'a',
      'd',
      'c',
      'e',
    ]);
  });
  it('puts missing values last in both directions', () => {
    const asc = queryMovies(library, { sort: 'year', dir: 'asc' }).items;
    const desc = queryMovies(library, { sort: 'year', dir: 'desc' }).items;
    expect(asc.at(-1)!.id).toBe('e');
    expect(desc.at(-1)!.id).toBe('e');
    expect(desc[0]!.id).toBe('b');
  });
  it('sorts by runtime and date added', () => {
    expect(queryMovies(library, { sort: 'runtime', dir: 'desc' }).items[0]!.id).toBe('c');
    expect(queryMovies(library, { sort: 'dateAdded', dir: 'desc' }).items[0]!.id).toBe('b');
  });
  it('paginates with offset/limit and reports totals', () => {
    const page = queryMovies(library, { sort: 'title', offset: 2, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.items[0]!.id).toBe('d');
  });
});

describe('facets', () => {
  it('counts values and derives decades and ranges', () => {
    const facets = buildFacets(library);
    expect(facets.genres[0]).toEqual({ value: 'Comedy', count: 2 });
    expect(facets.directors.find((d) => d.value === 'Akira Kurosawa')?.count).toBe(2);
    expect(facets.decades.map((d) => d.value)).toEqual(['1920', '1950', '2000']);
    expect(facets.yearRange).toEqual([1926, 2001]);
    expect(facets.runtimeRange).toEqual([78, 207]);
  });
  it('handles an empty library', () => {
    const facets = buildFacets([]);
    expect(facets.yearRange).toBeNull();
    expect(facets.genres).toEqual([]);
  });
});

describe('people', () => {
  const films = [
    movie({
      id: 'g',
      title: 'The General',
      year: 1926,
      directors: ['Buster Keaton'],
      actors: ['Buster Keaton', 'Marion Mack'],
    }),
    movie({
      id: 's',
      title: 'Sherlock Jr.',
      year: 1924,
      directors: ['Buster Keaton'],
      actors: ['Buster Keaton'],
    }),
    movie({
      id: 'l',
      title: 'Limelight',
      year: 1952,
      directors: ['Charlie Chaplin'],
      actors: ['Charlie Chaplin', 'Buster Keaton'],
    }),
    movie({
      id: 'm',
      title: 'Metropolis',
      year: 1927,
      directors: ['Fritz Lang'],
      actors: ['Brigitte Helm'],
    }),
  ];

  it('finds people by any part of their name, busiest first', () => {
    expect(searchPeople(films, 'keat')).toEqual([
      { name: 'Buster Keaton', directed: 2, actedIn: 3 },
    ]);
    expect(searchPeople(films, 'b').map((p) => p.name)).toEqual(['Buster Keaton', 'Brigitte Helm']);
    expect(searchPeople(films, '')).toEqual([]);
  });

  it('lists what a person directed and acted in, newest first, ignoring case and accents', () => {
    const page = personFilmography(films, 'buster keaton');
    expect(page.name).toBe('Buster Keaton');
    expect(page.directed.map((m) => m.id)).toEqual(['g', 's']);
    expect(page.actedIn.map((m) => m.id)).toEqual(['l', 'g', 's']);
    expect(personFilmography(films, 'Nobody').directed).toEqual([]);
  });

  it('filters the library by actor', () => {
    expect(queryMovies(films, { actors: ['Buster Keaton'] }).total).toBe(3);
  });
});

describe('recommendations', () => {
  const seen = movie({
    id: 'seen',
    title: 'Seven Samurai',
    year: 1954,
    genres: ['Action', 'Drama'],
    directors: ['Akira Kurosawa'],
    actors: ['Toshiro Mifune'],
    countries: ['Japan'],
    user: { played: true, lastPlayed: '2026-10-01T20:00:00Z' } as never,
  });
  const films = [
    seen,
    movie({
      id: 'yojimbo',
      title: 'Yojimbo',
      year: 1961,
      genres: ['Action'],
      directors: ['Akira Kurosawa'],
      actors: ['Toshiro Mifune'],
      countries: ['Japan'],
    }),
    movie({
      id: 'rashomon',
      title: 'Rashomon',
      year: 1950,
      genres: ['Drama'],
      directors: ['Akira Kurosawa'],
      countries: ['Japan'],
    }),
    movie({ id: 'heat', title: 'Heat', year: 1995, genres: ['Action', 'Crime'] }),
    movie({ id: 'kid', title: 'The Kid', year: 1921, genres: ['Comedy'] }),
    movie({
      id: 'watched',
      title: 'Ikiru',
      year: 1952,
      directors: ['Akira Kurosawa'],
      user: { played: true } as never,
    }),
    movie({
      id: 'older',
      title: 'Charade',
      year: 1963,
      user: { positionSeconds: 60, lastPlayed: '2026-09-01T20:00:00Z' } as never,
    }),
  ];

  it('bases "Because you watched" on the most recent watch', () => {
    expect(lastWatched(films)?.id).toBe('seen');
    expect(lastWatched([films[3]!])).toBeNull();
  });

  it('ranks unwatched films by shared director, cast, genre and era', () => {
    const ids = recommendLike(films, seen).map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(['yojimbo', 'rashomon']);
    expect(ids).toContain('heat'); // shares a genre
    expect(ids).not.toContain('kid'); // nothing in common
    expect(ids).not.toContain('watched'); // already seen
    expect(ids).not.toContain('seen');
  });
});
