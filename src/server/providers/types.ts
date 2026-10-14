import type {
  Franchise,
  Movie,
  MovieDetail,
  MovieUserState,
  PlaybackInfo,
  PlaybackReport,
  PlaybackRequest,
  PublicProfile,
  SessionUser,
} from '../../shared/types.js';

/** Identity of the signed-in user as needed to call the media server on their behalf. */
export interface UserContext {
  userId: string;
  userName: string;
  /** Media-server access token. Kept server-side only; never sent to the browser. */
  token: string | null;
  deviceId: string;
  deviceName: string;
}

export interface AuthResult {
  user: SessionUser;
  token: string | null;
}

export interface MediaServerInfo {
  reachable: boolean;
  name: string | null;
  version: string | null;
  latencyMs: number | null;
  error: string | null;
}

export type ProviderDetail = Omit<
  MovieDetail,
  'personal' | 'collections' | 'onWatchlist' | 'franchises'
>;

/**
 * The boundary between this app and the media server. The Jellyfin implementation
 * is the real one; the mock implementation powers the built-in sample library.
 */
export interface MediaProvider {
  readonly kind: 'jellyfin' | 'mock';
  readonly serverUrl: string | null;
  authenticate(
    username: string,
    password: string,
    device: { deviceId: string; deviceName: string },
  ): Promise<AuthResult>;
  logout(ctx: UserContext): Promise<void>;
  /** Household members for the profile picker (no sign-in needed). */
  publicProfiles(): Promise<PublicProfile[]>;
  /** A profile's avatar image, if it has one. */
  profileImage(id: string): Promise<Response | null>;
  /** Throws ApiError('SESSION_EXPIRED') when the token is no longer valid. */
  validate(ctx: UserContext): Promise<void>;
  serverInfo(): Promise<MediaServerInfo>;
  listMovies(ctx: UserContext): Promise<Movie[]>;
  /** Film series (Jellyfin box sets). */
  listFranchises(ctx: UserContext): Promise<Franchise[]>;
  getMovie(ctx: UserContext, id: string): Promise<ProviderDetail | null>;
  similar(ctx: UserContext, id: string): Promise<string[]>;
  getUserState(ctx: UserContext, id: string): Promise<MovieUserState>;
  setFavorite(ctx: UserContext, id: string, favorite: boolean): Promise<MovieUserState>;
  setPlayed(ctx: UserContext, id: string, played: boolean): Promise<MovieUserState>;
  getPlayback(
    ctx: UserContext,
    id: string,
    request: PlaybackRequest,
    prefs: { maxBitrate: number | null; preferDirectPlay: boolean },
  ): Promise<PlaybackInfo>;
  reportPlayback(
    ctx: UserContext,
    event: 'start' | 'progress' | 'stop',
    report: PlaybackReport,
  ): Promise<void>;
}
