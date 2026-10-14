import { describe, expect, it } from 'vitest';
import { CatalogCache } from '../../src/server/catalog';
import { ApiError } from '../../src/server/errors';
import { buildDeviceProfile, sanitizeCapabilities } from '../../src/server/providers/deviceProfile';
import { JellyfinProvider } from '../../src/server/providers/jellyfin';
import type { UserContext } from '../../src/server/providers/types';
import { isAllowedMediaPath } from '../../src/server/proxy';

const ctx: UserContext = {
  userId: 'u1',
  userName: 'owner',
  token: 'secret-token',
  deviceId: 'dev-1',
  deviceName: 'iPhone · Safari',
};

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ITEM = {
  Id: 'aea5ae7dc441a6d46e9c44a8fa2cf43d',
  Name: 'Harbor Lights',
  SortName: 'Harbor Lights',
  Type: 'Movie',
  ProductionYear: 2019,
  RunTimeTicks: 54_000_000_000, // 90 minutes
  Genres: ['Drama'],
  People: [
    { Name: 'Clara Testa', Type: 'Director', Id: 'p1' },
    { Name: 'Ada Test', Type: 'Actor', Role: 'Lead', Id: 'p2', PrimaryImageTag: 'tag2' },
  ],
  ProductionLocations: ['Japan'],
  Studios: [{ Name: 'Test Studio' }],
  ImageTags: { Primary: 'ptag' },
  BackdropImageTags: ['btag'],
  UserData: {
    Played: false,
    IsFavorite: true,
    PlaybackPositionTicks: 18_000_000_000,
    PlayCount: 1,
  },
  LocationType: 'FileSystem',
};

