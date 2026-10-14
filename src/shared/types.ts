// Shared domain model used by the backend and the frontend.
//
// Ownership of each field is deliberate:
//  - `Movie` metadata, images, and `user` (watch state, favorite) are owned by the
//    media server (Jellyfin). The app never edits them locally; it asks Jellyfin.
//  - `personal` (rating, notes), collections and preferences are owned by this app
//    and stored in its SQLite database, keyed by stable Jellyfin item / user IDs.

export type MediaSourceKind = 'jellyfin' | 'mock';

export interface MovieImages {
  /** Same-origin URL; append width params with `imageUrl()` on the client. */
  poster: string | null;
  backdrop: string | null;
  logo: string | null;
}

/** Per-user state owned by the media server. */
export interface MovieUserState {
  played: boolean;
  favorite: boolean;
  /** Resume position in seconds (0 when not started or finished). */
  positionSeconds: number;
  /** 0..1, derived from position / runtime. */
  progress: number;
  playCount: number;
  lastPlayed: string | null;
}

/** App-owned per-user annotations. */
export interface PersonalData {
  rating: number | null;
  notes: string;
  updatedAt: string | null;
}

export interface Movie {
  /** Stable media-server item identifier. Never use titles as keys. */
  id: string;
  title: string;
  sortTitle: string;
  originalTitle: string | null;
  year: number | null;
  premiereDate: string | null;
  runtimeMinutes: number | null;
  genres: string[];
  directors: string[];
  /** Top-billed actors (names only; full cast with photos is on MovieDetail). */
  actors: string[];
  studios: string[];
  tags: string[];
  countries: string[];
  officialRating: string | null;
  communityRating: number | null;
  criticRating: number | null;
  overview: string | null;
  tagline: string | null;
  dateAdded: string | null;
  images: MovieImages;
  user: MovieUserState;
  /** False for items Jellyfin knows about but whose file is missing/virtual. */
  available: boolean;
}

export interface Person {
  id: string | null;
  name: string;
  role: string | null;
  type: string;
  image: string | null;
}

export interface MediaTrack {
  index: number;
  language: string | null;
  title: string;
  codec: string | null;
  isDefault: boolean;
  isForced?: boolean;
  isExternal?: boolean;
  /** Subtitle only: image-based subtitles (PGS/VobSub) must be burned in. */
  isImageBased?: boolean;
  channels?: number | null;
}

export interface MediaInfo {
  container: string | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  bitrate: number | null;
  audioTracks: MediaTrack[];
  subtitleTracks: MediaTrack[];
}

export interface Trailer {
  name: string;
  /** youtube: shown embedded (privacy-enhanced mode); video: a direct video URL; link: opens elsewhere. */
  kind: 'youtube' | 'video' | 'link';
  url: string;
  /** For youtube: the embeddable URL. */
  embedUrl: string | null;
}

