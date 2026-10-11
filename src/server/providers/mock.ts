import { randomUUID } from 'node:crypto';
import { seededRandom, sortKey } from '../../shared/catalog.js';
import type {
  Movie,
  MovieUserState,
  PlaybackInfo,
  PlaybackReport,
  PlaybackRequest,
} from '../../shared/types.js';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import { SAMPLE_FILMS, type SampleFilm } from './mockLibrary.js';
import type { AuthResult, MediaProvider, MediaServerInfo, ProviderDetail, UserContext } from './types.js';

const SAMPLE_DURATION_SECONDS = 40;
const DAY = 86_400_000;

interface MockRow {
  item_id: string;
  favorite: number;
  played: number;
  position_seconds: number;
  play_count: number;
  last_played: string | null;
}

/** Stable "date added" spread over the last ~6 months, anchored to a fixed epoch. */
function dateAdded(film: SampleFilm, index: number): string {
  const anchor = Date.UTC(2026, 9, 1);
  const rand = seededRandom(`added-${film.id}`);
  return new Date(anchor - (index * 3 + Math.floor(rand() * 3)) * DAY).toISOString();
}

/**
 * Sample library used when no Jellyfin server is configured. Sign in with any
 * username and MOCK_PASSWORD. Watch state is stored in the app database so that
 * every interaction works and persists, but playback always uses one bundled
 * sample clip — it is clearly labelled as mock playback in the UI.
 */
export class MockProvider implements MediaProvider {
  readonly kind = 'mock' as const;
  readonly serverUrl = null;
  private readonly films = new Map(SAMPLE_FILMS.map((film) => [film.id, film]));
  private readonly addedDates = new Map(SAMPLE_FILMS.map((film, i) => [film.id, dateAdded(film, i)]));

  constructor(
    private readonly db: Db,
    private readonly password: string,
  ) {}

  async authenticate(username: string, password: string): Promise<AuthResult> {
    const name = username.trim();
    if (!name || password !== this.password) {
      throw new ApiError('INVALID_CREDENTIALS', 'Incorrect username or password.');
    }
    const id = `mock-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    this.seedUserState(id);
    return { user: { id, name, isAdmin: true }, token: null };
  }

  /** Give a new sample user a little history so every home row has content. */
  private seedUserState(userId: string) {
    const existing = this.db
      .prepare('SELECT COUNT(*) AS n FROM mock_user_data WHERE user_id = ?')
      .get(userId) as { n: number };
    if (existing.n > 0) return;
    const insert = this.db.prepare(
      `INSERT INTO mock_user_data (user_id, item_id, favorite, played, position_seconds, play_count, last_played)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const seed: [string, number, number, number, number][] = [
      // id, favorite, played, position (s), hours ago
      ['seven-samurai-1954', 0, 0, 4210, 5],
      ['charade-1963', 1, 0, 2520, 26],
      ['arrival-2016', 0, 0, 1830, 50],
      ['his-girl-friday-1940', 1, 1, 0, 120],
      ['totoro-1988', 1, 1, 0, 200],
      ['the-general-1926', 1, 1, 0, 300],
      ['groundhog-day-1993', 1, 1, 0, 400],
      ['paddington-2-2017', 0, 1, 0, 500],
      ['rashomon-1950', 0, 1, 0, 600],
    ];
    for (const [id, favorite, played, position, hoursAgo] of seed) {
      insert.run(userId, id, favorite, played, position, played, new Date(now - hoursAgo * 3_600_000).toISOString());
    }
  }

  async logout(): Promise<void> {}

  async validate(): Promise<void> {}

  async serverInfo(): Promise<MediaServerInfo> {
    return { reachable: true, name: 'Sample library', version: null, latencyMs: 0, error: null };
  }

  private rows(userId: string): Map<string, MockRow> {
    const rows = this.db
      .prepare('SELECT * FROM mock_user_data WHERE user_id = ?')
      .all(userId) as unknown as MockRow[];
    return new Map(rows.map((row) => [row.item_id, row]));
  }