describe('JellyfinProvider', () => {
  it('lists household profiles for the "Who\'s watching?" screen', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.pathname === '/Users/Public'
        ? json([
            {
              Name: 'Evan',
              Id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
              HasPassword: true,
              PrimaryImageTag: 'av1',
            },
            { Name: 'Kids', Id: 'ffffffffffffffffffffffffffffffff', HasPassword: false },
            { Name: '', Id: 'broken' },
          ])
        : new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
    );
    const jf = new JellyfinProvider('http://jf.test', '1.0.0', impl);
    expect(await jf.publicProfiles()).toEqual([
      {
        id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        name: 'Evan',
        hasPassword: true,
        image: '/api/auth/profiles/a1b2c3d4e5f60718293a4b5c6d7e8f90/avatar?tag=av1',
      },
      { id: 'ffffffffffffffffffffffffffffffff', name: 'Kids', hasPassword: false, image: null },
    ]);
    const avatar = await jf.profileImage('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(avatar?.headers.get('content-type')).toBe('image/png');
    expect(calls.at(-1)!.url.pathname).toBe(
      '/Users/a1b2c3d4e5f60718293a4b5c6d7e8f90/Images/Primary',
    );
    // Only well-formed ids are passed through to Jellyfin.
    expect(await jf.profileImage('../System/Info')).toBeNull();
  });

  it('signs in and sends a well-formed MediaBrowser authorization header', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({
        User: { Id: 'u1', Name: 'owner', Policy: { IsAdministrator: true } },
        AccessToken: 'tok',
      }),
    );
    const provider = new JellyfinProvider('http://jf.local:8096', '1.0.0', impl);
    const result = await provider.authenticate('owner', 'pw', {
      deviceId: 'd1',
      deviceName: 'Mac · Chrome',
    });
    expect(result).toEqual({ user: { id: 'u1', name: 'owner', isAdmin: true }, token: 'tok' });
    const header = (calls[0]!.init.headers as Record<string, string>).Authorization!;
    expect(header).toMatch(
      /^MediaBrowser Client="Wheelhouse", Device="Mac%20%C2%B7%20Chrome", DeviceId="d1", Version="1.0.0"$/,
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ Username: 'owner', Pw: 'pw' });
  });

  it('maps bad credentials, expired tokens and outages to distinct errors', async () => {
    const denied = new JellyfinProvider(
      'http://jf.local',
      '1',
      fakeFetch(() => new Response('', { status: 401 })).impl,
    );
    await expect(
      denied.authenticate('a', 'b', { deviceId: 'd', deviceName: 'n' }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(denied.listMovies(ctx)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    const down = new JellyfinProvider(
      'http://jf.local',
      '1',
      fakeFetch(() => {
        throw new TypeError('fetch failed');
      }).impl,
    );
    await expect(down.listMovies(ctx)).rejects.toMatchObject({ code: 'MEDIA_SERVER_UNREACHABLE' });
    const info = await down.serverInfo();
    expect(info.reachable).toBe(false);
  });

  it('reads server info from camelCase responses (Jellyfin 12 public endpoint)', async () => {
    const provider = new JellyfinProvider(
      'http://jf.local',
      '1',
      fakeFetch(() => json({ serverName: 'Living Room', version: '12.2.0' })).impl,
    );
    expect(await provider.serverInfo()).toMatchObject({
      reachable: true,
      name: 'Living Room',
      version: '12.2.0',
    });
  });

  it('maps library items, keeping Jellyfin ids and never inventing metadata', async () => {
    const sparse = {
      Id: 'x2',
      Name: 'Untitled Home Video',
      Type: 'Movie',
      LocationType: 'Virtual',
    };
    const { impl, calls } = fakeFetch(() => json({ Items: [ITEM, sparse], TotalRecordCount: 2 }));
    const provider = new JellyfinProvider('http://jf.local', '1', impl);
    const [movie, home] = await provider.listMovies(ctx);
    expect(calls[0]!.url.searchParams.get('includeItemTypes')).toBe('Movie');
    expect(movie).toMatchObject({
      id: ITEM.Id,
      title: 'Harbor Lights',
      year: 2019,
      runtimeMinutes: 90,
      directors: ['Clara Testa'],
      countries: ['Japan'],
      studios: ['Test Studio'],
      available: true,
      images: {
        poster: `/jf/Items/${ITEM.Id}/Images/Primary?tag=ptag`,
        backdrop: `/jf/Items/${ITEM.Id}/Images/Backdrop/0?tag=btag`,
        logo: null,
      },
    });
    expect(movie!.user).toMatchObject({ favorite: true, positionSeconds: 1800, played: false });
    expect(movie!.user.progress).toBeCloseTo(1 / 3);
    expect(home).toMatchObject({
      year: null,
      runtimeMinutes: null,
      overview: null,
      genres: [],
      available: false,
    });
    expect(home!.images.poster).toBeNull();
  });

  it('pages through large libraries', async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...ITEM,
        Id: `id${start + i}`,
        Name: `Movie ${start + i}`,
      }));
    const { impl, calls } = fakeFetch((url) => {
      const start = Number(url.searchParams.get('startIndex'));
      return json({ Items: page(start, start === 0 ? 500 : 120), TotalRecordCount: 620 });
    });
    const movies = await new JellyfinProvider('http://jf.local', '1', impl).listMovies(ctx);
    expect(movies).toHaveLength(620);
    expect(calls).toHaveLength(2);
  });

  it('lists box sets as film series with their movies', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.searchParams.get('includeItemTypes') === 'BoxSet') {
        return json({
          Items: [
            {
              Id: 'set1',
              Name: 'Star Wars Collection',
              ImageTags: { Primary: 'p1' },
              BackdropImageTags: ['b1'],
            },
          ],
        });
      }
      expect(url.searchParams.get('parentId')).toBe('set1');
      return json({ Items: [{ Id: 'm1' }, { Id: 'm2' }] });
    });
    const [series] = await new JellyfinProvider('http://jf.local', '1', impl).listFranchises(ctx);
    expect(series).toMatchObject({
      id: 'set1',
      name: 'Star Wars Collection',
      movieIds: ['m1', 'm2'],
    });
    expect(series!.poster).toContain('/Items/set1/Images/Primary');
    expect(series!.backdrop).toContain('/Items/set1/Images/Backdrop');
    expect(calls).toHaveLength(2);
  });

  it('returns a direct-play URL when the browser supports the file', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({
        PlaySessionId: 'ps1',
        MediaSources: [
          {
            Id: 'ms1',
            ETag: 'etag1',
            SupportsDirectPlay: true,
            RunTimeTicks: 900_000_000,
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
              { Type: 'Video', Index: 0, Codec: 'h264' },
              {
                Type: 'Audio',
                Index: 1,
                Codec: 'aac',
                Language: 'eng',
                IsDefault: true,
                DisplayTitle: 'English',
              },
              { Type: 'Subtitle', Index: 2, Codec: 'subrip', Language: 'eng', IsExternal: true },
              { Type: 'Subtitle', Index: 3, Codec: 'PGSSUB', Language: 'fre' },
            ],
          },
        ],
      }),
    );
    const provider = new JellyfinProvider('http://jf.local', '1', impl);
    const info = await provider.getPlayback(
      ctx,
      'item1',
      { capabilities: { mp4VideoCodecs: ['h264'], audioCodecs: ['aac'] } as never },
      { maxBitrate: 4_000_000, preferDirectPlay: true },
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.DeviceProfile.MaxStreamingBitrate).toBe(4_000_000);
    expect(body.EnableDirectPlay).toBe(true);
    expect(info.method).toBe('DirectPlay');
    expect(info.url).toBe(
      '/jf/Videos/item1/stream?static=true&mediaSourceId=ms1&playSessionId=ps1&deviceId=dev-1&tag=etag1',
    );
    expect(info.url).not.toContain('secret-token');
    expect(info.subtitles[0]).toMatchObject({
      index: 2,
      url: '/jf/Videos/item1/ms1/Subtitles/2/0/Stream.vtt',
    });
    expect(info.subtitles[1]).toMatchObject({ index: 3, isImageBased: true, url: null });
    expect(info.durationSeconds).toBe(90);
  });

  it('uses Jellyfin’s HLS transcoding URL with the API key removed', async () => {
    const provider = new JellyfinProvider(
      'http://jf.local',
      '1',
      fakeFetch(() =>
        json({
          PlaySessionId: 'ps2',
          MediaSources: [
            {
              Id: 'ms2',
              SupportsDirectPlay: false,
              TranscodingUrl:
                '/videos/39d3f0bf-54fc-fbd6-ff05-b415d574acab/master.m3u8?DeviceId=d&ApiKey=secret-token&api_key=secret-token&TranscodeReasons=ContainerNotSupported%2CVideoCodecNotSupported',
              MediaStreams: [],
            },
          ],
        }),
      ).impl,
    );
    const info = await provider.getPlayback(
      ctx,
      'item2',
      { capabilities: {} as never },
      { maxBitrate: null, preferDirectPlay: true },
    );
    expect(info.delivery).toBe('hls');
    expect(info.method).toBe('Transcode');
    expect(info.transcodeReasons).toEqual(['ContainerNotSupported', 'VideoCodecNotSupported']);
    expect(
      info.url.startsWith('/jf/videos/39d3f0bf-54fc-fbd6-ff05-b415d574acab/master.m3u8?'),
    ).toBe(true);
    expect(info.url.toLowerCase()).not.toContain('secret-token');
    expect(isAllowedMediaPath(info.url.slice(3).split('?')[0]!)).toBe(true);
  });

  it('labels container-only conversions as direct stream (remux)', async () => {
    const provider = new JellyfinProvider(
      'http://jf.local',
      '1',
      fakeFetch(() =>
        json({
          MediaSources: [
            {
              Id: 'm',
              TranscodingUrl: '/videos/abc/master.m3u8?TranscodeReasons=ContainerNotSupported',
              MediaStreams: [],
            },
          ],
        }),
      ).impl,
    );
    const info = await provider.getPlayback(
      ctx,
      'i',
      { capabilities: {} as never },
      { maxBitrate: null, preferDirectPlay: true },
    );
    expect(info.method).toBe('DirectStream');
  });

  it('surfaces Jellyfin playback refusals as MEDIA_UNAVAILABLE', async () => {
    const provider = new JellyfinProvider(
      'http://jf.local',
      '1',
      fakeFetch(() => json({ ErrorCode: 'NotAllowed' })).impl,
    );
    await expect(
      provider.getPlayback(
        ctx,
        'i',
        { capabilities: {} as never },
        { maxBitrate: null, preferDirectPlay: true },
      ),
    ).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
  });

  it('reports playback progress in ticks', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await new JellyfinProvider('http://jf.local', '1', impl).reportPlayback(ctx, 'progress', {
      itemId: 'i',
      mediaSourceId: 'm',
      playSessionId: 'p',
      positionSeconds: 12.5,
      isPaused: true,
      method: 'DirectPlay',
    });
    expect(calls[0]!.url.pathname).toBe('/Sessions/Playing/Progress');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      PositionTicks: 125_000_000,
      IsPaused: true,
      EventName: 'Pause',
    });
  });
});

