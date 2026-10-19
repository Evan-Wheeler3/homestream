import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isBrowserPlayable, parseScan } from '../../src/server/cloud/probe';
import { CloudClient, publishEpisode, publishMovie } from '../../src/server/cloud/publish';
import { R2Uploader, type MultipartState } from '../../src/server/cloud/r2';
import {
  confidentMatch,
  parseEpisodeFile,
  parseFolderName,
  Tmdb,
} from '../../src/server/cloud/tmdb';
import type { Runner } from '../../src/server/ripper/process';
import { checkTiming, toWebVtt } from '../../src/shared/subtitles';
import { cloud, MAC_TOKEN, type FakeR2 } from '../cloud/fakes';

const SCAN = `Scanning title 1 of 1, 0.00 %Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/Volumes/LaCie/Movies/Pulp Fiction (1994) [tmdbid-680]/Pulp Fiction (1994).mp4':
  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(tv, smpte170m/smpte170m/bt709, progressive), 706x368 [SAR 32:27 DAR 1412:621], 695 kb/s, 24.15 fps, 120 tbr, 90k tbn (default)
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 163 kb/s (default)
  Stream #0:2[0x3](und): Data: bin_data (text / 0x74786574)
  + duration: 02:34:22`;

describe('reading video files', () => {
  it('reads codecs, size and length from a HandBrake scan', () => {
    const p = parseScan(SCAN);
    expect(p).toMatchObject({
      videoCodec: 'h264',
      width: 706,
      height: 368,
      audioCodecs: ['aac'],
      audioLanguages: ['eng'],
      audioChannels: [2],
      durationSeconds: 9262,
    });
    expect(isBrowserPlayable(p)).toBe(true);
    expect(isBrowserPlayable(parseScan(SCAN.replace('Video: h264', 'Video: mpeg2video')))).toBe(
      false,
    );
    expect(isBrowserPlayable(parseScan(SCAN.replace('Audio: aac', 'Audio: ac3')))).toBe(false);
    expect(
      isBrowserPlayable(parseScan(SCAN.replace('mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm'))),
    ).toBe(false);
  });

  it('reads folder names and only picks a TMDB match when it is clear', () => {
    expect(parseFolderName('Pulp Fiction (1994) [tmdbid-680]')).toEqual({
      title: 'Pulp Fiction',
      year: 1994,
      tmdbId: '680',
    });
    expect(parseFolderName('Young Frankenstein (1974)')).toEqual({
      title: 'Young Frankenstein',
      year: 1974,
      tmdbId: null,
    });
    const r = (id: number, title: string, year: number | null) => ({
      id,
      title,
      year,
      overview: '',
      popularity: 1,
    });
    expect(
      confidentMatch(
        [r(3034, 'Young Frankenstein', 1974), r(9, 'Young Frankenstein', 2013)],
        'Young Frankenstein',
        1974,
      )?.id,
    ).toBe(3034);
    expect(
      confidentMatch([r(1, 'Godzilla', 2014), r(2, 'Godzilla', 1954)], 'Godzilla', null),
    ).toBeNull();
    expect(confidentMatch([r(1, 'Something Else', 1974)], 'Young Frankenstein', 1974)).toBeNull();
  });
});

