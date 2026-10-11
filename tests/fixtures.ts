import type { Movie } from '../src/shared/types';

let n = 0;
export function movie(overrides: Partial<Movie> & { title: string }): Movie {
  n++;
  return {
    id: overrides.id ?? `m${n}`,
    sortTitle: overrides.title.toLowerCase().replace(/^the /, ''),
    originalTitle: null,
    year: null,
    premiereDate: null,
    runtimeMinutes: null,
    genres: [],
    directors: [],
    studios: [],
    tags: [],
    countries: [],
    officialRating: null,
    communityRating: null,
    criticRating: null,
    overview: null,
    tagline: null,
    dateAdded: null,
    images: { poster: null, backdrop: null, logo: null },
    available: true,
    ...overrides,
    user: {
      played: false,
      favorite: false,
      positionSeconds: 0,
      progress: 0,
      playCount: 0,
      lastPlayed: null,
      ...overrides.user,
    },
  };
}