export interface MovieDetail extends Movie {
  cast: Person[];
  trailers: Trailer[];
  writers: string[];
  producers: string[];
  mediaInfo: MediaInfo | null;
  externalLinks: { name: string; url: string }[];
  personal: PersonalData;
  collections: { id: string; name: string }[];
  /** On this user's watchlist (Wheelhouse-only, like notes). */
  onWatchlist: boolean;
  /** Series this film belongs to. */
  franchises: { id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Catalog querying

export type SortField = 'title' | 'year' | 'dateAdded' | 'runtime' | 'rating' | 'random';
export type SortDir = 'asc' | 'desc';

export interface MovieQuery {
  q?: string;
  genres?: string[];
  directors?: string[];
  actors?: string[];
  countries?: string[];
  tags?: string[];
  studios?: string[];
  ratings?: string[];
  yearMin?: number;
  yearMax?: number;
  runtimeMin?: number;
  runtimeMax?: number;
  watched?: 'watched' | 'unwatched' | 'inProgress';
  favorite?: boolean;
  /** Only movies on the signed-in user's watchlist. */
  watchlist?: boolean;
  /** Only these movie ids (e.g. a tie from movie night). */
  ids?: string[];
  sort?: SortField;
  dir?: SortDir;
  offset?: number;
  limit?: number;
}

/** A film series grouped by Jellyfin (a "box set", e.g. Star Wars Collection). */
export interface Franchise {
  id: string;
  name: string;
  movieIds: string[];
  poster: string | null;
  backdrop: string | null;
}

export interface FranchiseSummary {
  id: string;
  name: string;
  count: number;
  /** Artwork: the franchise's own, or its first film's. */
  image: string | null;
}

export interface FranchiseDetail {
  id: string;
  name: string;
  poster: string | null;
  backdrop: string | null;
  /** Oldest first. */
  movies: Movie[];
}

/** A director or actor, with what of theirs is in the library. */
export interface PersonSummary {
  name: string;
  directed: number;
  actedIn: number;
}

export interface PersonPage {
  name: string;
  directed: Movie[];
  actedIn: Movie[];
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface Facets {
  genres: FacetValue[];
  directors: FacetValue[];
  countries: FacetValue[];
  tags: FacetValue[];
  studios: FacetValue[];
  ratings: FacetValue[];
  decades: FacetValue[];
  yearRange: [number, number] | null;
  runtimeRange: [number, number] | null;
}

export interface FacetValue {
  value: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Collections

/** Rules supported by smart collections. Anything not listed is not supported. */
export type CollectionRule =
  | {
      field: 'genre' | 'director' | 'country' | 'tag' | 'studio' | 'officialRating';
      op: 'any' | 'none';
      values: string[];
    }
  | {
      field: 'year' | 'runtime' | 'communityRating' | 'personalRating';
      op: 'between';
      min: number | null;
      max: number | null;
    }
  | { field: 'watched'; op: 'is'; value: 'watched' | 'unwatched' | 'inProgress' }
  | { field: 'favorite'; op: 'is'; value: boolean }
  | { field: 'title'; op: 'contains'; value: string }
  | { field: 'addedWithinDays'; op: 'lte'; value: number };

export type RuleField = CollectionRule['field'];

export interface SmartRules {
  match: 'all' | 'any';
  rules: CollectionRule[];
  sort: Exclude<SortField, 'random'>;
  dir: SortDir;
  limit: number | null;
}

export type CollectionKind = 'manual' | 'smart';

export interface CollectionArtwork {
  kind: 'auto' | 'movie' | 'upload';
  /** movie: item id whose backdrop is used; upload: stored file name */
  ref: string | null;
  /** Resolved same-origin URL for display (null = auto mosaic of posters). */
  url: string | null;
}

export interface Collection {
  id: string;
  ownerUserId: string;
  name: string;
  description: string;
  kind: CollectionKind;
  rules: SmartRules | null;
  visibility: 'private' | 'shared';
  artwork: CollectionArtwork;
  position: number;
  createdAt: string;
  updatedAt: string;
  /** Number of matching/available movies (computed). */
  itemCount: number;
  /** Up to 4 poster URLs for the automatic artwork mosaic (computed). */
  previewPosters: string[];
  /** True when the current user may edit it. */
  editable: boolean;
}

export interface UnavailableMember {
  itemId: string;
  lastKnownTitle: string | null;
  lastKnownYear: number | null;
}

export interface CollectionDetail extends Collection {
  movies: Movie[];
  /** Manual members whose Jellyfin items no longer exist (deleted / renamed id). */
  unavailable: UnavailableMember[];
}

// ---------------------------------------------------------------------------
// Preferences (per user, stored server-side so they follow the user across devices)

export type HomeSectionId =
  | 'hero'
  | 'continueWatching'
  | 'recentlyAdded'
  | 'favorites'
  | 'collections'
  | 'randomPick'
  | 'genres'
  | 'decades'
  | 'unwatched'
  | 'watchlist'
  | 'becauseYouWatched'
  | 'yearInReview'
  | 'franchises'
  | `collection:${string}`;

export interface HomeSectionPref {
  id: HomeSectionId;
  visible: boolean;
}

export type ThemeName = 'graphite' | 'midnight' | 'sepia';
export type Density = 'compact' | 'comfortable' | 'large';

export interface Preferences {
  appName: string;
  theme: ThemeName;
  accent: string;
  motion: 'system' | 'reduced';
  density: Density;
  defaultSort: SortField;
  defaultSortDir: SortDir;
  heroSource: 'recentlyAdded' | 'random' | 'favorites' | 'continueWatching';
  homeSections: HomeSectionPref[];
  playback: {
    /** Bits per second; null = no cap ("Auto"). */
    maxBitrate: number | null;
    resumeBehavior: 'ask' | 'resume' | 'restart';
    /** ISO 639-2 code, '' = off unless forced. */
    subtitleLanguage: string;
    preferDirectPlay: boolean;
  };
  /** Internal: starter collections have been created for this user. */
  starterCollectionsCreated: boolean;
}

// ---------------------------------------------------------------------------
// Home

export interface HomeRow {
  id: HomeSectionId;
  title: string;
  kind: 'movies' | 'continue';
  movies: Movie[];
  href?: string;
}

export interface HomePayload {
  hero: Movie[];
  sections: (
    | { type: 'row'; row: HomeRow }
    | { type: 'collections'; id: 'collections'; collections: Collection[] }
    | {
        type: 'genres';
        id: 'genres';
        genres: { name: string; count: number; poster: string | null }[];
      }
    | {
        type: 'decades';
        id: 'decades';
        decades: { decade: number; count: number; poster: string | null }[];
      }
    | { type: 'randomPick'; id: 'randomPick'; movie: Movie | null }
    | { type: 'yearInReview'; id: 'yearInReview'; year: number; movies: number; hours: number }
    | { type: 'franchises'; id: 'franchises'; franchises: FranchiseSummary[] }
  )[];
  libraryCount: number;
}

// ---------------------------------------------------------------------------
// Playback

export interface ClientCapabilities {
  /** Video codecs the browser reports it can decode in MP4 (e.g. h264, hevc, av1). */
  mp4VideoCodecs: string[];
  webmVideoCodecs: string[];
  audioCodecs: string[];
  /** Browser plays HLS natively (Safari / iOS). */
  nativeHls: boolean;
  /** Media Source Extensions available (hls.js can be used). */
  mse: boolean;
  maxAudioChannels: number;
}

export interface PlaybackRequest {
  capabilities: ClientCapabilities;
  /** The media source (file version) being played, when switching tracks. */
  mediaSourceId?: string | null;
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
  startSeconds?: number;
  /** Force server-side processing (e.g. to switch audio track). */
  forceTranscode?: boolean;
}

export interface SubtitleDelivery extends MediaTrack {
  /** Same-origin WebVTT URL when it can be shown as a text track; null if burn-in is needed. */
  url: string | null;
}

export interface PlaybackInfo {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  method: 'DirectPlay' | 'DirectStream' | 'Transcode';
  /** 'file' => progressive <video src>, 'hls' => HLS playlist */
  delivery: 'file' | 'hls';
  url: string;
  startSeconds: number;
  durationSeconds: number | null;
  audioTracks: MediaTrack[];
  subtitles: SubtitleDelivery[];
  selectedAudioIndex: number | null;
  selectedSubtitleIndex: number | null;
  /** True when the URL is a bundled sample clip (mock mode), not the movie itself. */
  isSample: boolean;
  transcodeReasons: string[];
}

export interface PlaybackReport {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  positionSeconds: number;
  isPaused: boolean;
  method: PlaybackInfo['method'];
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
}

// ---------------------------------------------------------------------------
// Session / status

export interface SessionUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

// -----------------------------------------------------------------------------
// Movie night

export interface NightCandidate {
  id: string;
  title: string;
  year: number | null;
  runtimeMinutes: number | null;
  genres: string[];
  overview: string | null;
  /** May need a signed-in session to load (guests see a title card instead). */
  poster: string | null;
  votes: number;
}

export interface MovieNight {
  id: string;
  code: string;
  hostName: string;
  status: 'open' | 'closed';
  candidates: NightCandidate[];
  voters: { name: string }[];
  /** Set when voting is closed. Several ids = a tie. */
  winners: string[];
  createdAt: string;
}

/** A household member shown on the "Who's watching?" screen. */
export interface PublicProfile {
  id: string;
  name: string;
  hasPassword: boolean;
  /** Same-origin avatar URL, or null for initials. */
  image: string | null;
}

export interface SessionInfo {
  user: SessionUser;
  source: MediaSourceKind;
  /** True when automatic disc ripping is set up on the server. */
  ripper?: boolean;
}

// -----------------------------------------------------------------------------
// Disc ripping

export type RipStatus =
  | 'scanning' // reading the disc's contents
  | 'needs_choice' // several possible main titles; waiting for the user
  | 'ripping' // copying the movie off the disc
  | 'ripped' // waiting for its turn to be compressed
  | 'encoding' // compressing with HandBrake
  | 'needs_name' // compressed, but which movie it is needs confirming
  | 'filing' // moving into the Movies folder
  | 'importing' // waiting for Jellyfin to add it
  | 'done'
  | 'failed';

export interface RipCandidate {
  title: string;
  year: number | null;
  tmdbId: string | null;
  imdbId: string | null;
}

export interface RipDiscTitle {
  index: number;
  durationSeconds: number;
  sizeBytes: number;
  chapters: number;
}

export interface RipJob {
  id: string;
  status: RipStatus;
  discLabel: string;
  /** 0–1 while ripping or encoding. */
  progress: number | null;
  message: string | null;
  /** The title guessed from the disc label. */
  guess: string | null;
  /** The confirmed movie (set automatically when confident, or by the user). */
  title: string | null;
  year: number | null;
  candidates: RipCandidate[];
  /** Titles to choose from when the status is needs_choice. */
  discTitles: RipDiscTitle[];
  moviePath: string | null;
  /** Wheelhouse/Jellyfin movie id once imported. */
  movieId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface UpdateStatus {
  /** False for installs that didn't come from git (reason explains). */
  supported: boolean;
  reason: string | null;
  branch: string | null;
  current: { sha: string; date: string; subject: string } | null;
  /** How many new changes are available. */
  behind: number;
  /** Their descriptions, newest first. */
  changes: string[];
  checkedAt: string | null;
  state: {
    running: boolean;
    step: string | null;
    error: string | null;
    finishedAt: string | null;
    restarting: boolean;
  };
}

export interface DriveStatus {
  label: string;
  path: string;
  available: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  /** Below the low-space warning threshold. */
  low: boolean;
}

export interface BackupStatus {
  enabled: boolean;
  dir: string;
  count: number;
  last: string | null;
}

export interface RipperHealth {
  enabled: boolean;
  /** Setup problems that stop ripping from working. */
  problems: string[];
  /** Things that work but could be better (e.g. no phone notifications). */
  warnings: string[];
  watching: boolean;
  /** Whether movie names can be looked up (needs a Jellyfin API key). */
  canSearch: boolean;
}

export interface ServerStatus {
  app: { name: string; version: string; startedAt: string; node: string };
  source: MediaSourceKind;
  mediaServer: {
    url: string | null;
    reachable: boolean;
    name: string | null;
    version: string | null;
    latencyMs: number | null;
    error: string | null;
  };
  catalog: {
    count: number;
    lastRefreshed: string | null;
    stale: boolean;
    lastError: string | null;
  };
  /** Storage, backups and disc ripping (null when not available, e.g. in tests). */
  drives: DriveStatus[];
  backups: BackupStatus | null;
  ripper: RipperHealth | null;
  /** Who's playing something right now (administrators only; null for others). */
  watching: NowWatching[] | null;
}

/** Where a request came from: the home network, or away (Tailscale / the internet). */
export type NetworkPlace = 'home' | 'away';

/** Someone playing a movie right now (shown to administrators). */
export interface NowWatching {
  userName: string;
  itemId: string;
  title: string;
  year: number | null;
  poster: string | null;
  positionSeconds: number;
  runtimeSeconds: number | null;
  paused: boolean;
  method: 'DirectPlay' | 'DirectStream' | 'Transcode';
  place: NetworkPlace;
  device: string;
  /** The streaming limit applied to this person, if any. */
  limit: number | null;
  startedAt: string;
}

/** A per-person cap on streaming quality, set by an administrator. */
export interface StreamLimit {
  userId: string;
  userName: string;
  /** Bits per second; null = no limit. */
  maxBitrate: number | null;
  /** Only when they're away from home (over Tailscale or the internet). */
  awayOnly: boolean;
  lastSeen: string | null;
}

export interface ShareInfo {
  /** Addresses Wheelhouse can be opened at, best first. */
  addresses: { url: string; kind: 'tailscale' | 'home' }[];
  hostname: string;
  port: number;
  tailscale: boolean;
}

export type MovieRequestStatus = 'open' | 'added' | 'declined';

export interface MovieRequest {
  id: string;
  userId: string;
  userName: string;
  title: string;
  year: number | null;
  note: string;
  status: MovieRequestStatus;
  /** The library item, once it's added. */
  itemId: string | null;
  createdAt: string;
  updatedAt: string;
  mine: boolean;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'MEDIA_SERVER_UNREACHABLE'
  | 'MEDIA_SERVER_ERROR'
  | 'MEDIA_UNAVAILABLE'
  | 'CONFLICT'
  | 'INTERNAL';
