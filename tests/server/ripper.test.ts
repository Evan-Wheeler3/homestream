import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRipperConfig } from '../../src/server/config';
import type { Runner } from '../../src/server/ripper/process';
import type { RipperCloud } from '../../src/server/ripper/ripper';
import type { Notification } from '../../src/server/ripper/services';
import { Client, startServer, type TestServer } from './helpers';

// End-to-end rehearsal of the disc pipeline with stand-ins for the parts that
// need real hardware or the internet: MakeMKV, HandBrake, the drive's eject,
// Jellyfin's API and ntfy.

const FEATURE = '1:45:12';
const FEATURE_SECONDS = 6312;

interface Disc {
  label: string;
  discName?: string;
  titles: { duration: string; segments?: string }[];
}

const seconds = (hms: string) => hms.split(':').reduce((t, n) => t * 60 + Number(n), 0);

function discInfo(disc: Disc) {
  const lines = [`CINFO:2,0,"${disc.discName ?? disc.label}"`, `CINFO:32,0,"${disc.label}"`];
  lines.push(`TCOUNT:${disc.titles.length}`);
  disc.titles.forEach((t, i) => {
    lines.push(`TINFO:${i},8,0,"24"`);
    lines.push(`TINFO:${i},9,0,"${t.duration}"`);
    lines.push(`TINFO:${i},11,0,"${4_000_000_000 - i}"`);
    lines.push(`TINFO:${i},26,0,"${t.segments ?? String(i)}"`);
    lines.push(`TINFO:${i},27,0,"title_t${String(i).padStart(2, '0')}.mkv"`);
  });
  return lines.join('\n');
}

class FakeHardware {
  disc: Disc | null = null;
  calls: string[] = [];
  failNextEncode = false;
  failNextInfo = false;
  /** Ripping gets stuck after analysing the disc, like on a scratched disc. */
  hangRip = false;
  /** Fail the nth compression (1-based), counting from now. */
  failEncodeNumber = 0;
  private encodes = 0;
  /** Pretend HandBrake's output is this long, whatever was ripped (an incomplete encode). */
  scanSeconds: number | null = null;
  /** Length of each compressed file, from the title it was ripped from. */
  private readonly lengths = new Map<string, number>();
  /** Called halfway through saving the title, to look at the job mid-rip. */
  midRip: (() => Promise<void>) | null = null;
  /** Makes makemkvcon die from this signal (e.g. a `pkill`) instead of finishing. */
  ripSignal: NodeJS.Signals | null = null;

  constructor(private readonly volumes: string) {}

  insert(disc: Disc) {
    this.disc = disc;
    fs.mkdirSync(path.join(this.volumes, disc.label, 'VIDEO_TS'), { recursive: true });
  }