describe('device profile', () => {
  it('only trusts known codec names and falls back to H.264/AAC', () => {
    const caps = sanitizeCapabilities({
      mp4VideoCodecs: ['h264', '<script>'],
      audioCodecs: [],
      maxAudioChannels: 99,
    });
    expect(caps.mp4VideoCodecs).toEqual(['h264']);
    expect(caps.audioCodecs).toEqual(['aac', 'mp3']);
    expect(caps.maxAudioChannels).toBe(8);
    expect(sanitizeCapabilities(null).mp4VideoCodecs).toEqual(['h264']);
  });

  it('transcodes to HEVC only for native-HLS browsers that decode it', () => {
    const safari = buildDeviceProfile(
      sanitizeCapabilities({ mp4VideoCodecs: ['h264', 'hevc'], nativeHls: true }),
      null,
    );
    const chrome = buildDeviceProfile(
      sanitizeCapabilities({ mp4VideoCodecs: ['h264', 'hevc'], nativeHls: false }),
      null,
    );
    expect(safari.TranscodingProfiles[0]!.VideoCodec).toBe('h264,hevc');
    expect(chrome.TranscodingProfiles[0]!.VideoCodec).toBe('h264');
    expect(safari.DirectPlayProfiles[0]!.VideoCodec).toBe('h264,hevc');
  });
});

