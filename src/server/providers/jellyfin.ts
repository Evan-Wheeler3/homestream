import { randomUUID } from 'node:crypto';
import { sortKey } from '../../shared/catalog.js';
import type {
  Episode,
  EpisodeDetail,
  MediaInfo,
  MediaTrack,
  Movie,
  MovieUserState,
  PlaybackInfo,
  PlaybackReport,
  PlaybackRequest,
  Person,
  Season,
  Show,
  ShowDetail,
  SubtitleDelivery,
} from '../../shared/types.js';
import { ApiError } from '../errors.js';
import {
  buildDeviceProfile,
  IMAGE_SUBTITLE_CODECS,
  sanitizeCapabilities,
} from './deviceProfile.js';
import { pickNextUp } from './shows.js';
import type {
  AuthResult,
  MediaProvider,
  MediaServerInfo,
  ProviderDetail,
  UserContext,
} from './types.js';

const TICKS_PER_SECOND = 10_000_000;
const CLIENT_NAME = 'Wheelhouse';
const PAGE_SIZE = 500;

/** Fields requested for catalog listings. People is needed to know directors. */
const LIST_FIELDS = [
  'Genres',
  'People',
  'Overview',
  'ProductionLocations',
  'Tags',
  'Studios',
  'DateCreated',
  'OriginalTitle',
  'Taglines',
  'SortName',
  'PremiereDate',
].join(',');

const DETAIL_FIELDS = `${LIST_FIELDS},MediaSources,MediaStreams,ExternalUrls`;

const SHOW_FIELDS =
  'Genres,Overview,DateCreated,SortName,PremiereDate,ChildCount,RecursiveItemCount';
const EPISODE_FIELDS = 'Overview,PremiereDate';

// Jellyfin JSON is PascalCase, but some endpoints (e.g. /System/Info/Public on 12.x)
// return camelCase. Normalise everything to PascalCase so mapping code has one shape.
type Json = Record<string, unknown>;
function pascal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pascal);
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [key, v] of Object.entries(value as Json)) {
      out[key.charAt(0).toUpperCase() + key.slice(1)] = pascal(v);
    }
    return out;
  }
  return value;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];

/** Escape a value for the MediaBrowser Authorization header. */
function headerValue(value: string): string {
  return encodeURIComponent(value);
}

export class JellyfinProvider implements MediaProvider {
  readonly kind = 'jellyfin' as const;

