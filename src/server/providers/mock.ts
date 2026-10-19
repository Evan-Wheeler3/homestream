import { randomUUID } from 'node:crypto';
import { seededRandom, sortKey } from '../../shared/catalog.js';
import type {
  Episode,
  EpisodeDetail,
  Movie,
  MovieUserState,
  PlaybackInfo,
  PlaybackReport,
  PlaybackRequest,
  Season,
  Show,
  ShowDetail,
} from '../../shared/types.js';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import { SAMPLE_FILMS, type SampleFilm } from './mockLibrary.js';
import { SAMPLE_SHOWS, sampleEpisodeId, type SampleEpisode, type SampleShow } from './mockShows.js';
import { pickNextUp } from './shows.js';
import type {
  AuthResult,
  MediaProvider,
  MediaServerInfo,
  ProviderDetail,
  UserContext,
} from './types.js';

const SAMPLE_DURATION_SECONDS = 40;
const DAY = 86_400_000;

interface SampleEpisodeRef {
  id: string;
  show: SampleShow;
  season: number;
  number: number;
  episode: SampleEpisode;
}

/** Every sample episode, in show, season and episode order. */
const SAMPLE_EPISODES: SampleEpisodeRef[] = SAMPLE_SHOWS.flatMap((show) =>
  show.seasons.flatMap((episodes, s) =>
    episodes.map((episode, e) => ({
      id: sampleEpisodeId(show, s + 1, e + 1),
      show,
      season: s + 1,
      number: e + 1,
      episode,
    })),
  ),
);

interface MockRow {
  item_id: string;
  favorite: number;
  played: number;
  position_seconds: number;
  play_count: number;
  last_played: string | null;
}