  runner: Runner = async (command, args, options) => {
    this.calls.push([path.basename(command), ...args].join(' '));
    const tool = path.basename(command);
    const emit = (line: string) => options?.onLine?.(line);
    if (tool === 'makemkvcon') {
      if (args.includes('disc:9999')) {
        const output = this.disc
          ? `DRV:0,2,999,1,"USB DVD","${this.disc.label}","/dev/rdisk4"\nDRV:1,256,999,0,"","",""`
          : `DRV:0,0,999,1,"USB DVD","",""`;
        return { code: 0, output };
      }
      if (args.includes('info') && this.failNextInfo) {
        this.failNextInfo = false;
        return {
          code: 0,
          output: [
            'MSG:1011,0,1,"Using LibreDrive mode (v06.3 id=1)"',
            'MSG:2003,0,1,"Optical drive \\"DVD+R-DL Dell DVD+/-RW DW316\\" opened in OS access mode."',
            'MSG:5010,0,0,"Failed to open disc"',
          ].join('\n'),
        };
      }
      if (args.includes('info')) {
        return { code: 0, output: this.disc ? discInfo(this.disc) : 'MSG:5010,0,0,"No disc"' };
      }
      if (args.includes('mkv') && this.hangRip) {
        emit('PRGT:5018,0,"Analyzing seamless segments"');
        emit('PRGV:65536,65536,65536');
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      if (args.includes('mkv')) {
        const dir = args[args.length - 1]!;
        const title = Number(args[args.length - 2]);
        // Like real makemkvcon: opening the disc runs 0–100%, then saving starts again at 0.
        emit('PRGT:5018,0,"Opening DVD disc"');
        for (const p of [0, 2500, 65536]) emit(`PRGV:${p},${p},65536`);
        emit('PRGT:5017,0,"Saving to MKV file"');
        emit('PRGV:0,0,65536');
        emit('PRGV:32768,32768,65536');
        await this.midRip?.();
        if (this.ripSignal) {
          const output = 'MSG:5014,0,2,"Saving 1 titles into directory file:///rips"';
          return { code: null, signal: this.ripSignal, output };
        }
        emit('PRGV:65536,65536,65536');
        const length = seconds(this.disc?.titles[title]?.duration ?? FEATURE);
        fs.writeFileSync(path.join(dir, `title_t0${title}.mkv`), `mkv:${length}`);
        return { code: 0, output: 'MSG:5036,0,1,"Copy complete. 1 titles saved."' };
      }
    }
    if (tool === 'drutil') {
      if (this.disc) fs.rmSync(path.join(this.volumes, this.disc.label), { recursive: true });
      this.disc = null;
      return { code: 0, output: '' };
    }
    if (tool === 'HandBrakeCLI') {
      if (args[0] === '--scan') {
        const s = this.scanSeconds ?? this.lengths.get(args[2]!) ?? FEATURE_SECONDS;
        const hms = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
          .map((n, i) => (i ? String(n).padStart(2, '0') : String(n)))
          .join(':');
        return { code: 0, output: `[scan] title 1\n  + duration: ${hms}\n` };
      }
      const output = args[args.indexOf('-o') + 1]!;
      const input = fs.readFileSync(args[args.indexOf('-i') + 1]!, 'utf8');
      this.lengths.set(output, Number(input.split(':')[1]) || FEATURE_SECONDS);
      emit('Encoding: task 1 of 1, 50.00 % (120.1 fps, avg 118.0 fps, ETA 00h05m00s)');
      this.encodes++;
      if (this.failNextEncode || this.encodes === this.failEncodeNumber) {
        this.failNextEncode = false;
        fs.writeFileSync(output, 'partial');
        return { code: 3, output: 'Encode failed (error 3)' };
      }
      fs.writeFileSync(output, Buffer.alloc(2_000_000));
      emit('Encoding: task 1 of 1, 100.00 %');
      return { code: 0, output: 'Encode done!' };
    }
    if (tool === 'osascript') return { code: 0, output: '' };
    if (tool === 'pkill') return { code: 1, output: '' };
    throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', path: command });
  };
}

/** Just enough of Jellyfin's API for the ripper. */
function fakeJellyfin(
  movies: string,
  catalog: Record<string, { title: string; year: number; tmdb: string }[]>,
  tv: { dir: string; shows: Record<string, { title: string; year: number; tmdb: string }[]> },
) {
  const requests: string[] = [];
  let refreshed = false;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (!auth.includes('Token="test-key"')) return new Response('', { status: 401 });
    if (
      url.pathname === '/Items/RemoteSearch/Movie' ||
      url.pathname === '/Items/RemoteSearch/Series'
    ) {
      const name = JSON.parse(String(init?.body)).SearchInfo.Name as string;
      const source = url.pathname.endsWith('Series') ? tv.shows : catalog;
      const hits = source[name.toLowerCase()] ?? [];
      return Response.json(
        hits.map((h) => ({
          Name: h.title,
          ProductionYear: h.year,
          ProviderIds: { Tmdb: h.tmdb, Imdb: `tt${h.tmdb}` },
        })),
      );
    }
    if (url.pathname === '/Library/Refresh') {
      refreshed = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/Library/VirtualFolders') {
      return Response.json([
        { Name: 'Movies', CollectionType: 'movies', Locations: [movies] },
        ...(tv.dir ? [{ Name: 'Shows', CollectionType: 'tvshows', Locations: [tv.dir] }] : []),
      ]);
    }
    if (url.pathname === '/Items' && url.searchParams.get('IncludeItemTypes') === 'Series') {
      if (!refreshed) return Response.json({ Items: [] });
      const items = fs.existsSync(tv.dir)
        ? fs.readdirSync(tv.dir).map((folder, i) => ({
            Id: `show${i}${folder.length}`,
            Path: path.join(tv.dir, folder),
          }))
        : [];
      return Response.json({ Items: items });
    }
    if (url.pathname === '/Items') {
      if (!refreshed) return Response.json({ Items: [] });
      const items = fs.existsSync(movies)
        ? fs.readdirSync(movies).map((folder, i) => ({
            Id: `jf${i}${folder.length}`,
            Path: path.join(movies, folder, `${folder}.mp4`),
          }))
        : [];
      return Response.json({ Items: items });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('automatic disc ripping', () => {
  let root: string;
  let volumes: string;
  let rips: string;
  let movies: string;
  let tvDir: string;
  let hw: FakeHardware;
  let sent: Notification[];
  let server: TestServer & { ripper: import('../../src/server/ripper/ripper').Ripper | null };
  let client: Client;

  const catalog = {
    'young frankenstein': [{ title: 'Young Frankenstein', year: 1974, tmdb: '3034' }],
    godzilla: [
      { title: 'Godzilla', year: 2014, tmdb: '124905' },
      { title: 'Godzilla', year: 1954, tmdb: '1678' },
    ],
  };

  const shows = {
    'the office': [{ title: 'The Office', year: 2005, tmdb: '2316' }],
  };

  async function boot(
    env: Record<string, string> = {},
    tvLibrary = true,
    cloudSeams: {
      ripperCloud?: RipperCloud | null;
      ripperOcr?: ((mkv: string, dir: string) => Promise<string | null>) | null;
    } = {},
  ) {
    const jf = fakeJellyfin(movies, catalog, { dir: tvLibrary ? tvDir : '', shows });
    server = await startServer(
      {
        jellyfinUrl: 'http://jellyfin.test',
        ripper: loadRipperConfig({
          RIPPER_ENABLED: '1',
          RIPS_DIR: rips,
          MOVIES_DIR: movies,
          TV_DIR: tvDir,
          DISC_VOLUMES_DIR: volumes,
          MAKEMKVCON: '/fake/makemkvcon',
          HANDBRAKE_CLI: '/fake/HandBrakeCLI',
          JELLYFIN_API_KEY: 'test-key',
          NTFY_TOPIC: 'wheelhouse-test',
          WHEELHOUSE_PUBLIC_URL: 'http://wheelhouse.local:8787',
          RIP_MIN_FREE_GB: '0',
          RIP_CLOSE_DVD_PLAYER: '1',
          RIP_POLL_MS: '3600000',
          RIP_IMPORT_POLL_MS: '5',
          RIP_IMPORT_TIMEOUT_MS: '2000',
          ...env,
        }),
      },
      undefined,
      {
        ripperRunner: hw.runner,
        ripperNotifier: { send: async (n) => void sent.push(n) },
        ripperFetch: jf.fetchImpl,
        ...cloudSeams,
      },
    );
    client = new Client(server.url);
    await client.login('owner', 'demo');
    server.ripper!.start();
    return jf;
  }

  async function jobs() {
    const res = await client.get('/api/rips');
    expect(res.status).toBe(200);
    return res.json.jobs as { id: string; status: string; [k: string]: unknown }[];
  }

  async function waitFor(status: string) {
    for (let i = 0; i < 400; i++) {
      const [job] = await jobs();
      if (job?.status === status) return job;
      if (job?.status === 'failed' && status !== 'failed') {
        throw new Error(`Rip failed: ${String(job.message)}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for ${status}; jobs: ${JSON.stringify(await jobs())}`);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wheelhouse-rip-'));
    volumes = path.join(root, 'Volumes');
    rips = path.join(root, 'LaCie', 'Rips');
    movies = path.join(root, 'LaCie', 'Movies');
    tvDir = path.join(root, 'LaCie', 'TV Shows');
    for (const d of [volumes, rips, movies]) fs.mkdirSync(d, { recursive: true });
    hw = new FakeHardware(volumes);
    sent = [];
  });

  afterEach(async () => {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('inserting a disc ends with the movie filed, in Jellyfin and announced', async () => {
    const jf = await boot();
    hw.insert({
      label: 'YOUNG_FRANKENSTEIN_WS',
      titles: [{ duration: '0:02:10' }, { duration: FEATURE }],
    });
    await server.ripper!.poll();
    const job = await waitFor('done');

    const file = path.join(
      movies,
      'Young Frankenstein (1974) [tmdbid-3034]',
      'Young Frankenstein (1974).mp4',
    );
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBe(2_000_000);
    // The rip was deleted only after the movie was in place, and the disc was ejected.
    expect(fs.readdirSync(rips)).toEqual([]);
    expect(hw.calls).toContain('drutil eject');
    // DVD Player (which macOS opens for a new DVD) was quit before ripping.
    expect(hw.calls.indexOf('pkill -x DVD Player')).toBeLessThan(
      hw.calls.findIndex((c) => c.includes(' mkv ')),
    );
    expect(hw.calls.indexOf('pkill -x DVD Player')).toBeGreaterThanOrEqual(0);
    // The main feature (title 1) was ripped, not the 2-minute extra.
    expect(hw.calls.find((c) => c.includes(' mkv '))).toMatch(/mkv disc:0 1 /);
    // Jellyfin was asked to scan, and the job links to the new movie.
    expect(jf.requests).toContain('POST /Library/Refresh');
    expect(job.movieId).toMatch(/^jf/);
    expect(job.title).toBe('Young Frankenstein');
    expect(job.year).toBe(1974);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toBe('Young Frankenstein (1974) is ready to watch.');
    expect(sent[0]!.click).toBe(`http://wheelhouse.local:8787/movie/${job.movieId}`);
  });

  it('with the cloud set up, a finished rip uploads itself, with the disc’s own subtitles', async () => {
    const published: Record<string, unknown>[] = [];
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n';
    await boot({}, true, {
      ripperOcr: async (mkv) => (mkv.endsWith('.mkv') ? vtt : null),
      ripperCloud: {
        publish: async (movie, onProgress) => {
          onProgress(0.5);
          published.push(movie);
          return { id: 'tmdb-3034', url: 'https://wheelhouse.example/movie/tmdb-3034' };
        },
      },
    });
    hw.insert({ label: 'YOUNG_FRANKENSTEIN_WS', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const job = await waitFor('done');
    const file = path.join(
      movies,
      'Young Frankenstein (1974) [tmdbid-3034]',
      'Young Frankenstein (1974).mp4',
    );
    expect(published).toEqual([
      { file, tmdbId: '3034', title: 'Young Frankenstein', year: 1974, discSubtitles: vtt },
    ]);
    // The OCR'd subtitles are kept beside the local copy too.
    expect(fs.readFileSync(file.replace('.mp4', '.en.vtt'), 'utf8')).toBe(vtt);
    expect(job.movieId).toBe('tmdb-3034');
    expect(sent.at(-1)).toMatchObject({
      message: 'Young Frankenstein (1974) is ready to watch.',
      click: 'https://wheelhouse.example/movie/tmdb-3034',
    });
  });

  it('a failed upload leaves the movie filed locally and the rip ready to retry', async () => {
    let cloudUp = false;
    await boot({}, true, {
      ripperOcr: null,
      ripperCloud: {
        publish: async () => {
          if (!cloudUp) throw new Error('Cloud PUT /movies/tmdb-3034 failed (503)');
          return { id: 'tmdb-3034', url: 'https://wheelhouse.example/movie/tmdb-3034' };
        },
      },
    });
    hw.insert({ label: 'YOUNG_FRANKENSTEIN_WS', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const job = await waitFor('failed');
    expect(job.message).toMatch(/503/);
    expect(
      fs.existsSync(
        path.join(
          movies,
          'Young Frankenstein (1974) [tmdbid-3034]',
          'Young Frankenstein (1974).mp4',
        ),
      ),
    ).toBe(true);
    // Retry repeats just the upload.
    cloudUp = true;
    expect((await client.post(`/api/rips/${String(job.id)}/retry`, {})).status).toBe(200);
    expect((await waitFor('done')).movieId).toBe('tmdb-3034');
  });

  it('shows real progress while the title is saved, not 100% once the disc is opened', async () => {
    await boot();
    let midway: Record<string, unknown> | undefined;
    hw.midRip = async () => {
      [midway] = await jobs();
    };
    hw.insert({ label: 'YOUNG_FRANKENSTEIN_WS', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    await waitFor('done');
    expect(midway).toMatchObject({
      status: 'ripping',
      progress: 0.5,
      message: null,
    });
  });

  it('says so when MakeMKV is killed mid-rip', async () => {
    await boot();
    hw.ripSignal = 'SIGTERM';
    hw.insert({ label: 'YOUNG_FRANKENSTEIN_WS', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const job = await waitFor('failed');
    expect(job.message).toMatch(/MakeMKV was stopped \(SIGTERM\) before it finished/);
  });

  it('asks which movie it is when the name is ambiguous, then finishes', async () => {
    await boot();
    hw.insert({ label: 'GODZILLA', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const job = await waitFor('needs_name');
    expect(job.candidates).toHaveLength(2);
    expect(String(job.message)).toMatch(/Which movie/);
    expect(sent[0]!.title).toMatch(/needs a name/);
    expect(sent[0]!.click).toBe('http://wheelhouse.local:8787/rips');

    const res = await client.post(`/api/rips/${job.id}/name`, {
      title: 'Godzilla',
      year: 1954,
      tmdbId: '1678',
    });
    expect(res.status).toBe(200);
    await waitFor('done');
    expect(
      fs.existsSync(path.join(movies, 'Godzilla (1954) [tmdbid-1678]', 'Godzilla (1954).mp4')),
    ).toBe(true);
  });

  it('asks which title to rip on copy-protected discs and keeps the disc in', async () => {
    await boot();
    const decoys = Array.from({ length: 6 }, (_, i) => ({
      duration: FEATURE,
      segments: `1,${i + 2},3`,
    }));
    hw.insert({ label: 'YOUNG_FRANKENSTEIN', titles: decoys });
    await server.ripper!.poll();
    const job = await waitFor('needs_choice');
    expect(job.discTitles).toHaveLength(6);
    expect(hw.calls).not.toContain('drutil eject');

    const res = await client.post(`/api/rips/${job.id}/choose`, { titleIndex: 4 });
    expect(res.status).toBe(200);
    await waitFor('done');
    expect(hw.calls.find((c) => c.includes(' mkv '))).toMatch(/mkv disc:0 4 /);
  });

  it('the Eject button takes the disc out, but not in the middle of a rip', async () => {
    await boot();
    // Waiting for a choice: ejecting is fine, and the job says the disc was taken out.
    const decoys = Array.from({ length: 6 }, (_, i) => ({
      duration: FEATURE,
      segments: `1,${i + 2},3`,
    }));
    hw.insert({ label: 'YOUNG_FRANKENSTEIN', titles: decoys });
    await server.ripper!.poll();
    await waitFor('needs_choice');
    const res = await client.post('/api/rips/eject', {});
    expect(res.status).toBe(200);
    expect(hw.calls).toContain('drutil eject');
    expect(fs.readdirSync(volumes)).toEqual([]);
    await server.ripper!.poll();
    const failed = await waitFor('failed');
    expect(String(failed.message)).toMatch(/removed before a title was chosen/);

    // Mid-rip: no, use Stop.
    hw.hangRip = true;
    hw.insert({ label: 'GODZILLA', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const ripping = await waitFor('ripping');
    const busy = await client.post('/api/rips/eject', {});
    expect(busy.status).toBe(400);
    expect(busy.json.error.message).toMatch(/Use Stop/);
    expect((await client.delete(`/api/rips/${ripping.id}`)).status).toBeLessThan(300);
  });

  it('keeps the rip when compression fails, and Retry finishes the job', async () => {
    await boot();
    hw.failNextEncode = true;
    hw.insert({ label: 'YOUNG_FRANKENSTEIN', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const failed = await waitFor('failed');
    expect(String(failed.message)).toMatch(/HandBrake/);
    expect(sent.at(-1)!.title).toMatch(/had a problem/);
    // The original rip is kept; the partial compressed file is not.
    const dir = fs.readdirSync(rips).map((d) => path.join(rips, d))[0]!;
    expect(fs.readdirSync(dir)).toEqual(['title_t00.mkv']);

    expect((await client.post(`/api/rips/${failed.id}/retry`)).status).toBe(200);
    await waitFor('done');
  });

  it('explains a blocked drive, and Retry starts again while the disc is still in', async () => {
    await boot();
    hw.failNextInfo = true;
    hw.insert({ label: 'A_NEW_HOPE', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const failed = await waitFor('failed');
    expect(String(failed.message)).toMatch(/Failed to open disc/);
    expect(String(failed.message)).toMatch(/Full Disk Access/);

    expect((await client.post(`/api/rips/${failed.id}/retry`)).status).toBe(200);
    // Read, ripped and compressed this time; "A New Hope" then just needs its name confirmed.
    const next = await waitFor('needs_name');
    expect(next.id).toBe(failed.id);
    expect(next.guess).toBe('A New Hope');
  });

  it('refuses to file an incomplete compressed movie', async () => {
    await boot();
    hw.scanSeconds = 1800; // HandBrake stopped half way through
    hw.insert({ label: 'YOUNG_FRANKENSTEIN', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const failed = await waitFor('failed');
    expect(String(failed.message)).toMatch(/incomplete/);
    expect(fs.readdirSync(movies)).toEqual([]);
  });

  it('does not rip the same disc twice', async () => {
    await boot();
    hw.insert({ label: 'YOUNG_FRANKENSTEIN', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    await waitFor('done');
    hw.insert({ label: 'YOUNG_FRANKENSTEIN', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    expect(await jobs()).toHaveLength(1);
  });

  it('shows preparing instead of 100%, and Stop ends a stuck rip', async () => {
    await boot();
    hw.hangRip = true;
    hw.insert({ label: 'YOUNG_FRANKENSTEIN', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const job = await waitFor('ripping');
    for (let i = 0; i < 100; i++) {
      const [j] = await jobs();
      if (String(j?.message).includes('layout')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const [current] = await jobs();
    expect(current).toMatchObject({ progress: null });
    expect(String(current!.message)).toMatch(/Reading the disc’s layout/);

    expect((await client.delete(`/api/rips/${job.id}`)).status).toBeLessThan(300);
    expect((await jobs()).find((j) => j.id === job.id)).toBeUndefined();
    expect(fs.readdirSync(rips)).toEqual([]);
    expect(sent.some((n) => /problem/.test(n.title))).toBe(false);
  });

  it('dismissing removes leftover files but never a finished movie', async () => {
    await boot();
    hw.insert({ label: 'GODZILLA', titles: [{ duration: FEATURE }] });
    await server.ripper!.poll();
    const job = await waitFor('needs_name');
    expect(fs.readdirSync(rips)).toHaveLength(1);
    expect((await client.delete(`/api/rips/${job.id}`)).status).toBe(200);
    expect(fs.readdirSync(rips)).toEqual([]);
    expect(await jobs()).toEqual([]);
  });

  it('reports setup problems instead of failing silently', async () => {
    await boot({ RIPS_DIR: path.join(root, 'missing') });
    const res = await client.get('/api/rips');
    expect(res.json.health.problems.join(' ')).toMatch(/MakeMKV/);
    expect(res.json.health.problems.join(' ')).toMatch(/Rips folder .* doesn’t exist/);
  });

  // TV discs ------------------------------------------------------------------

  const officeDisc = (label: string): Disc => ({
    label,
    // Four episodes, plus a "play all" title that is the same four back to back.
    titles: [
      { duration: '1:29:32' },
      { duration: '0:22:10' },
      { duration: '0:22:31' },
      { duration: '0:22:02' },
      { duration: '0:22:49' },
      { duration: '0:03:10' },
    ],
  });

  async function confirmEpisodes(job: Record<string, unknown>) {
    const episodes = job.episodes as { titleIndex: number; episode: number }[];
    const res = await client.post(`/api/rips/${String(job.id)}/episodes`, {
      show: { title: 'The Office', year: 2005, tmdbId: '2316', imdbId: null },
      season: job.season,
      episodes: episodes.map((e) => ({ titleIndex: e.titleIndex, episode: e.episode })),
    });
    expect(res.status).toBe(200);
  }

  it('rips a TV season disc into numbered episodes, filed for Jellyfin and announced', async () => {
    await boot();
    hw.insert(officeDisc('THE_OFFICE_S1_D2'));
    await server.ripper!.poll();
    const job = await waitFor('needs_episodes');

    // Recognised as TV: the show, the season and (from "disc 2") the episode numbers.
    expect(job.kind).toBe('tv');
    expect(job.title).toBe('The Office');
    expect(job.season).toBe(1);
    expect(job.episodes).toEqual([
      { titleIndex: 1, durationSeconds: 1330, episode: 5, state: 'pending', path: null },
      { titleIndex: 2, durationSeconds: 1351, episode: 6, state: 'pending', path: null },
      { titleIndex: 3, durationSeconds: 1322, episode: 7, state: 'pending', path: null },
      { titleIndex: 4, durationSeconds: 1369, episode: 8, state: 'pending', path: null },
    ]);
    expect(sent[0]!.title).toMatch(/needs a hand/);
    // Nothing is ripped until the episodes are confirmed.
    expect(hw.calls.some((c) => c.includes(' mkv '))).toBe(false);

    await confirmEpisodes(job);
    const done = await waitFor('done');

    const season = path.join(tvDir, 'The Office (2005) [tmdbid-2316]', 'Season 01');
    expect(fs.readdirSync(season).sort()).toEqual([
      'The Office S01E05.mp4',
      'The Office S01E06.mp4',
      'The Office S01E07.mp4',
      'The Office S01E08.mp4',
    ]);
    // Each episode title was ripped once (not the "play all" or the extra), then the disc ejected.
    expect(hw.calls.filter((c) => c.includes(' mkv ')).map((c) => c.split(' ')[5])).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(hw.calls).toContain('drutil eject');
    expect(fs.readdirSync(rips)).toEqual([]);
    expect(done.movieId).toMatch(/^show/);
    expect(sent.at(-1)!.message).toBe('The Office season 1, episodes 5–8 are ready to watch.');
    expect(sent.at(-1)!.click).toBe(`http://wheelhouse.local:8787/show/${String(done.movieId)}`);
  });

  it('with the cloud set up, a ripped TV season uploads its episodes', async () => {
    const uploads: { show: unknown; episodes: { file: string; episode: number }[] }[] = [];
    await boot({}, true, {
      ripperCloud: {
        publish: async () => {
          throw new Error('not a movie');
        },
        publishEpisodes: async (show, episodes, onProgress) => {
          onProgress(1);
          uploads.push({ show, episodes });
          return { showId: 'tmdbtv-2316', url: 'https://wheelhouse.example/show/tmdbtv-2316' };
        },
      },
    });
    hw.insert(officeDisc('THE_OFFICE_S1_D2'));
    await server.ripper!.poll();
    await confirmEpisodes(await waitFor('needs_episodes'));
    const done = await waitFor('done');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.show).toMatchObject({ title: 'The Office', season: 1, tmdbId: '2316' });
    expect(uploads[0]!.episodes.map((e) => e.episode)).toEqual([5, 6, 7, 8]);
    expect(uploads[0]!.episodes[0]!.file).toMatch(/Season 01\/The Office S01E05\.mp4$/);
    expect(done.movieId).toBe('tmdbtv-2316');
    expect(sent.at(-1)!.click).toBe('https://wheelhouse.example/show/tmdbtv-2316');
  });

  it('carries episode numbers on from the previous disc of the season', async () => {
    await boot();
    hw.insert(officeDisc('THE_OFFICE_S1_D1'));
    await server.ripper!.poll();
    const first = await waitFor('needs_episodes');
    expect((first.episodes as { episode: number }[]).map((e) => e.episode)).toEqual([1, 2, 3, 4]);
    await confirmEpisodes(first);
    await waitFor('done');

    // A disc whose label doesn't say which disc it is still continues at episode 5.
    hw.insert(officeDisc('THE_OFFICE_SEASON_1'));
    await server.ripper!.poll();
    const [second] = await jobs();
    for (let i = 0; i < 200 && second!.status !== 'needs_episodes'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      Object.assign(second!, (await jobs())[0]);
    }
    expect((second!.episodes as { episode: number }[]).map((e) => e.episode)).toEqual([5, 6, 7, 8]);
  });

  it('checks the episode choices', async () => {
    await boot();
    hw.insert(officeDisc('THE_OFFICE_S1_D1'));
    await server.ripper!.poll();
    const job = await waitFor('needs_episodes');
    const post = (body: unknown) => client.post(`/api/rips/${job.id}/episodes`, body);
    const show = { title: 'The Office', year: 2005, tmdbId: '2316', imdbId: null };
    const twice = await post({
      show,
      season: 1,
      episodes: [
        { titleIndex: 1, episode: 3 },
        { titleIndex: 2, episode: 3 },
      ],
    });
    expect(twice.status).toBe(400);
    expect(twice.json.error.message).toMatch(/Episode 3 is used twice/);
    const none = await post({ show, season: 1, episodes: [] });
    expect(none.json.error.message).toMatch(/at least one/);
    const missing = await post({ show, season: 1, episodes: [{ titleIndex: 42, episode: 1 }] });
    expect(missing.json.error.message).toMatch(/not on this disc/);
  });

  it('lets a wrongly guessed disc be switched between movie and TV', async () => {
    await boot();
    hw.insert(officeDisc('THE_OFFICE_S1_D1'));
    await server.ripper!.poll();
    const job = await waitFor('needs_episodes');
    const movie = await client.post(`/api/rips/${job.id}/kind`, { kind: 'movie' });
    expect(movie.json).toMatchObject({ status: 'needs_choice', kind: 'movie', episodes: [] });
    const tv = await client.post(`/api/rips/${job.id}/kind`, { kind: 'tv' });
    expect(tv.json).toMatchObject({ status: 'needs_episodes', kind: 'tv', season: 1 });
    expect((tv.json.episodes as unknown[]).length).toBe(4);
  });

  it('keeps finished episodes when one fails, and Retry only redoes the rest', async () => {
    await boot();
    hw.insert(officeDisc('THE_OFFICE_S1_D1'));
    await server.ripper!.poll();
    const job = await waitFor('needs_episodes');
    hw.failEncodeNumber = 3; // the third episode's compression fails
    await confirmEpisodes(job);
    const failed = await waitFor('failed');
    expect((failed.episodes as { state: string }[]).map((e) => e.state)).toEqual([
      'encoded',
      'encoded',
      'ripped',
      'ripped',
    ]);
    const encodesBefore = hw.calls.filter((c) => c.startsWith('HandBrakeCLI -i')).length;
    expect((await client.post(`/api/rips/${job.id}/retry`)).status).toBe(200);
    await waitFor('done');
    // Only episodes 3 and 4 were compressed again.
    expect(hw.calls.filter((c) => c.startsWith('HandBrakeCLI -i')).length - encodesBefore).toBe(2);
    expect(
      fs.readdirSync(path.join(tvDir, 'The Office (2005) [tmdbid-2316]', 'Season 01')),
    ).toHaveLength(4);
  });

  it('never overwrites an episode that is already in the TV folder', async () => {
    await boot();
    const season = path.join(tvDir, 'The Office (2005) [tmdbid-2316]', 'Season 01');
    fs.mkdirSync(season, { recursive: true });
    fs.writeFileSync(path.join(season, 'The Office S01E02.mp4'), 'mine');
    hw.insert(officeDisc('THE_OFFICE_S1_D1'));
    await server.ripper!.poll();
    await confirmEpisodes(await waitFor('needs_episodes'));
    const failed = await waitFor('failed');
    expect(String(failed.message)).toMatch(/S01E02.mp4” is already in your TV folder/);
    expect(fs.readFileSync(path.join(season, 'The Office S01E02.mp4'), 'utf8')).toBe('mine');
    // Nothing was half-filed.
    expect(fs.readdirSync(season)).toEqual(['The Office S01E02.mp4']);
  });

  it('warns when Jellyfin has no Shows library for the TV folder', async () => {
    await boot({}, false);
    let warnings: string[] = [];
    for (let i = 0; i < 100 && warnings.length < 1; i++) {
      warnings = (await client.get('/api/rips')).json.health.warnings as string[];
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(warnings.join(' ')).toMatch(/no Shows library/);
  });

  it('is off unless enabled', async () => {
    const plain = await startServer();
    const c = new Client(plain.url);
    const session = await c.login('viewer', 'demo');
    expect(session.json.ripper).toBe(false);
    expect((await c.get('/api/rips')).status).toBe(404);
    await plain.close();
  });
});