describe('media proxy allowlist', () => {
  it.each([
    '/Videos/aea5ae7dc441a6d46e9c44a8fa2cf43d/stream',
    '/Videos/aea5ae7dc441a6d46e9c44a8fa2cf43d/stream.mp4',
    '/videos/39d3f0bf-54fc-fbd6-ff05-b415d574acab/master.m3u8',
    '/videos/39d3f0bf-54fc-fbd6-ff05-b415d574acab/main.m3u8',
    '/videos/39d3f0bf-54fc-fbd6-ff05-b415d574acab/hls1/main/0.ts',
    '/Videos/aea5ae7dc441a6d46e9c44a8fa2cf43d/aea5ae7dc441a6d46e9c44a8fa2cf43d/Subtitles/2/0/Stream.vtt',
    '/Items/aea5ae7dc441a6d46e9c44a8fa2cf43d/Images/Primary',
    '/Items/aea5ae7dc441a6d46e9c44a8fa2cf43d/Images/Backdrop/0',
  ])('allows %s', (path) => expect(isAllowedMediaPath(path)).toBe(true));

  it.each([
    '/System/Info',
    '/Users',
    '/Items/aea5ae7dc441a6d46e9c44a8fa2cf43d/Download',
    '/Items/aea5ae7dc441a6d46e9c44a8fa2cf43d/File',
    '/Videos/aea5ae7dc441a6d46e9c44a8fa2cf43d/../../System/Info',
    '/Videos/not-an-id/stream',
    '/Library/VirtualFolders',
    '/Items/aea5ae7dc441a6d46e9c44a8fa2cf43d/Images/Primary/../../../Users',
  ])('blocks %s', (path) => expect(isAllowedMediaPath(path)).toBe(false));
});