  constructor(
    readonly serverUrl: string,
    private readonly version: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private authHeader(device: { deviceId: string; deviceName: string }, token?: string | null) {
    let header =
      `MediaBrowser Client="${CLIENT_NAME}", Device="${headerValue(device.deviceName)}", ` +
      `DeviceId="${headerValue(device.deviceId)}", Version="${this.version}"`;
    if (token) header += `, Token="${token}"`;
    return header;
  }

  /** Authorization header for the media proxy (video/image requests). */
  proxyAuthHeader(ctx: UserContext): string {
    return this.authHeader(ctx, ctx.token);
  }

  private async request(
    path: string,
    options: {
      ctx?: UserContext;
      device?: { deviceId: string; deviceName: string };
      method?: string;
      body?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const device = options.ctx ?? options.device ?? { deviceId: 'server', deviceName: 'server' };
    headers.Authorization = this.authHeader(device, options.ctx?.token);
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ApiError(
        'MEDIA_SERVER_UNREACHABLE',
        `Cannot reach Jellyfin at ${this.serverUrl} (${reason})`,
      );
    }
    if (response.status === 401 && options.ctx) {
      throw new ApiError('SESSION_EXPIRED', 'Your Jellyfin session has expired. Sign in again.');
    }
    return response;
  }

  private async json<T = Json>(
    path: string,
    options: Parameters<JellyfinProvider['request']>[1] = {},
  ) {
    const response = await this.request(path, options);
    if (response.status === 404) throw new ApiError('NOT_FOUND', 'Item not found on Jellyfin');
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(
        'MEDIA_SERVER_ERROR',
        `Jellyfin returned ${response.status} for ${path.split('?')[0]}${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }
    if (response.status === 204) return {} as T;
    return pascal(await response.json()) as T;
  }

  async authenticate(
    username: string,
    password: string,
    device: { deviceId: string; deviceName: string },
  ): Promise<AuthResult> {
    const response = await this.request('/Users/AuthenticateByName', {
      method: 'POST',
      device,
      body: { Username: username, Pw: password },
    });
    if (response.status === 401 || response.status === 403) {
      throw new ApiError('INVALID_CREDENTIALS', 'Incorrect username or password.');
    }
    if (!response.ok) {
      throw new ApiError('MEDIA_SERVER_ERROR', `Jellyfin sign-in failed (${response.status}).`);
    }
    const data = pascal(await response.json()) as Json;
    const user = (data.User ?? {}) as Json;
    const policy = (user.Policy ?? {}) as Json;
    const token = str(data.AccessToken);
    if (!token || !str(user.Id)) {
      throw new ApiError('MEDIA_SERVER_ERROR', 'Jellyfin did not return an access token.');
    }
    return {
      user: {
        id: String(user.Id),
        name: String(user.Name ?? username),
        isAdmin: Boolean(policy.IsAdministrator),
      },
      token,
    };
  }

  async logout(ctx: UserContext): Promise<void> {
    await this.request('/Sessions/Logout', { method: 'POST', ctx }).catch(() => undefined);
  }

  async validate(ctx: UserContext): Promise<void> {
    await this.json('/Users/Me', { ctx });
  }

  async serverInfo(): Promise<MediaServerInfo> {
    const started = performance.now();
    try {
      const info = await this.json('/System/Info/Public', { timeoutMs: 5000 });
      return {
        reachable: true,
        name: str(info.ServerName),
        version: str(info.Version),
        latencyMs: Math.round(performance.now() - started),
        error: null,
      };
    } catch (error) {
      return {
        reachable: false,
        name: null,
        version: null,
        latencyMs: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Catalog

  private imageUrl(id: string, type: string, tag: string | null, index?: number) {
    if (!tag) return null;
    const suffix = index != null ? `/${index}` : '';
    return `/jf/Items/${id}/Images/${type}${suffix}?tag=${encodeURIComponent(tag)}`;
  }

  private mapUserState(item: Json): MovieUserState {
    const data = (item.UserData ?? {}) as Json;
    const runtimeTicks = num(item.RunTimeTicks);
    const positionTicks = num(data.PlaybackPositionTicks) ?? 0;
    return {
      played: Boolean(data.Played),
      favorite: Boolean(data.IsFavorite),
      positionSeconds: Math.round(positionTicks / TICKS_PER_SECOND),
      progress: runtimeTicks && positionTicks ? Math.min(1, positionTicks / runtimeTicks) : 0,
      playCount: num(data.PlayCount) ?? 0,
      lastPlayed: str(data.LastPlayedDate),
    };
  }

  mapMovie(item: Json): Movie {
    const id = String(item.Id);
    const title = str(item.Name) ?? 'Untitled';
    const imageTags = (item.ImageTags ?? {}) as Record<string, string>;
    const backdropTags = strArr(item.BackdropImageTags);
    const runtimeTicks = num(item.RunTimeTicks);
    const people = arr(item.People);
    const taglines = strArr(item.Taglines);
    const locationType = str(item.LocationType);
    return {
      id,
      title,
      sortTitle: sortKey(str(item.SortName) ?? title),
      originalTitle: str(item.OriginalTitle) !== title ? str(item.OriginalTitle) : null,
      year: num(item.ProductionYear),
      premiereDate: str(item.PremiereDate),
      runtimeMinutes: runtimeTicks ? Math.round(runtimeTicks / TICKS_PER_SECOND / 60) : null,
      genres: strArr(item.Genres),
      directors: people.filter((p) => p.Type === 'Director').map((p) => String(p.Name)),
      studios: arr(item.Studios)
        .map((s) => String(s.Name))
        .filter(Boolean),
      tags: strArr(item.Tags),
      countries: strArr(item.ProductionLocations),
      officialRating: str(item.OfficialRating),
      communityRating: num(item.CommunityRating),
      criticRating: num(item.CriticRating),
      overview: str(item.Overview),
      tagline: taglines[0] ?? null,
      dateAdded: str(item.DateCreated),
      images: {
        poster: this.imageUrl(id, 'Primary', imageTags.Primary ?? null),
        backdrop: this.imageUrl(id, 'Backdrop', backdropTags[0] ?? null, 0),
        logo: this.imageUrl(id, 'Logo', imageTags.Logo ?? null),
      },
      user: this.mapUserState(item),
      available: locationType !== 'Virtual' && item.IsMissing !== true,
    };
  }

  async listMovies(ctx: UserContext): Promise<Movie[]> {
    const movies: Movie[] = [];
    for (let start = 0; ; start += PAGE_SIZE) {
      const params = new URLSearchParams({
        userId: ctx.userId,
        recursive: 'true',
        includeItemTypes: 'Movie',
        fields: LIST_FIELDS,
        enableUserData: 'true',
        enableImageTypes: 'Primary,Backdrop,Logo',
        imageTypeLimit: '1',
        sortBy: 'SortName',
        startIndex: String(start),
        limit: String(PAGE_SIZE),
        enableTotalRecordCount: 'true',
      });
      const page = await this.json(`/Items?${params}`, { ctx, timeoutMs: 60_000 });
      const items = arr(page.Items);
      movies.push(...items.map((item) => this.mapMovie(item)));
      const total = num(page.TotalRecordCount) ?? 0;
      if (items.length < PAGE_SIZE || movies.length >= total) break;
    }
    return movies;
  }

  private mapTrack(stream: Json): MediaTrack {
    const codec = str(stream.Codec);
    return {
      index: num(stream.Index) ?? 0,
      language: str(stream.Language),
      title:
        str(stream.DisplayTitle) ??
        str(stream.Title) ??
        str(stream.Language) ??
        `Track ${String(stream.Index)}`,
      codec,
      isDefault: Boolean(stream.IsDefault),
      isForced: Boolean(stream.IsForced),
      isExternal: Boolean(stream.IsExternal),
      isImageBased: codec ? IMAGE_SUBTITLE_CODECS.has(codec.toLowerCase()) : false,
      channels: num(stream.Channels),
    };
  }

  private mapMediaInfo(item: Json): MediaInfo | null {
    const source = arr(item.MediaSources)[0];
    if (!source) return null;
    const streams = arr(source.MediaStreams);
    const video = streams.find((s) => s.Type === 'Video');
    return {
      container: str(source.Container),
      videoCodec: video ? str(video.Codec) : null,
      width: video ? num(video.Width) : null,
      height: video ? num(video.Height) : null,
      sizeBytes: num(source.Size),
      bitrate: num(source.Bitrate),
      audioTracks: streams.filter((s) => s.Type === 'Audio').map((s) => this.mapTrack(s)),
      subtitleTracks: streams.filter((s) => s.Type === 'Subtitle').map((s) => this.mapTrack(s)),
    };
  }

  async getMovie(ctx: UserContext, id: string): Promise<ProviderDetail | null> {
    let item: Json;
    try {
      item = await this.json(
        `/Items/${encodeURIComponent(id)}?${new URLSearchParams({ userId: ctx.userId, fields: DETAIL_FIELDS })}`,
        { ctx },
      );
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'NOT_FOUND' || error.status === 400))
        return null;
      throw error;
    }
    if (item.Type !== 'Movie') return null;
    const movie = this.mapMovie(item);
    const people = arr(item.People);
    const cast: Person[] = people
      .filter((p) => p.Type === 'Actor' || p.Type === 'GuestStar')
      .slice(0, 30)
      .map((p) => ({
        id: str(p.Id),
        name: String(p.Name),
        role: str(p.Role),
        type: String(p.Type),
        image: str(p.Id) ? this.imageUrl(String(p.Id), 'Primary', str(p.PrimaryImageTag)) : null,
      }));
    return {
      ...movie,
      cast,
      writers: people.filter((p) => p.Type === 'Writer').map((p) => String(p.Name)),
      producers: people.filter((p) => p.Type === 'Producer').map((p) => String(p.Name)),
      mediaInfo: this.mapMediaInfo(item),
      externalLinks: arr(item.ExternalUrls)
        .map((u) => ({ name: String(u.Name ?? ''), url: String(u.Url ?? '') }))
        .filter((u) => /^https?:\/\//.test(u.url)),
    };
  }

  async similar(ctx: UserContext, id: string): Promise<string[]> {
    const params = new URLSearchParams({ userId: ctx.userId, limit: '16' });
    const data = await this.json(`/Items/${encodeURIComponent(id)}/Similar?${params}`, { ctx });
    return arr(data.Items)
      .filter((item) => item.Type === 'Movie')
      .map((item) => String(item.Id));
  }

  // ---------------------------------------------------------------------------
  // TV shows

  private mapShow(item: Json): Show {
    const id = String(item.Id);
    const title = str(item.Name) ?? 'Untitled';
    const imageTags = (item.ImageTags ?? {}) as Record<string, string>;
    const backdropTags = strArr(item.BackdropImageTags);
    const data = (item.UserData ?? {}) as Json;
    const ended = str(item.Status) === 'Ended';
    const endYear = str(item.EndDate) ? Number(String(item.EndDate).slice(0, 4)) || null : null;
    return {
      id,
      title,
      sortTitle: sortKey(str(item.SortName) ?? title),
      year: num(item.ProductionYear),
      endYear: ended ? endYear : null,
      genres: strArr(item.Genres),
      officialRating: str(item.OfficialRating),
      communityRating: num(item.CommunityRating),
      overview: str(item.Overview),
      dateAdded: str(item.DateCreated),
      images: {
        poster: this.imageUrl(id, 'Primary', imageTags.Primary ?? null),
        backdrop: this.imageUrl(id, 'Backdrop', backdropTags[0] ?? null, 0),
        logo: this.imageUrl(id, 'Logo', imageTags.Logo ?? null),
      },
      seasonCount: num(item.ChildCount) ?? 0,
      episodeCount: num(item.RecursiveItemCount) ?? 0,
      unwatchedCount: num(data.UnplayedItemCount) ?? 0,
      favorite: Boolean(data.IsFavorite),
    };
  }

  private mapSeason(item: Json): Season {
    const id = String(item.Id);
    const imageTags = (item.ImageTags ?? {}) as Record<string, string>;
    const data = (item.UserData ?? {}) as Json;
    const number = num(item.IndexNumber);
    return {
      id,
      number,
      name: str(item.Name) ?? (number === 0 ? 'Specials' : `Season ${number ?? ''}`.trim()),
      episodeCount: num(item.ChildCount) ?? 0,
      unwatchedCount: num(data.UnplayedItemCount) ?? 0,
      poster: this.imageUrl(id, 'Primary', imageTags.Primary ?? null),
    };
  }

  private mapEpisode(item: Json): Episode {
    const id = String(item.Id);
    const imageTags = (item.ImageTags ?? {}) as Record<string, string>;
    const runtimeTicks = num(item.RunTimeTicks);
    // The episode's own still, else the show's thumb or backdrop.
    const image =
      this.imageUrl(id, 'Primary', imageTags.Primary ?? null) ??
      (str(item.ParentThumbItemId)
        ? this.imageUrl(String(item.ParentThumbItemId), 'Thumb', str(item.ParentThumbImageTag))
        : null) ??
      (str(item.ParentBackdropItemId)
        ? this.imageUrl(
            String(item.ParentBackdropItemId),
            'Backdrop',
            strArr(item.ParentBackdropImageTags)[0] ?? null,
            0,
          )
        : null);
    return {
      id,
      showId: String(item.SeriesId ?? ''),
      showTitle: str(item.SeriesName) ?? '',
      seasonId: str(item.SeasonId),
      seasonNumber: num(item.ParentIndexNumber),
      number: num(item.IndexNumber),
      endNumber: num(item.IndexNumberEnd),
      title: str(item.Name) ?? 'Untitled',
      overview: str(item.Overview),
      runtimeMinutes: runtimeTicks ? Math.round(runtimeTicks / TICKS_PER_SECOND / 60) : null,
      premiereDate: str(item.PremiereDate),
      image,
      user: this.mapUserState(item),
      available: str(item.LocationType) !== 'Virtual' && item.IsMissing !== true,
    };
  }

  async listShows(ctx: UserContext): Promise<Show[]> {
    const shows: Show[] = [];
    for (let start = 0; ; start += PAGE_SIZE) {
      const params = new URLSearchParams({
        userId: ctx.userId,
        recursive: 'true',
        includeItemTypes: 'Series',
        fields: SHOW_FIELDS,
        enableUserData: 'true',
        enableImageTypes: 'Primary,Backdrop,Logo',
        imageTypeLimit: '1',
        sortBy: 'SortName',
        startIndex: String(start),
        limit: String(PAGE_SIZE),
        enableTotalRecordCount: 'true',
      });
      const page = await this.json(`/Items?${params}`, { ctx, timeoutMs: 60_000 });
      const items = arr(page.Items);
      shows.push(...items.map((item) => this.mapShow(item)));
      const total = num(page.TotalRecordCount) ?? 0;
      if (items.length < PAGE_SIZE || shows.length >= total) break;
    }
    return shows;
  }

  /** Every episode of a show, in season and episode order. */
  private async showEpisodes(ctx: UserContext, showId: string): Promise<Episode[]> {
    const params = new URLSearchParams({
      userId: ctx.userId,
      fields: EPISODE_FIELDS,
      enableUserData: 'true',
      enableImageTypes: 'Primary,Thumb,Backdrop',
      imageTypeLimit: '1',
    });
    const data = await this.json(`/Shows/${encodeURIComponent(showId)}/Episodes?${params}`, {
      ctx,
      timeoutMs: 30_000,
    });
    return arr(data.Items).map((item) => this.mapEpisode(item));
  }

  private async item(ctx: UserContext, id: string, fields: string): Promise<Json | null> {
    try {
      return await this.json(
        `/Items/${encodeURIComponent(id)}?${new URLSearchParams({ userId: ctx.userId, fields })}`,
        { ctx },
      );
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'NOT_FOUND' || error.status === 400))
        return null;
      throw error;
    }
  }

  async getShow(ctx: UserContext, id: string): Promise<ShowDetail | null> {
    const item = await this.item(ctx, id, `${SHOW_FIELDS},People`);
    if (!item || item.Type !== 'Series') return null;
    const seasonParams = new URLSearchParams({
      userId: ctx.userId,
      fields: 'ChildCount',
      enableUserData: 'true',
    });
    const [seasons, episodes] = await Promise.all([
      this.json(`/Shows/${encodeURIComponent(id)}/Seasons?${seasonParams}`, { ctx }),
      this.showEpisodes(ctx, id),
    ]);
    const cast: Person[] = arr(item.People)
      .filter((p) => p.Type === 'Actor' || p.Type === 'GuestStar')
      .slice(0, 30)
      .map((p) => ({
        id: str(p.Id),
        name: String(p.Name),
        role: str(p.Role),
        type: String(p.Type),
        image: str(p.Id) ? this.imageUrl(String(p.Id), 'Primary', str(p.PrimaryImageTag)) : null,
      }));
    return {
      ...this.mapShow(item),
      cast,
      seasons: arr(seasons.Items).map((s) => this.mapSeason(s)),
      episodes,
      nextUp: pickNextUp(episodes),
    };
  }

  async getEpisode(ctx: UserContext, id: string): Promise<EpisodeDetail | null> {
    const item = await this.item(ctx, id, EPISODE_FIELDS);
    if (!item || item.Type !== 'Episode') return null;
    const episode = this.mapEpisode(item);
    const siblings = episode.showId
      ? (await this.showEpisodes(ctx, episode.showId)).filter((e) => e.available)
      : [];
    const at = siblings.findIndex((e) => e.id === id);
    const backdropTag = strArr(item.ParentBackdropImageTags)[0] ?? null;
    return {
      ...episode,
      backdrop: str(item.ParentBackdropItemId)
        ? this.imageUrl(String(item.ParentBackdropItemId), 'Backdrop', backdropTag, 0)
        : null,
      previousId: at > 0 ? siblings[at - 1]!.id : null,
      nextId: at >= 0 && at + 1 < siblings.length ? siblings[at + 1]!.id : null,
    };
  }

  async nextUp(ctx: UserContext): Promise<Episode[]> {
    const params = new URLSearchParams({
      userId: ctx.userId,
      limit: '24',
      fields: EPISODE_FIELDS,
      enableUserData: 'true',
      enableResumable: 'true',
      enableRewatching: 'false',
      enableImageTypes: 'Primary,Thumb,Backdrop',
      imageTypeLimit: '1',
    });
    const data = await this.json(`/Shows/NextUp?${params}`, { ctx });
    return arr(data.Items).map((item) => this.mapEpisode(item));
  }

  async getUserState(ctx: UserContext, id: string): Promise<MovieUserState> {
    const item = await this.json(
      `/Items/${encodeURIComponent(id)}?${new URLSearchParams({ userId: ctx.userId })}`,
      { ctx },
    );
    return this.mapUserState(item);
  }

  async setFavorite(ctx: UserContext, id: string, favorite: boolean): Promise<MovieUserState> {
    await this.json(`/UserFavoriteItems/${encodeURIComponent(id)}?userId=${ctx.userId}`, {
      ctx,
      method: favorite ? 'POST' : 'DELETE',
    });
    return this.getUserState(ctx, id);
  }

  async setPlayed(ctx: UserContext, id: string, played: boolean): Promise<MovieUserState> {
    await this.json(`/UserPlayedItems/${encodeURIComponent(id)}?userId=${ctx.userId}`, {
      ctx,
      method: played ? 'POST' : 'DELETE',
    });
    return this.getUserState(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Playback

  async getPlayback(
    ctx: UserContext,
    id: string,
    request: PlaybackRequest,
    prefs: { maxBitrate: number | null; preferDirectPlay: boolean },
  ): Promise<PlaybackInfo> {
    const caps = sanitizeCapabilities(request.capabilities);
    const startSeconds = Math.max(0, Number(request.startSeconds) || 0);
    const audioIndex = request.audioStreamIndex ?? null;
    const subtitleIndex = request.subtitleStreamIndex ?? null;
    const allowDirect = prefs.preferDirectPlay && !request.forceTranscode;
    // Jellyfin ignores audio/subtitle track choices unless a media source is named
    // (verified against 12.2), so default to the item's primary source.
    const requestedSource =
      request.mediaSourceId ?? (audioIndex != null || subtitleIndex != null ? id : undefined);
    const body = {
      UserId: ctx.userId,
      DeviceProfile: buildDeviceProfile(caps, prefs.maxBitrate),
      MaxStreamingBitrate: prefs.maxBitrate ?? 120_000_000,
      StartTimeTicks: Math.round(startSeconds * TICKS_PER_SECOND),
      MediaSourceId: requestedSource,
      AudioStreamIndex: audioIndex ?? undefined,
      SubtitleStreamIndex: subtitleIndex ?? undefined,
      EnableDirectPlay: allowDirect,
      EnableDirectStream: true,
      EnableTranscoding: true,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      AutoOpenLiveStream: true,
    };
    const data = await this.json(
      `/Items/${encodeURIComponent(id)}/PlaybackInfo?userId=${ctx.userId}`,
      { ctx, method: 'POST', body },
    );
    if (str(data.ErrorCode)) {
      throw new ApiError(
        'MEDIA_UNAVAILABLE',
        data.ErrorCode === 'NotAllowed'
          ? 'Your Jellyfin account is not allowed to play this item.'
          : `Jellyfin could not provide a playable stream (${String(data.ErrorCode)}).`,
      );
    }
    const source = arr(data.MediaSources)[0];
    if (!source) throw new ApiError('MEDIA_UNAVAILABLE', 'This video has no playable media file.');
    const mediaSourceId = String(source.Id);
    const playSessionId = str(data.PlaySessionId) ?? randomUUID().replace(/-/g, '');
    const streams = arr(source.MediaStreams);
    const runtimeTicks = num(source.RunTimeTicks);

    let method: PlaybackInfo['method'];
    let delivery: PlaybackInfo['delivery'];
    let url: string;
    let transcodeReasons: string[] = [];

    if (allowDirect && source.SupportsDirectPlay === true) {
      method = 'DirectPlay';
      delivery = 'file';
      const params = new URLSearchParams({
        static: 'true',
        mediaSourceId,
        playSessionId,
        deviceId: ctx.deviceId,
      });
      if (str(source.ETag)) params.set('tag', String(source.ETag));
      url = `/jf/Videos/${id}/stream?${params}`;
    } else if (str(source.TranscodingUrl)) {
      const transcodingUrl = new URL(String(source.TranscodingUrl), 'http://jellyfin.local');
      // The proxy injects credentials; never expose the token to the browser.
      for (const key of [...transcodingUrl.searchParams.keys()]) {
        if (key.toLowerCase() === 'api_key' || key.toLowerCase() === 'apikey') {
          transcodingUrl.searchParams.delete(key);
        }
      }
      transcodeReasons = (transcodingUrl.searchParams.get('TranscodeReasons') ?? '')
        .split(',')
        .filter(Boolean);
      const containerOnly = transcodeReasons.every((r) => r.startsWith('Container'));
      method = containerOnly ? 'DirectStream' : 'Transcode';
      delivery = transcodingUrl.pathname.endsWith('.m3u8') ? 'hls' : 'file';
      url = `/jf${transcodingUrl.pathname}${transcodingUrl.search}`;
    } else {
      throw new ApiError(
        'MEDIA_UNAVAILABLE',
        'Jellyfin found no compatible way to stream this file.',
      );
    }

    const subtitles: SubtitleDelivery[] = streams
      .filter((s) => s.Type === 'Subtitle')
      .map((s) => {
        const track = this.mapTrack(s);
        let subUrl: string | null = null;
        if (!track.isImageBased) {
          const deliveryUrl = str(s.DeliveryUrl);
          subUrl =
            deliveryUrl && s.DeliveryMethod === 'External' && deliveryUrl.endsWith('.vtt')
              ? `/jf${deliveryUrl.split('?')[0]}`
              : `/jf/Videos/${id}/${mediaSourceId}/Subtitles/${track.index}/0/Stream.vtt`;
        }
        return { ...track, url: subUrl };
      });

    const audioTracks = streams.filter((s) => s.Type === 'Audio').map((s) => this.mapTrack(s));
    const defaultAudio = num(source.DefaultAudioStreamIndex);
    const defaultSub = num(source.DefaultSubtitleStreamIndex);

    return {
      itemId: id,
      mediaSourceId,
      playSessionId,
      method,
      delivery,
      url,
      startSeconds,
      durationSeconds: runtimeTicks ? runtimeTicks / TICKS_PER_SECOND : null,
      audioTracks,
      subtitles,
      selectedAudioIndex: audioIndex ?? defaultAudio,
      selectedSubtitleIndex:
        subtitleIndex ?? (defaultSub != null && defaultSub >= 0 ? defaultSub : null),
      isSample: false,
      transcodeReasons,
    };
  }

  async reportPlayback(
    ctx: UserContext,
    event: 'start' | 'progress' | 'stop',
    report: PlaybackReport,
  ): Promise<void> {
    const path =
      event === 'start'
        ? '/Sessions/Playing'
        : event === 'progress'
          ? '/Sessions/Playing/Progress'
          : '/Sessions/Playing/Stopped';
    const response = await this.request(path, {
      ctx,
      method: 'POST',
      body: {
        ItemId: report.itemId,
        MediaSourceId: report.mediaSourceId,
        PlaySessionId: report.playSessionId,
        PositionTicks: Math.round(Math.max(0, report.positionSeconds) * TICKS_PER_SECOND),
        IsPaused: report.isPaused,
        CanSeek: true,
        PlayMethod: report.method,
        AudioStreamIndex: report.audioStreamIndex ?? undefined,
        SubtitleStreamIndex: report.subtitleStreamIndex ?? undefined,
        EventName: event === 'progress' ? (report.isPaused ? 'Pause' : 'TimeUpdate') : undefined,
      },
    });
    if (!response.ok) {
      throw new ApiError(
        'MEDIA_SERVER_ERROR',
        `Jellyfin rejected the playback report (${response.status}).`,
      );
    }
  }
}