  private userState(film: SampleFilm, row: MockRow | undefined): MovieUserState {
    const runtime = film.runtime ? film.runtime * 60 : null;
    const position = row?.position_seconds ?? 0;
    return {
      played: Boolean(row?.played),
      favorite: Boolean(row?.favorite),
      positionSeconds: Math.round(position),
      progress: runtime && position ? Math.min(1, position / runtime) : 0,
      playCount: row?.play_count ?? 0,
      lastPlayed: row?.last_played ?? null,
    };
  }

  private toMovie(film: SampleFilm, row: MockRow | undefined): Movie {
    return {
      id: film.id,
      title: film.title,
      sortTitle: sortKey(film.title),
      originalTitle: film.originalTitle ?? null,
      year: film.year,
      premiereDate: null,
      runtimeMinutes: film.runtime,
      genres: film.genres,
      directors: film.directors,
      studios: [],
      tags: film.tags,
      countries: film.countries,
      officialRating: film.rating,
      communityRating: null,
      criticRating: null,
      overview: film.overview,
      tagline: film.tagline ?? null,
      dateAdded: this.addedDates.get(film.id) ?? null,
      images: {
        poster: `/api/mock/art/${film.id}/poster.svg`,
        backdrop: film.genres.length ? `/api/mock/art/${film.id}/backdrop.svg` : null,
        logo: null,
      },
      user: this.userState(film, row),
      available: true,
    };
  }

  async listMovies(ctx: UserContext): Promise<Movie[]> {
    const rows = this.rows(ctx.userId);
    return SAMPLE_FILMS.map((film) => this.toMovie(film, rows.get(film.id)));
  }

  async getMovie(ctx: UserContext, id: string): Promise<ProviderDetail | null> {
    const film = this.films.get(id);
    if (!film) return null;
    const movie = this.toMovie(film, this.rows(ctx.userId).get(id));
    return {
      ...movie,
      cast: film.cast.map((name) => ({ id: null, name, role: null, type: 'Actor', image: null })),
      writers: film.writers ?? [],
      producers: [],
      mediaInfo: {
        container: 'mp4',
        videoCodec: 'h264',
        width: 960,
        height: 540,
        sizeBytes: null,
        bitrate: null,
        audioTracks: [{ index: 1, language: 'eng', title: 'English - AAC - Stereo', codec: 'aac', isDefault: true, channels: 2 }],
        subtitleTracks: [{ index: 2, language: 'eng', title: 'English', codec: 'webvtt', isDefault: false, isExternal: true, isImageBased: false }],
      },
      externalLinks: [],
    };
  }

  async similar(_ctx: UserContext, id: string): Promise<string[]> {
    const film = this.films.get(id);
    if (!film || film.genres.length === 0) return [];
    return SAMPLE_FILMS.filter((other) => other.id !== id)
      .map((other) => ({
        id: other.id,
        score:
          other.genres.filter((g) => film.genres.includes(g)).length +
          other.directors.filter((d) => film.directors.includes(d)).length * 3 +
          (Math.abs(other.year - film.year) < 10 ? 1 : 0),
      }))
      .filter((entry) => entry.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.id);
  }

  private requireFilm(id: string): SampleFilm {
    const film = this.films.get(id);
    if (!film) throw new ApiError('NOT_FOUND', 'Movie not found');
    return film;
  }

  async getUserState(ctx: UserContext, id: string): Promise<MovieUserState> {
    return this.userState(this.requireFilm(id), this.rows(ctx.userId).get(id));
  }