describe('subtitles', () => {
  const srt = Array.from({ length: 40 }, (_, i) => {
    const s = 60 + i * 120;
    const t = (x: number) =>
      `${String(Math.floor(x / 3600)).padStart(2, '0')}:${String(Math.floor((x % 3600) / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')},500`;
    return `${i + 1}\n${t(s)} --> ${t(s + 2)}\nLine ${i + 1} & <i>more</i>{\\an8}\n`;
  }).join('\n');

  it('converts SRT to WebVTT for browsers', () => {
    const vtt = toWebVtt(srt);
    expect(vtt.startsWith('WEBVTT\n')).toBe(true);
    expect(vtt).toContain('00:01:00.500 --> 00:01:02.500\nLine 1 &amp; <i>more</i>\n');
    expect(toWebVtt(srt, -0.5)).toContain('00:01:00.000 --> 00:01:02.000');
  });

  it('checks the timing fits the movie', () => {
    expect(checkTiming(srt, 4900).ok).toBe(true);
    expect(checkTiming(srt, 2000).reason).toMatch(/past the end/);
    expect(checkTiming(srt, 20_000).reason).toMatch(/long before/);
    expect(checkTiming('1\n00:00:01,000 --> 00:00:02,000\nHi\n', 100).ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// A stand-in for R2's S3 API, storing into the same fake bucket the Worker reads.

function fakeS3(bucket: FakeR2) {
  const uploads = new Map<
    string,
    { key: string; parts: Map<number, Buffer>; meta: Record<string, string> }
  >();
  const meta = new Map<string, { etag: string; meta: Record<string, string> }>();
  const log: string[] = [];
  const faults = { failPart: 0, failTimes: 0, damagePart: 0 };
  let next = 0;
  const md5 = (b: Buffer) => createHash('md5').update(b).digest();

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    const q = url.searchParams;
    const body = Buffer.from(await req.arrayBuffer());
    log.push(`${req.method} ${key}${url.search}`);
    if (!req.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256'))
      return new Response('', { status: 403 });

    if (req.method === 'HEAD') {
      const o = bucket.objects.get(key);
      if (!o) return new Response(null, { status: 404 });
      const m = meta.get(key);
      const headers = new Headers({
        'content-length': String(o.data.length),
        etag: `"${m?.etag ?? md5(Buffer.from(o.data)).toString('hex')}"`,
      });
      for (const [k, v] of Object.entries(m?.meta ?? {})) headers.set(`x-amz-meta-${k}`, v);
      return new Response(null, { status: 200, headers });
    }
    if (req.method === 'POST' && q.has('uploads')) {
      const id = `upload-${++next}`;
      const m: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        if (k.startsWith('x-amz-meta-')) m[k.slice(11)] = v;
      });
      uploads.set(id, { key, parts: new Map(), meta: m });
      return new Response(
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (req.method === 'PUT' && q.has('partNumber')) {
      const up = uploads.get(q.get('uploadId')!)!;
      const n = Number(q.get('partNumber'));
      if (n === faults.failPart && faults.failTimes > 0) {
        faults.failTimes--;
        return new Response('slow down', { status: 503 });
      }
      if (req.headers.get('content-md5') !== md5(body).toString('base64'))
        return new Response('bad md5', { status: 400 });
      up.parts.set(n, body);
      const etag = n === faults.damagePart ? '0'.repeat(32) : md5(body).toString('hex');
      return new Response(null, { headers: { etag: `"${etag}"` } });
    }
    if (req.method === 'GET' && q.has('uploadId')) {
      const up = uploads.get(q.get('uploadId')!);
      if (!up) return new Response('<Error>NoSuchUpload</Error>', { status: 404 });
      const parts = [...up.parts].map(
        ([n, b]) =>
          `<Part><PartNumber>${n}</PartNumber><ETag>&quot;${md5(b).toString('hex')}&quot;</ETag></Part>`,
      );
      return new Response(`<ListPartsResult>${parts.join('')}</ListPartsResult>`);
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const up = uploads.get(q.get('uploadId')!)!;
      const order = [...up.parts.keys()].sort((a, b) => a - b);
      const data = Buffer.concat(order.map((n) => up.parts.get(n)!));
      await bucket.put(key, data, { httpMetadata: { contentType: 'video/mp4' } });
      const etag = `${md5(Buffer.concat(order.map((n) => md5(up.parts.get(n)!)))).toString('hex')}-${order.length}`;
      meta.set(key, { etag, meta: up.meta });
      return new Response('<CompleteMultipartUploadResult/>');
    }
    if (req.method === 'PUT') {
      if (req.headers.get('content-md5') !== md5(body).toString('base64'))
        return new Response('bad md5', { status: 400 });
      await bucket.put(key, body, {
        httpMetadata: { contentType: req.headers.get('content-type') ?? undefined },
      });
      meta.delete(key);
      return new Response(null);
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, log, faults };
}

const R2 = {
  accountId: 'acct',
  bucket: 'wheelhouse-media',
  accessKeyId: 'id',
  secretAccessKey: 'secret',
};

function tempVideo(bytes: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-upload-'));
  const file = path.join(dir, 'Pulp Fiction (1994).mp4');
  fs.writeFileSync(file, Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 7) % 256)));
  return file;
}

describe('uploading to R2', () => {
  it('uploads in parts, checks every part and the whole file, and resumes after a failure', async () => {
    const c = cloud();
    const s3 = fakeS3(c.media);
    const r2 = new R2Uploader(R2, s3.fetchImpl, 1000);
    r2.retryDelayMs = 1;
    const file = tempVideo(4500);
    let saved: MultipartState | null = null;

    s3.faults.failPart = 3;
    s3.faults.failTimes = 99;
    await expect(
      r2.uploadFile(file, 'movies/x/video.mp4', {
        contentType: 'video/mp4',
        metadata: { sha256: 'abc' },
        concurrency: 1,
        save: (s) => (saved = structuredClone(s)),
      }),
    ).rejects.toThrow(/part 3/);
    expect(Object.keys(saved!.parts).map(Number).sort()).toEqual([1, 2]);

    // Again: only the missing parts go up.
    s3.faults.failTimes = 0;
    s3.log.length = 0;
    const progress: number[] = [];
    await r2.uploadFile(file, 'movies/x/video.mp4', {
      contentType: 'video/mp4',
      state: saved,
      concurrency: 1,
      onProgress: (done) => progress.push(done),
    });
    expect(
      s3.log.filter((l) => l.includes('partNumber')).map((l) => /partNumber=(\d)/.exec(l)![1]),
    ).toEqual(['3', '4', '5']);
    expect(progress[0]).toBe(2000);
    expect(progress.at(-1)).toBe(4500);
    expect(Buffer.from(c.media.objects.get('movies/x/video.mp4')!.data)).toEqual(
      fs.readFileSync(file),
    );
    expect((await r2.head('movies/x/video.mp4'))!.meta.sha256).toBe('abc');
  });

  it('refuses a part that arrives damaged', async () => {
    const c = cloud();
    const s3 = fakeS3(c.media);
    const r2 = new R2Uploader(R2, s3.fetchImpl, 1000);
    s3.faults.damagePart = 2;
    await expect(
      r2.uploadFile(tempVideo(2500), 'movies/y/video.mp4', {
        contentType: 'video/mp4',
        concurrency: 1,
      }),
    ).rejects.toThrow(/damaged/);
  });
});

describe('putting a movie in the cloud', () => {
  it('uploads the video, artwork and subtitles, adds it to the library, and skips it next time', async () => {
    const c = cloud();
    const s3 = fakeS3(c.media);
    const r2 = new R2Uploader(R2, s3.fetchImpl, 1000);
    const file = tempVideo(3000);
    const run: Runner = async () => ({ code: 0, output: SCAN.replace('02:34:22', '00:01:00') });
    const image = new Uint8Array([0xff, 0xd8, 0xff, 9]);
    const tmdbFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://image.tmdb.org')) return new Response(image);
      return Response.json({
        id: 680,
        imdb_id: 'tt0110912',
        title: 'Pulp Fiction',
        original_title: 'Pulp Fiction',
        release_date: '1994-09-10',
        runtime: 154,
        genres: [{ name: 'Crime' }],
        overview: 'A burger-loving hit man…',
        vote_average: 8.49,
        production_countries: [{ name: 'United States of America' }],
        production_companies: [{ name: 'Miramax' }],
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        belongs_to_collection: null,
        credits: {
          cast: [
            {
              id: 8891,
              name: 'John Travolta',
              character: 'Vincent Vega',
              profile_path: '/jt.jpg',
              order: 0,
            },
          ],
          crew: [{ name: 'Quentin Tarantino', job: 'Director', department: 'Directing' }],
        },
        images: {
          logos: [{ file_path: '/logo.png', iso_639_1: 'en', vote_average: 5 }],
          posters: [],
        },
        videos: {
          results: [
            {
              site: 'YouTube',
              key: 'tGpTpVyI_OQ',
              type: 'Trailer',
              name: 'Trailer',
              official: true,
            },
          ],
        },
        release_dates: {
          results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R', type: 3 }] }],
        },
        keywords: { keywords: [] },
      });
    }) as typeof fetch;
    const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      c.app.fetch(new Request(input, init), c.env, {
        waitUntil() {},
        passThroughOnException() {},
      } as never)) as typeof fetch;
    const cloudClient = new CloudClient(
      { url: 'https://wheelhouse.example', macToken: MAC_TOKEN },
      appFetch,
    );
    const vtt = toWebVtt(
      Array.from(
        { length: 30 },
        (_, i) =>
          `${i + 1}\n00:00:${String(i + 10).padStart(2, '0')},000 --> 00:00:${String(i + 11).padStart(2, '0')},000\nLine ${i}\n`,
      ).join('\n'),
    );
    const deps = {
      run,
      handbrakeCli: 'HandBrakeCLI',
      r2,
      tmdb: new Tmdb('token', tmdbFetch),
      cloud: cloudClient,
      openSubtitles: null,
      workDir: os.tmpdir(),
      log: () => undefined,
    };
    const result = await publishMovie({ file, tmdbId: '680', discSubtitles: vtt }, deps);
    expect(result).toMatchObject({
      id: 'tmdb-680',
      title: 'Pulp Fiction',
      year: 1994,
      subtitles: 'disc',
      converted: false,
    });
    expect(result.url).toBe('https://wheelhouse.example/movie/tmdb-680');
    for (const key of [
      'movies/tmdb-680/video.mp4',
      'movies/tmdb-680/poster.jpg',
      'movies/tmdb-680/logo.png',
      'people/8891.jpg',
      'movies/tmdb-680/subtitles.eng.disc.vtt',
    ]) {
      expect(c.media.objects.has(key), key).toBe(true);
    }

    // Signed in, it's in the library and plays with its subtitles.
    const boot = (await (await c.mac('POST', '/bootstrap', { name: 'Evan' })).json()) as {
      url: string;
    };
    await c.call('POST', `/api/invites/${boot.url.split('/invite/')[1]}`, {
      body: { username: 'evan', password: 'long enough' },
    });
    const detail = (await (await c.call('GET', '/api/movies/tmdb-680')).json()) as {
      officialRating: string;
      directors: string[];
      cast: { name: string; image: string }[];
      trailers: { kind: string }[];
      mediaInfo: { videoCodec: string; width: number };
      images: { logo: string };
    };
    expect(detail).toMatchObject({
      officialRating: 'R',
      directors: ['Quentin Tarantino'],
      mediaInfo: { videoCodec: 'h264', width: 706 },
    });
    expect(detail.cast[0]).toMatchObject({
      name: 'John Travolta',
      image: '/api/media/people/8891.jpg',
    });
    expect(detail.trailers[0]!.kind).toBe('youtube');
    expect(detail.images.logo).toMatch(/^\/api\/media\/movies\/tmdb-680\/logo\.png\?v=/);
    const playback = (await (
      await c.call('POST', '/api/movies/tmdb-680/playback', { body: {} })
    ).json()) as {
      subtitles: { url: string }[];
    };
    expect((await c.call('GET', playback.subtitles[0]!.url)).status).toBe(200);

    // A second run uploads nothing new.
    s3.log.length = 0;
    await publishMovie({ file, tmdbId: '680' }, deps);
    expect(s3.log.some((l) => l.includes('partNumber') || l.startsWith('PUT'))).toBe(false);
    const after = (await (await c.mac('GET', '/movies')).json()) as {
      movies: { subtitle_status: string }[];
    };
    expect(after.movies[0]!.subtitle_status).toBe('disc');
  });
});

