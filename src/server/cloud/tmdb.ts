// Movie information and artwork from TMDB, now that Jellyfin isn't doing it.
import { toTrailer } from '../../shared/trailers.js';
import type { Trailer } from '../../shared/types.js';

const API = 'https://api.themoviedb.org/3';
export const TMDB_IMAGES = 'https://image.tmdb.org/t/p';

export interface TmdbMovie {
  id: number;
  imdbId: string | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  releaseDate: string | null;
  runtime: number | null;
  genres: string[];
  overview: string | null;
  tagline: string | null;
  voteAverage: number | null;
  certification: string | null;
  countries: string[];
  studios: string[];
  keywords: string[];
  directors: string[];
  writers: string[];
  producers: string[];
  cast: { id: number; name: string; character: string | null; profilePath: string | null }[];
  trailers: Trailer[];
  posterPath: string | null;
  backdropPath: string | null;
  logoPath: string | null;
  collection: {
    id: number;
    name: string;
    posterPath: string | null;
    backdropPath: string | null;
  } | null;
}

export interface TmdbSearchResult {
  id: number;
  title: string;
  year: number | null;
  overview: string;
  popularity: number;
}

interface RawMovie {
  id: number;
  imdb_id?: string | null;
  title: string;
  original_title?: string;
  release_date?: string;
  runtime?: number | null;
  genres?: { name: string }[];
  overview?: string;
  tagline?: string;
  vote_average?: number;
  production_countries?: { name: string }[];
  production_companies?: { name: string }[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  belongs_to_collection?: {
    id: number;
    name: string;
    poster_path: string | null;
    backdrop_path: string | null;
  } | null;
  credits?: {
    cast?: {
      id: number;
      name: string;
      character?: string;
      profile_path?: string | null;
      order?: number;
    }[];
    crew?: { name: string; job: string; department: string }[];
  };
  images?: {
    logos?: { file_path: string; iso_639_1: string | null; vote_average: number }[];
    posters?: { file_path: string; iso_639_1: string | null; vote_average: number }[];
  };
  videos?: {
    results?: {
      site: string;
      key: string;
      type: string;
      name: string;
      official?: boolean;
      iso_639_1?: string;
    }[];
  };
  release_dates?: {
    results?: { iso_3166_1: string; release_dates: { certification: string; type: number }[] }[];
  };
  keywords?: { keywords?: { name: string }[] };
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

export class Tmdb {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(`${API}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      });
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`TMDB ${path.split('?')[0]} failed (${res.status})`);
      return res.json() as Promise<T>;
    }
  }

  async search(title: string, year: number | null): Promise<TmdbSearchResult[]> {
    const params = new URLSearchParams({ query: title, include_adult: 'false' });
    if (year) params.set('year', String(year));
    const body = await this.get<{
      results: {
        id: number;
        title: string;
        release_date?: string;
        overview?: string;
        popularity?: number;
      }[];
    }>(`/search/movie?${params}`);
    return body.results.map((r) => ({
      id: r.id,
      title: r.title,
      year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
      overview: r.overview ?? '',
      popularity: r.popularity ?? 0,
    }));
  }

  async searchShows(name: string): Promise<TmdbSearchResult[]> {
    const body = await this.get<{
      results: {
        id: number;
        name: string;
        first_air_date?: string;
        overview?: string;
        popularity?: number;
      }[];
    }>(`/search/tv?${new URLSearchParams({ query: name, include_adult: 'false' })}`);
    return body.results.map((r) => ({
      id: r.id,
      title: r.name,
      year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
      overview: r.overview ?? '',
      popularity: r.popularity ?? 0,
    }));
  }

  async movie(id: number | string): Promise<TmdbMovie> {
    const m = await this.get<RawMovie>(
      `/movie/${id}?append_to_response=credits,images,videos,release_dates,keywords&include_image_language=en,null`,
    );
    const crew = m.credits?.crew ?? [];
    const us = m.release_dates?.results?.find((r) => r.iso_3166_1 === 'US');
    const certification =
      us?.release_dates
        .slice()
        .sort((a, b) => (a.type === 3 ? -1 : b.type === 3 ? 1 : 0))
        .find((d) => d.certification)?.certification ?? null;
    const logos = (m.images?.logos ?? [])
      .filter((l) => l.iso_639_1 === 'en' && l.file_path.endsWith('.png'))
      .sort((a, b) => b.vote_average - a.vote_average);
    const enPoster = (m.images?.posters ?? [])
      .filter((p) => p.iso_639_1 === 'en')
      .sort((a, b) => b.vote_average - a.vote_average)[0];
    const videos = (m.videos?.results ?? [])
      .filter((v) => v.site === 'YouTube' && v.type === 'Trailer')
      .sort((a, b) => Number(Boolean(b.official)) - Number(Boolean(a.official)));
    return {
      id: m.id,
      imdbId: m.imdb_id || null,
      title: m.title,
      originalTitle: m.original_title && m.original_title !== m.title ? m.original_title : null,
      year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      releaseDate: m.release_date || null,
      runtime: m.runtime || null,
      genres: (m.genres ?? []).map((g) => g.name),
      overview: m.overview || null,
      tagline: m.tagline || null,
      voteAverage: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
      certification,
      countries: (m.production_countries ?? []).map((c) => c.name),
      studios: (m.production_companies ?? []).slice(0, 3).map((c) => c.name),
      keywords: (m.keywords?.keywords ?? []).slice(0, 12).map((k) => k.name),
      directors: unique(crew.filter((c) => c.job === 'Director').map((c) => c.name)),
      writers: unique(crew.filter((c) => c.department === 'Writing').map((c) => c.name)).slice(
        0,
        6,
      ),
      producers: unique(crew.filter((c) => c.job === 'Producer').map((c) => c.name)).slice(0, 6),
      cast: (m.credits?.cast ?? [])
        .slice()
        .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
        .slice(0, 15)
        .map((c) => ({
          id: c.id,
          name: c.name,
          character: c.character || null,
          profilePath: c.profile_path ?? null,
        })),
      trailers: videos
        .slice(0, 3)
        .map((v) => toTrailer(v.name, `https://www.youtube.com/watch?v=${v.key}`))
        .filter((t): t is Trailer => Boolean(t)),
      posterPath: enPoster?.file_path ?? m.poster_path ?? null,
      backdropPath: m.backdrop_path ?? null,
      logoPath: logos[0]?.file_path ?? null,
      collection: m.belongs_to_collection
        ? {
            id: m.belongs_to_collection.id,
            name: m.belongs_to_collection.name,
            posterPath: m.belongs_to_collection.poster_path,
            backdropPath: m.belongs_to_collection.backdrop_path,
          }
        : null,
    };
  }

  /** Downloads one image (e.g. "/abc.jpg" at "w780"). */
  async image(path: string, size: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${TMDB_IMAGES}/${size}${path}`);
    if (!res.ok) throw new Error(`TMDB image ${path} failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** "Title (Year) [tmdbid-123]" → its parts. */
export function parseFolderName(name: string): {
  title: string;
  year: number | null;
  tmdbId: string | null;
} {
  const tmdbId = /\[tmdbid-(\d+)\]/i.exec(name)?.[1] ?? null;
  const rest = name.replace(/\[[^\]]*\]/g, '').trim();
  const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(rest);
  return { title: (m ? m[1]! : rest).trim(), year: m ? Number(m[2]) : null, tmdbId };
}

const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The search result to use without asking, if one is clearly right. */
export function confidentMatch(
  results: TmdbSearchResult[],
  title: string,
  year: number | null,
): TmdbSearchResult | null {
  const exact = results.filter((r) => norm(r.title) === norm(title));
  const sameYear = year
    ? exact.filter((r) => r.year !== null && Math.abs(r.year - year) <= 1)
    : exact;
  if (sameYear.length === 1) return sameYear[0]!;
  if (!year && exact.length === 1 && results[0] === exact[0]) return exact[0]!;
  return null;
}