  private upsert(userId: string, id: string, patch: Partial<Omit<MockRow, 'item_id'>>) {
    const current = this.rows(userId).get(id);
    const next = {
      favorite: current?.favorite ?? 0,
      played: current?.played ?? 0,
      position_seconds: current?.position_seconds ?? 0,
      play_count: current?.play_count ?? 0,
      last_played: current?.last_played ?? null,
      ...patch,
    };
    this.db
      .prepare(
        `INSERT INTO mock_user_data (user_id, item_id, favorite, played, position_seconds, play_count, last_played)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, item_id) DO UPDATE SET favorite = excluded.favorite, played = excluded.played,
           position_seconds = excluded.position_seconds, play_count = excluded.play_count, last_played = excluded.last_played`,
      )
      .run(userId, id, next.favorite, next.played, next.position_seconds, next.play_count, next.last_played);
  }

  async setFavorite(ctx: UserContext, id: string, favorite: boolean): Promise<MovieUserState> {
    this.requireFilm(id);
    this.upsert(ctx.userId, id, { favorite: favorite ? 1 : 0 });
    return this.getUserState(ctx, id);
  }

  async setPlayed(ctx: UserContext, id: string, played: boolean): Promise<MovieUserState> {
    const current = this.rows(ctx.userId).get(id);
    this.requireFilm(id);
    this.upsert(ctx.userId, id, {
      played: played ? 1 : 0,
      position_seconds: 0,
      play_count: played ? (current?.play_count ?? 0) + 1 : current?.play_count ?? 0,
      last_played: played ? new Date().toISOString() : current?.last_played ?? null,
    });
    return this.getUserState(ctx, id);
  }

  async getPlayback(
    _ctx: UserContext,
    id: string,
    request: PlaybackRequest,
  ): Promise<PlaybackInfo> {
    const film = this.requireFilm(id);
    const start = Math.max(0, Number(request.startSeconds) || 0);
    const runtime = (film.runtime ?? 90) * 60;
    return {
      itemId: id,
      mediaSourceId: id,
      playSessionId: randomUUID(),
      method: 'DirectPlay',
      delivery: 'file',
      url: '/api/mock/sample.mp4',
      // The sample clip is short; map the saved position proportionally into it.
      startSeconds: Math.min(1, start / runtime) * SAMPLE_DURATION_SECONDS,
      durationSeconds: SAMPLE_DURATION_SECONDS,
      audioTracks: [{ index: 1, language: 'eng', title: 'English - AAC - Stereo', codec: 'aac', isDefault: true, channels: 2 }],
      subtitles: [
        {
          index: 2,
          language: 'eng',
          title: 'English',
          codec: 'webvtt',
          isDefault: false,
          isExternal: true,
          isImageBased: false,
          url: '/api/mock/sample.en.vtt',
        },
      ],
      selectedAudioIndex: 1,
      selectedSubtitleIndex: request.subtitleStreamIndex ?? null,
      isSample: true,
      transcodeReasons: [],
    };
  }

  async reportPlayback(
    ctx: UserContext,
    event: 'start' | 'progress' | 'stop',
    report: PlaybackReport,
  ): Promise<void> {
    const film = this.requireFilm(report.itemId);
    const now = new Date().toISOString();
    if (event !== 'stop') {
      this.upsert(ctx.userId, film.id, { last_played: now });
      return;
    }
    // Scale the sample-clip position to the movie's runtime so progress bars and
    // "Continue Watching" behave as they would with the real file.
    const runtime = (film.runtime ?? 90) * 60;
    const fraction = Math.min(1, Math.max(0, report.positionSeconds / SAMPLE_DURATION_SECONDS));
    const current = this.rows(ctx.userId).get(film.id);
    if (fraction >= 0.9) {
      this.upsert(ctx.userId, film.id, {
        played: 1,
        position_seconds: 0,
        play_count: (current?.play_count ?? 0) + 1,
        last_played: now,
      });
    } else if (fraction > 0.02) {
      this.upsert(ctx.userId, film.id, { position_seconds: Math.round(fraction * runtime), last_played: now });
    }
  }

  film(id: string): SampleFilm | undefined {
    return this.films.get(id);
  }
}