describe('putting TV episodes in the cloud', () => {
  it('reads episode numbers from file names', () => {
    expect(parseEpisodeFile('Breaking Bad S01E02.mp4')).toEqual({
      season: 1,
      episode: 2,
      endEpisode: null,
    });
    expect(parseEpisodeFile('Show S02E03-E04.mp4')).toEqual({
      season: 2,
      episode: 3,
      endEpisode: 4,
    });
    expect(parseEpisodeFile('Extras.mp4')).toBeNull();
  });

  it('uploads the show once and each episode, which then play for signed-in people', async () => {
    const c = cloud();
    const s3 = fakeS3(c.media);
    const r2 = new R2Uploader(R2, s3.fetchImpl, 1000);
    const run: Runner = async () => ({ code: 0, output: SCAN.replace('02:34:22', '00:47:00') });
    const image = new Uint8Array([0xff, 0xd8, 0xff, 9]);
    const tmdbCalls: string[] = [];
    const tmdbFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      tmdbCalls.push(url.replace(/\?.*$/, ''));
      if (url.startsWith('https://image.tmdb.org')) return new Response(image);
      if (url.includes('/season/1'))
        return Response.json({
          episodes: [1, 2].map((n) => ({
            season_number: 1,
            episode_number: n,
            name: n === 1 ? 'Pilot' : "Cat's in the Bag...",
            overview: 'Walt…',
            runtime: 47,
            air_date: '2008-01-20',
            still_path: `/still${n}.jpg`,
          })),
        });
      return Response.json({
        id: 1396,
        name: 'Breaking Bad',
        first_air_date: '2008-01-20',
        last_air_date: '2013-09-29',
        status: 'Ended',
        genres: [{ name: 'Drama' }],
        overview: 'A chemistry teacher…',
        vote_average: 8.9,
        poster_path: '/bb.jpg',
        backdrop_path: '/bbb.jpg',
        external_ids: { imdb_id: 'tt0903747' },
        content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
        aggregate_credits: {
          cast: [
            { id: 17419, name: 'Bryan Cranston', order: 0, roles: [{ character: 'Walter White' }] },
          ],
        },
        images: { logos: [] },
        seasons: [{ season_number: 1, name: 'Season 1', poster_path: '/s1.jpg', episode_count: 7 }],
      });
    }) as typeof fetch;
    const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      c.app.fetch(new Request(input, init), c.env, {
        waitUntil() {},
        passThroughOnException() {},
      } as never)) as typeof fetch;
    const deps = {
      run,
      handbrakeCli: 'HandBrakeCLI',
      r2,
      tmdb: new Tmdb('token', tmdbFetch),
      cloud: new CloudClient({ url: 'https://wheelhouse.example', macToken: MAC_TOKEN }, appFetch),
      openSubtitles: null,
      workDir: os.tmpdir(),
      log: () => undefined,
    };
    const first = await publishEpisode(
      { file: tempVideo(2000), showTmdbId: '1396', season: 1, episode: 1 },
      deps,
    );
    await publishEpisode(
      { file: tempVideo(2500), showTmdbId: '1396', season: 1, episode: 2 },
      deps,
    );
    expect(first).toMatchObject({
      id: 'tmdbtv-1396-s01e01',
      showId: 'tmdbtv-1396',
      title: 'S01E01 · Pilot',
      url: 'https://wheelhouse.example/show/tmdbtv-1396',
    });
    // The show and its season list were fetched once for both episodes.
    expect(tmdbCalls.filter((u) => u.endsWith('/tv/1396'))).toHaveLength(1);
    expect(tmdbCalls.filter((u) => u.endsWith('/season/1'))).toHaveLength(1);
    for (const key of [
      'shows/tmdbtv-1396/poster.jpg',
      'shows/tmdbtv-1396/season-01.jpg',
      'shows/tmdbtv-1396/tmdbtv-1396-s01e01.mp4',
      'shows/tmdbtv-1396/tmdbtv-1396-s01e02.jpg',
    ]) {
      expect(c.media.objects.has(key), key).toBe(true);
    }

    const boot = (await (await c.mac('POST', '/bootstrap', { name: 'Evan' })).json()) as {
      url: string;
    };
    await c.call('POST', `/api/invites/${boot.url.split('/invite/')[1]}`, {
      body: { username: 'evan', password: 'long enough' },
    });
    const show = (await (await c.call('GET', '/api/shows/tmdbtv-1396')).json()) as {
      title: string;
      endYear: number;
      officialRating: string;
      episodes: { title: string; image: string }[];
      cast: { name: string; role: string }[];
    };
    expect(show).toMatchObject({ title: 'Breaking Bad', endYear: 2013, officialRating: 'TV-MA' });
    expect(show.episodes.map((e) => e.title)).toEqual(['Pilot', "Cat's in the Bag..."]);
    expect(show.episodes[0]!.image).toMatch(
      /^\/api\/media\/shows\/tmdbtv-1396\/tmdbtv-1396-s01e01\.jpg/,
    );
    expect(show.cast[0]).toMatchObject({ name: 'Bryan Cranston', role: 'Walter White' });
    const playback = (await (
      await c.call('POST', '/api/movies/tmdbtv-1396-s01e02/playback', { body: {} })
    ).json()) as { url: string };
    expect((await c.call('GET', playback.url)).status).toBe(200);
  });
});