describe('catalog cache', () => {
  it('serves the last good index (marked stale) while the media server is down', async () => {
    let up = true;
    let calls = 0;
    const provider = {
      listMovies: async () => {
        calls++;
        if (!up) throw new ApiError('MEDIA_SERVER_UNREACHABLE', 'down');
        return [{ id: 'a' }];
      },
    } as never;
    const cache = new CatalogCache(provider, 0);
    expect((await cache.get(ctx)).stale).toBe(false);
    up = false;
    const snap = await cache.get(ctx);
    expect(snap.stale).toBe(true);
    expect(snap.movies).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('fails clearly with no cache, and never hides an expired session', async () => {
    const down = new CatalogCache(
      {
        listMovies: async () => {
          throw new ApiError('MEDIA_SERVER_UNREACHABLE', 'down');
        },
      } as never,
      1000,
    );
    await expect(down.get(ctx)).rejects.toMatchObject({ code: 'MEDIA_SERVER_UNREACHABLE' });
    let expired = false;
    const cache = new CatalogCache(
      {
        listMovies: async () => {
          if (expired) throw new ApiError('SESSION_EXPIRED', 'x');
          return [];
        },
      } as never,
      0,
    );
    await cache.get(ctx);
    expired = true;
    await expect(cache.get(ctx)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('collapses concurrent loads into one request', async () => {
    let calls = 0;
    const cache = new CatalogCache(
      {
        listMovies: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 20));
          return [];
        },
      } as never,
      60_000,
    );
    await Promise.all([cache.get(ctx), cache.get(ctx), cache.get(ctx)]);
    expect(calls).toBe(1);
  });
});

describe('catalog cache staleness', () => {
  it('stays flagged stale after a failed forced refresh until a refresh succeeds', async () => {
    let up = true;
    const cache = new CatalogCache(
      {
        listMovies: async () => {
          if (!up) throw new ApiError('MEDIA_SERVER_UNREACHABLE', 'down');
          return [];
        },
      } as never,
      60_000,
    );
    await cache.get(ctx);
    up = false;
    expect((await cache.get(ctx, { force: true })).stale).toBe(true);
    expect((await cache.get(ctx)).stale).toBe(true);
    up = true;
    expect((await cache.get(ctx, { force: true })).stale).toBe(false);
    expect((await cache.get(ctx)).stale).toBe(false);
  });
});

describe('track selection', () => {
  it('names the media source whenever a track is chosen (Jellyfin ignores the index otherwise)', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ MediaSources: [{ Id: 'ms', SupportsDirectPlay: true, MediaStreams: [] }] }),
    );
    const provider = new JellyfinProvider('http://jf.local', '1', impl);
    const prefs = { maxBitrate: null, preferDirectPlay: true };
    await provider.getPlayback(ctx, 'item9', { capabilities: {} as never }, prefs);
    await provider.getPlayback(
      ctx,
      'item9',
      { capabilities: {} as never, audioStreamIndex: 2 },
      prefs,
    );
    await provider.getPlayback(
      ctx,
      'item9',
      { capabilities: {} as never, mediaSourceId: 'other', subtitleStreamIndex: 3 },
      prefs,
    );
    const bodies = calls.map((c) => JSON.parse(String(c.init.body)));
    expect(bodies[0].MediaSourceId).toBeUndefined();
    expect(bodies[1]).toMatchObject({ MediaSourceId: 'item9', AudioStreamIndex: 2 });
    expect(bodies[2]).toMatchObject({ MediaSourceId: 'other', SubtitleStreamIndex: 3 });
  });
});
