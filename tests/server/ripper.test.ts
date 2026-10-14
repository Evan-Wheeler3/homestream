import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRipperConfig } from '../../src/server/config';
import type { Runner } from '../../src/server/ripper/process';
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
  encodedSeconds = FEATURE_SECONDS;

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
      if (args.includes('info')) {
        return { code: 0, output: this.disc ? discInfo(this.disc) : 'MSG:5010,0,0,"No disc"' };
      }
      if (args.includes('mkv')) {
        const dir = args[args.length - 1]!;
        const title = Number(args[args.length - 2]);
        for (const p of [0, 2500, 65536]) emit(`PRGV:${p},${p},65536`);
        fs.writeFileSync(path.join(dir, `title_t0${title}.mkv`), 'mkv-data');
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
        const s = this.encodedSeconds;
        const hms = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
          .map((n, i) => (i ? String(n).padStart(2, '0') : String(n)))
          .join(':');
        return { code: 0, output: `[scan] title 1\n  + duration: ${hms}\n` };
      }
      const output = args[args.indexOf('-o') + 1]!;
      emit('Encoding: task 1 of 1, 50.00 % (120.1 fps, avg 118.0 fps, ETA 00h05m00s)');
      if (this.failNextEncode) {
        this.failNextEncode = false;
        fs.writeFileSync(output, 'partial');
        return { code: 3, output: 'Encode failed (error 3)' };
      }
      fs.writeFileSync(output, Buffer.alloc(2_000_000));
      emit('Encoding: task 1 of 1, 100.00 %');
      return { code: 0, output: 'Encode done!' };
    }
    if (tool === 'osascript') return { code: 0, output: '' };
    throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', path: command });
  };
}

/** Just enough of Jellyfin's API for the ripper. */
function fakeJellyfin(
  movies: string,
  catalog: Record<string, { title: string; year: number; tmdb: string }[]>,
) {
  const requests: string[] = [];
  let refreshed = false;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (!auth.includes('Token="test-key"')) return new Response('', { status: 401 });
    if (url.pathname === '/Items/RemoteSearch/Movie') {
      const name = JSON.parse(String(init?.body)).SearchInfo.Name as string;
      const hits = catalog[name.toLowerCase()] ?? [];
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

  async function boot(env: Record<string, string> = {}) {
    const jf = fakeJellyfin(movies, catalog);
    server = await startServer(
      {
        jellyfinUrl: 'http://jellyfin.test',
        ripper: loadRipperConfig({
          RIPPER_ENABLED: '1',
          RIPS_DIR: rips,
          MOVIES_DIR: movies,
          DISC_VOLUMES_DIR: volumes,
          MAKEMKVCON: '/fake/makemkvcon',
          HANDBRAKE_CLI: '/fake/HandBrakeCLI',
          JELLYFIN_API_KEY: 'test-key',
          NTFY_TOPIC: 'wheelhouse-test',
          WHEELHOUSE_PUBLIC_URL: 'http://wheelhouse.local:8787',
          RIP_MIN_FREE_GB: '0',
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

  it('refuses to file an incomplete compressed movie', async () => {
    await boot();
    hw.encodedSeconds = 1800; // HandBrake stopped half way through
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

  it('is off unless enabled', async () => {
    const plain = await startServer();
    const c = new Client(plain.url);
    const session = await c.login('viewer', 'demo');
    expect(session.json.ripper).toBe(false);
    expect((await c.get('/api/rips')).status).toBe(404);
    await plain.close();
  });
});