/** H.264 MP4 plays everywhere that matters; VP9 WebM covers browsers built without H.264. */
function sampleUrl(capabilities: unknown): string {
  const caps = (capabilities ?? {}) as { mp4VideoCodecs?: unknown; webmVideoCodecs?: unknown };
  const mp4 = Array.isArray(caps.mp4VideoCodecs) ? caps.mp4VideoCodecs : [];
  const webm = Array.isArray(caps.webmVideoCodecs) ? caps.webmVideoCodecs : [];
  return !mp4.includes('h264') && webm.includes('vp9')
    ? '/api/mock/sample.webm'
    : '/api/mock/sample.mp4';
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
  private readonly addedDates = new Map(
    SAMPLE_FILMS.map((film, i) => [film.id, dateAdded(film, i)]),
  );
  private readonly shows = new Map(SAMPLE_SHOWS.map((show) => [show.id, show]));
  private readonly episodes = new Map(SAMPLE_EPISODES.map((ref) => [ref.id, ref]));

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
      // Part way through a show, and one episode into another.
      ['harbour-lights-s01e01', 0, 1, 0, 30],
      ['harbour-lights-s01e02', 0, 1, 0, 29],
      ['harbour-lights-s01e03', 0, 0, 1260, 28],
      ['the-night-kitchen-s01e01', 0, 1, 0, 70],
    ];
    for (const [id, favorite, played, position, hoursAgo] of seed) {
      insert.run(
        userId,
        id,
        favorite,
        played,
        position,
        played,
        new Date(now - hoursAgo * 3_600_000).toISOString(),
      );
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

  private userState(film: { runtime: number | null }, row: MockRow | undefined): MovieUserState {
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
        audioTracks: [
          {
            index: 1,
            language: 'eng',
            title: 'English - AAC - Stereo',
            codec: 'aac',
            isDefault: true,
            channels: 2,
          },
        ],
        subtitleTracks: [
          {
            index: 2,
            language: 'eng',
            title: 'English',
            codec: 'webvtt',
            isDefault: false,
            isExternal: true,
            isImageBased: false,
          },
        ],
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

  /** A sample film or episode: anything with watch state that can be played. */
  private requireItem(id: string): { id: string; runtime: number | null } {
    const film = this.films.get(id);
    if (film) return film;
    const ref = this.episodes.get(id);
    if (ref) return { id, runtime: ref.episode.runtime };
    throw new ApiError('NOT_FOUND', 'Not found in the sample library');
  }

  async getUserState(ctx: UserContext, id: string): Promise<MovieUserState> {
    return this.userState(this.requireItem(id), this.rows(ctx.userId).get(id));
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
      .run(
        userId,
        id,
        next.favorite,
        next.played,
        next.position_seconds,
        next.play_count,
        next.last_played,
      );
  }

  async setFavorite(ctx: UserContext, id: string, favorite: boolean): Promise<MovieUserState> {
    if (!this.shows.has(id)) this.requireItem(id);
    this.upsert(ctx.userId, id, { favorite: favorite ? 1 : 0 });
    if (this.shows.has(id)) return this.userState({ runtime: null }, this.rows(ctx.userId).get(id));
    return this.getUserState(ctx, id);
  }

  async setPlayed(ctx: UserContext, id: string, played: boolean): Promise<MovieUserState> {
    const current = this.rows(ctx.userId).get(id);
    this.requireItem(id);
    this.upsert(ctx.userId, id, {
      played: played ? 1 : 0,
      position_seconds: 0,
      play_count: played ? (current?.play_count ?? 0) + 1 : (current?.play_count ?? 0),
      last_played: played ? new Date().toISOString() : (current?.last_played ?? null),
    });
    return this.getUserState(ctx, id);
  }

  async getPlayback(
    _ctx: UserContext,
    id: string,
    request: PlaybackRequest,
  ): Promise<PlaybackInfo> {
    const film = this.requireItem(id);
    const start = Math.max(0, Number(request.startSeconds) || 0);
    const runtime = (film.runtime ?? 90) * 60;
    return {
      itemId: id,
      mediaSourceId: id,
      playSessionId: randomUUID(),
      method: 'DirectPlay',
      delivery: 'file',
      url: sampleUrl(request.capabilities),
      // The sample clip is short; map the saved position proportionally into it.
      startSeconds: Math.min(1, start / runtime) * SAMPLE_DURATION_SECONDS,
      durationSeconds: SAMPLE_DURATION_SECONDS,
      audioTracks: [
        {
          index: 1,
          language: 'eng',
          title: 'English - AAC - Stereo',
          codec: 'aac',
          isDefault: true,
          channels: 2,
        },
      ],
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
    const film = this.requireItem(report.itemId);
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
      this.upsert(ctx.userId, film.id, {
        position_seconds: Math.round(fraction * runtime),
        last_played: now,
      });
    }
  }

  /** Something to draw artwork for: a film, or a stand-in for a show or episode. */
  film(id: string): SampleFilm | undefined {
    const film = this.films.get(id);
    if (film) return film;
    const show = this.shows.get(id) ?? this.episodes.get(id)?.show;
    if (!show) return undefined;
    return {
      id, // episodes get their own still, seeded by their id
      title: show.title,
      year: show.year,
      runtime: null,
      genres: show.genres,
      directors: [],
      cast: show.cast,
      countries: [],
      rating: show.rating,
      tags: [],
      overview: show.overview,
      byline: 'A SAMPLE SERIES',
    };
  }

  // ---------------------------------------------------------------------------
  // TV shows

  private toEpisode(ref: SampleEpisodeRef, row: MockRow | undefined): Episode {
    return {
      id: ref.id,
      showId: ref.show.id,
      showTitle: ref.show.title,
      seasonId: `${ref.show.id}-season-${ref.season}`,
      seasonNumber: ref.season,
      number: ref.number,
      endNumber: null,
      title: ref.episode.title,
      overview: ref.episode.overview,
      runtimeMinutes: ref.episode.runtime,
      premiereDate: null,
      image: `/api/mock/art/${ref.id}/backdrop.svg`,
      user: this.userState(ref.episode, row),
      available: true,
    };
  }

  private showEpisodes(show: SampleShow, rows: Map<string, MockRow>): Episode[] {
    return SAMPLE_EPISODES.filter((ref) => ref.show === show).map((ref) =>
      this.toEpisode(ref, rows.get(ref.id)),
    );
  }

  private toShow(show: SampleShow, rows: Map<string, MockRow>): Show {
    const episodes = this.showEpisodes(show, rows);
    return {
      id: show.id,
      title: show.title,
      sortTitle: sortKey(show.title),
      year: show.year,
      endYear: show.endYear,
      genres: show.genres,
      officialRating: show.rating,
      communityRating: null,
      overview: show.overview,
      dateAdded: null,
      images: {
        poster: `/api/mock/art/${show.id}/poster.svg`,
        backdrop: `/api/mock/art/${show.id}/backdrop.svg`,
        logo: null,
      },
      seasonCount: show.seasons.length,
      episodeCount: episodes.length,
      unwatchedCount: episodes.filter((e) => !e.user.played).length,
      favorite: Boolean(rows.get(show.id)?.favorite),
    };
  }

  async listShows(ctx: UserContext): Promise<Show[]> {
    const rows = this.rows(ctx.userId);
    return SAMPLE_SHOWS.map((show) => this.toShow(show, rows));
  }

  async getShow(ctx: UserContext, id: string): Promise<ShowDetail | null> {
    const show = this.shows.get(id);
    if (!show) return null;
    const rows = this.rows(ctx.userId);
    const episodes = this.showEpisodes(show, rows);
    const seasons: Season[] = show.seasons.map((_, s) => {
      const inSeason = episodes.filter((e) => e.seasonNumber === s + 1);
      return {
        id: `${show.id}-season-${s + 1}`,
        number: s + 1,
        name: `Season ${s + 1}`,
        episodeCount: inSeason.length,
        unwatchedCount: inSeason.filter((e) => !e.user.played).length,
        poster: null,
      };
    });
    return {
      ...this.toShow(show, rows),
      cast: show.cast.map((name) => ({ id: null, name, role: null, type: 'Actor', image: null })),
      seasons,
      episodes,
      nextUp: pickNextUp(episodes),
    };
  }

  async getEpisode(ctx: UserContext, id: string): Promise<EpisodeDetail | null> {
    const ref = this.episodes.get(id);
    if (!ref) return null;
    const siblings = SAMPLE_EPISODES.filter((r) => r.show === ref.show);
    const at = siblings.indexOf(ref);
    return {
      ...this.toEpisode(ref, this.rows(ctx.userId).get(id)),
      backdrop: `/api/mock/art/${ref.show.id}/backdrop.svg`,
      previousId: siblings[at - 1]?.id ?? null,
      nextId: siblings[at + 1]?.id ?? null,
    };
  }

  async nextUp(ctx: UserContext): Promise<Episode[]> {
    const rows = this.rows(ctx.userId);
    const lastPlayed = (show: SampleShow) =>
      Math.max(
        0,
        ...SAMPLE_EPISODES.filter((r) => r.show === show).map(
          (r) => Date.parse(rows.get(r.id)?.last_played ?? '') || 0,
        ),
      );
    return SAMPLE_SHOWS.filter((show) => lastPlayed(show) > 0)
      .sort((a, b) => lastPlayed(b) - lastPlayed(a))
      .map((show) => pickNextUp(this.showEpisodes(show, rows)))
      .filter((e): e is Episode => e !== null);
  }
}
