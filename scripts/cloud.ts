// Moving Wheelhouse to Cloudflare, from this Mac.
//
//   npm run cloud:upload              upload every movie in MOVIES_DIR and every
//                                     episode in TV_DIR (resumable)
//   npm run cloud:upload -- --movies-only | --tv-only
//   npm run cloud:upload -- --dry-run show what would happen
//   npm run cloud:upload -- --only "Pulp" --match "Young Frankenstein (1974)=3034"
//   npm run cloud:people -- --admin-name "Evan"   move people's data across
//   npm run cloud:bootstrap -- --name "Evan"      the first administrator's invitation
//
// Settings come from .env: CLOUD_URL, CLOUD_MAC_TOKEN, R2_*, TMDB_READ_TOKEN,
// OPENSUBTITLES_*, MOVIES_DIR, TV_DIR, JELLYFIN_URL / JELLYFIN_API_KEY.
// Nothing in MOVIES_DIR or TV_DIR is ever changed: they are only read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { OpenSubtitles } from '../src/shared/opensubtitles.js';
import {
  CloudClient,
  cloudConfigFromEnv,
  cloudEpisodeId,
  cloudMovieId,
  cloudShowId,
  publishEpisode,
  publishMovie,
  type IngestedMovie,
} from '../src/server/cloud/publish.js';
import {
  R2Uploader,
  r2ConfigFromEnv,
  sha256File,
  type MultipartState,
} from '../src/server/cloud/r2.js';
import {
  confidentMatch,
  parseEpisodeFile,
  parseFolderName,
  Tmdb,
} from '../src/server/cloud/tmdb.js';
import { runProcess } from '../src/server/ripper/process.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const values: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1]) values.push(args[i + 1]!);
  });
  return values;
};

const GB = 1024 ** 3;
const fmtGb = (bytes: number) => `${(bytes / GB).toFixed(2)} GB`;
const fmtTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
};

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in .env (see README → Cloudflare).`);
    process.exit(1);
  }
  return value;
}

function cloudClient() {
  const config = cloudConfigFromEnv();
  if (!config) {
    console.error('Missing CLOUD_URL or CLOUD_MAC_TOKEN in .env.');
    process.exit(1);
  }
  return new CloudClient(config);
}

// -----------------------------------------------------------------------------
// Upload state: file hashes (so they aren't recomputed) and unfinished uploads.

const STATE_FILE = path.resolve(process.env.DATA_DIR ?? 'data', 'cloud-upload.json');

interface UploadState {
  hashes: Record<string, { size: number; mtimeMs: number; sha256: string }>;
  multipart: Record<string, MultipartState>;
  /** Folder name → TMDB id, for folders that needed asking. */
  matches: Record<string, string>;
}

function loadState(): UploadState {
  try {
    return {
      hashes: {},
      multipart: {},
      matches: {},
      ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')),
    };
  } catch {
    return { hashes: {}, multipart: {}, matches: {} };
  }
}

function saveState(state: UploadState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

async function cachedHash(state: UploadState, file: string) {
  const stat = fs.statSync(file);
  const known = state.hashes[file];
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.sha256;
  const sha256 = await sha256File(file);
  state.hashes[file] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256 };
  saveState(state);
  return sha256;
}

// -----------------------------------------------------------------------------
// Jellyfin (optional): it already knows each folder's TMDB id and everyone's
// watch state.

interface JellyfinItem {
  Id: string;
  Name: string;
  Path?: string;
  ProductionYear?: number;
  ProviderIds?: { Tmdb?: string };
  UserData?: {
    Played?: boolean;
    IsFavorite?: boolean;
    PlaybackPositionTicks?: number;
    PlayCount?: number;
    LastPlayedDate?: string;
  };
}

function jellyfin() {
  const url = (process.env.JELLYFIN_URL ?? '').replace(/\/$/, '');
  const key = process.env.JELLYFIN_API_KEY;
  if (!url || !key) return null;
  const get = async <T>(p: string): Promise<T> => {
    const res = await fetch(`${url}${p}`, {
      headers: { Authorization: `MediaBrowser Token="${key}"` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Jellyfin ${p} failed (${res.status})`);
    return res.json() as Promise<T>;
  };
  return {
    movies: () =>
      get<{ Items: JellyfinItem[] }>(
        '/Items?Recursive=true&IncludeItemTypes=Movie&Fields=ProviderIds,Path',
      ).then((r) => r.Items),
    users: () =>
      get<{ Id: string; Name: string; Policy?: { IsAdministrator?: boolean } }[]>('/Users'),
    userMovies: (userId: string) =>
      get<{ Items: JellyfinItem[] }>(
        `/Users/${userId}/Items?Recursive=true&IncludeItemTypes=Movie&Fields=ProviderIds,Path`,
      ).then((r) => r.Items),
  };
}

// -----------------------------------------------------------------------------
// upload

interface Candidate {
  folder: string;
  file: string;
  size: number;
  tmdbId: string | null;
  how: string;
}

function videoIn(dir: string): string | null {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(mp4|m4v|mkv|mov)$/i.test(f) && !f.startsWith('._'))
    .map((f) => path.join(dir, f));
  files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return files[0] ?? null;
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function uploadMovies() {
  const moviesDir = process.env.MOVIES_DIR ?? '/Volumes/LaCie/Movies';
  const r2Config = r2ConfigFromEnv();
  if (!r2Config) {
    console.error('Missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in .env.');
    process.exit(1);
  }
  const tmdb = new Tmdb(need('TMDB_READ_TOKEN'));
  const cloud = cloudClient();
  const r2 = new R2Uploader(r2Config);
  const subs =
    flag('no-subtitles') || !process.env.OPENSUBTITLES_API_KEY
      ? null
      : new OpenSubtitles({
          apiKey: need('OPENSUBTITLES_API_KEY'),
          username: need('OPENSUBTITLES_USERNAME'),
          password: need('OPENSUBTITLES_PASSWORD'),
        });
  const state = loadState();
  for (const m of option('match')) {
    const [folder, id] = m.split('=');
    if (folder && /^\d+$/.test(id ?? '')) state.matches[folder.trim()] = id!;
  }
  const only = option('only');

  // Which TMDB movie each folder is.
  const jf = jellyfin();
  const jfMovies = jf ? await jf.movies().catch(() => [] as JellyfinItem[]) : [];
  const folders = fs
    .readdirSync(moviesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter(
      (name) => only.length === 0 || only.some((o) => name.toLowerCase().includes(o.toLowerCase())),
    )
    .sort();
  const candidates: Candidate[] = [];
  const unsure: string[] = [];
  for (const folder of folders) {
    const dir = path.join(moviesDir, folder);
    const file = videoIn(dir);
    if (!file) continue;
    const parsed = parseFolderName(folder);
    let tmdbId = state.matches[folder] ?? parsed.tmdbId;
    let how = state.matches[folder] ? 'you chose' : parsed.tmdbId ? 'folder name' : '';
    if (!tmdbId) {
      const fromJellyfin = jfMovies.find((m) => m.Path && path.dirname(m.Path) === dir)?.ProviderIds
        ?.Tmdb;
      if (fromJellyfin) {
        tmdbId = fromJellyfin;
        how = 'Jellyfin';
      }
    }
    if (!tmdbId) {
      const results = await tmdb.search(parsed.title, parsed.year);
      const match = confidentMatch(results, parsed.title, parsed.year);
      if (match) {
        tmdbId = String(match.id);
        how = `TMDB search (${match.title}, ${match.year})`;
      } else if (process.stdin.isTTY && !flag('dry-run')) {
        console.log(`\nWhich movie is “${folder}”?`);
        results
          .slice(0, 6)
          .forEach((r, i) =>
            console.log(`  ${i + 1}. ${r.title} (${r.year ?? '?'}) · tmdb ${r.id}`),
          );
        const answer = await ask('Number, a TMDB id, or Enter to skip: ');
        const pick = /^\d$/.test(answer) ? results[Number(answer) - 1] : null;
        tmdbId = pick ? String(pick.id) : /^\d{2,}$/.test(answer) ? answer : null;
        if (tmdbId) {
          state.matches[folder] = tmdbId;
          saveState(state);
          how = 'you chose';
        }
      }
      if (!tmdbId) {
        unsure.push(
          `${folder}: ${
            results
              .slice(0, 4)
              .map((r) => `${r.title} (${r.year ?? '?'}) = ${r.id}`)
              .join(' · ') || 'no TMDB results'
          }`,
        );
        continue;
      }
    }
    candidates.push({ folder, file, size: fs.statSync(file).size, tmdbId, how });
  }

  // Which still need doing.
  const inCloud = new Map<string, IngestedMovie>((await cloud.movies()).map((m) => [m.id, m]));
  const todo: (Candidate & { sha256: string })[] = [];
  console.log(`\n${candidates.length} movies in ${moviesDir}:`);
  for (const c of candidates) {
    const sha256 = await cachedHash(state, c.file);
    const there = inCloud.get(cloudMovieId(c.tmdbId!));
    const done = there && there.video_sha256 === sha256 && there.video_bytes === c.size;
    const needsSubs = done && there.subtitle_status === 'none' && subs;
    console.log(
      `  ${done ? (needsSubs ? '◐' : '✓') : '·'} ${c.folder}  ${fmtGb(c.size)}  [tmdb ${c.tmdbId} from ${c.how}]` +
        (done ? (needsSubs ? '  in the cloud, no subtitles yet' : '  already in the cloud') : ''),
    );
    if (!done || needsSubs) todo.push({ ...c, sha256 });
  }
  if (unsure.length) {
    console.log('\nNot sure which movie these are (skipped). Add --match "Folder name=TMDB id":');
    for (const u of unsure) console.log(`  ? ${u}`);
  }
  const total = todo.reduce((sum, c) => sum + c.size, 0);
  console.log(`\nTo upload: ${todo.length} movie(s), ${fmtGb(total)}.`);
  if (flag('dry-run') || todo.length === 0) return;

  // Upload, with progress, speed and an ETA.
  let doneBytes = 0;
  const started = Date.now();
  const samples: { at: number; bytes: number }[] = [];
  let lastPrint = 0;
  let skipDownloads = false;
  const results: string[] = [];
  for (const [i, c] of todo.entries()) {
    const before = doneBytes;
    const label = `[${i + 1}/${todo.length}] ${c.folder}`;
    console.log(`\n${label}`);
    try {
      const result = await publishMovie(
        { file: c.file, tmdbId: c.tmdbId!, sha256: c.sha256, skipDownloads },
        {
          run: runProcess,
          handbrakeCli: process.env.HANDBRAKE_CLI ?? '/usr/local/bin/HandBrakeCLI',
          r2,
          tmdb,
          cloud,
          openSubtitles: subs,
          workDir: path.join(os.tmpdir(), 'wheelhouse-cloud'),
          log: (line) => console.log(`  ${line}`),
          state: state.multipart[c.file] ?? null,
          saveState: (s) => {
            if (s) state.multipart[c.file] = s;
            else delete state.multipart[c.file];
            saveState(state);
          },
          onProgress: (bytes, size) => {
            doneBytes = before + bytes;
            const now = Date.now();
            samples.push({ at: now, bytes: doneBytes });
            while (samples.length > 2 && now - samples[0]!.at > 60_000) samples.shift();
            if (now - lastPrint < 2000 && bytes < size) return;
            lastPrint = now;
            const first = samples[0]!;
            const rate = now > first.at ? ((doneBytes - first.bytes) / (now - first.at)) * 1000 : 0;
            const line = `  ${Math.round((bytes / size) * 100)}% of this movie · ${fmtGb(doneBytes)} of ${fmtGb(total)} · ${(rate / 1024 ** 2).toFixed(1)} MB/s · about ${fmtTime((total - doneBytes) / rate)} left`;
            if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(100)}`);
            else console.log(line);
          },
        },
      );
      if (process.stdout.isTTY) process.stdout.write('\n');
      doneBytes = before + c.size;
      const subsLabel = {
        disc: 'subtitles from the disc',
        downloaded: 'subtitles downloaded',
        none: 'no subtitles',
      }[result.subtitles];
      console.log(
        `  ✓ ${result.title} (${result.year}) · ${subsLabel}${result.subtitleNote ? ` (${result.subtitleNote})` : ''}`,
      );
      if (/allowance is used up/.test(result.subtitleNote ?? '')) skipDownloads = true;
      results.push(`✓ ${result.title}`);
    } catch (error) {
      if (process.stdout.isTTY) process.stdout.write('\n');
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ ${message}`);
      results.push(`✗ ${c.folder}: ${message}`);
    }
  }
  console.log(`\nDone in ${fmtTime((Date.now() - started) / 1000)}:`);
  for (const r of results) console.log(`  ${r}`);
  if (results.some((r) => r.startsWith('✗'))) {
    console.log(
      '\nRun the same command again to retry: finished movies are skipped and uploads resume.',
    );
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// upload: TV shows ("TV/Show (Year) [tmdbid-123]/Season 01/Show S01E02.mp4")

interface EpisodeFile {
  show: string;
  showTmdbId: string;
  file: string;
  size: number;
  season: number;
  episode: number;
  endEpisode: number | null;
}

function videosUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...videosUnder(full));
    else if (/\.(mp4|m4v|mkv|mov)$/i.test(entry.name) && !entry.name.startsWith('._'))
      out.push(full);
  }
  return out;
}

async function uploadShows() {
  const tvDir = process.env.TV_DIR ?? '/Volumes/LaCie/TV Shows';
  if (!fs.existsSync(tvDir)) {
    console.log(`\nNo TV folder at ${tvDir} (set TV_DIR in .env if it's elsewhere).`);
    return;
  }
  const r2Config = r2ConfigFromEnv();
  if (!r2Config) {
    console.error('Missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in .env.');
    process.exit(1);
  }
  const tmdb = new Tmdb(need('TMDB_READ_TOKEN'));
  const cloud = cloudClient();
  const r2 = new R2Uploader(r2Config);
  const subs =
    flag('no-subtitles') || !process.env.OPENSUBTITLES_API_KEY
      ? null
      : new OpenSubtitles({
          apiKey: need('OPENSUBTITLES_API_KEY'),
          username: need('OPENSUBTITLES_USERNAME'),
          password: need('OPENSUBTITLES_PASSWORD'),
        });
  const state = loadState();
  for (const m of option('match')) {
    const [folder, id] = m.split('=');
    if (folder && /^\d+$/.test(id ?? '')) state.matches[`tv:${folder.trim()}`] = id!;
  }
  const only = option('only');

  const files: EpisodeFile[] = [];
  const unsure: string[] = [];
  const shows = fs
    .readdirSync(tvDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter(
      (name) => only.length === 0 || only.some((o) => name.toLowerCase().includes(o.toLowerCase())),
    )
    .sort();
  for (const show of shows) {
    const parsed = parseFolderName(show);
    let tmdbId = state.matches[`tv:${show}`] ?? parsed.tmdbId;
    if (!tmdbId) {
      const results = await tmdb.searchShows(parsed.title);
      const match = confidentMatch(results, parsed.title, parsed.year);
      if (match) tmdbId = String(match.id);
      else if (process.stdin.isTTY && !flag('dry-run')) {
        console.log(`\nWhich show is “${show}”?`);
        results
          .slice(0, 6)
          .forEach((r, i) =>
            console.log(`  ${i + 1}. ${r.title} (${r.year ?? '?'}) · tmdb ${r.id}`),
          );
        const answer = await ask('Number, a TMDB id, or Enter to skip: ');
        const pick = /^\d$/.test(answer) ? results[Number(answer) - 1] : null;
        tmdbId = pick ? String(pick.id) : /^\d{2,}$/.test(answer) ? answer : null;
        if (tmdbId) {
          state.matches[`tv:${show}`] = tmdbId;
          saveState(state);
        }
      }
      if (!tmdbId) {
        unsure.push(
          `${show}: ${
            results
              .slice(0, 4)
              .map((r) => `${r.title} (${r.year ?? '?'}) = ${r.id}`)
              .join(' · ') || 'no TMDB results'
          }`,
        );
        continue;
      }
    }
    for (const file of videosUnder(path.join(tvDir, show))) {
      const ep = parseEpisodeFile(path.basename(file));
      if (!ep) continue;
      files.push({ show, showTmdbId: tmdbId, file, size: fs.statSync(file).size, ...ep });
    }
  }

  const inCloud = new Map((await cloud.episodes()).map((e) => [e.id, e]));
  const todo: (EpisodeFile & { sha256: string })[] = [];
  console.log(`\n${files.length} TV episodes in ${tvDir}:`);
  for (const f of files) {
    const sha256 = await cachedHash(state, f.file);
    const id = cloudEpisodeId(cloudShowId(f.showTmdbId), f.season, f.episode);
    const there = inCloud.get(id);
    const done = there && there.video_sha256 === sha256 && there.video_bytes === f.size;
    console.log(
      `  ${done ? '✓' : '·'} ${f.show} S${String(f.season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}  ${fmtGb(f.size)}${done ? '  already in the cloud' : ''}`,
    );
    if (!done) todo.push({ ...f, sha256 });
  }
  if (unsure.length) {
    console.log('\nNot sure which show these are (skipped). Add --match "Folder name=TMDB id":');
    for (const u of unsure) console.log(`  ? ${u}`);
  }
  const total = todo.reduce((sum, f) => sum + f.size, 0);
  console.log(`\nTo upload: ${todo.length} episode(s), ${fmtGb(total)}.`);
  if (flag('dry-run') || todo.length === 0) return;

  let doneBytes = 0;
  const started = Date.now();
  let lastPrint = 0;
  let skipDownloads = false;
  const results: string[] = [];
  for (const [i, f] of todo.entries()) {
    const before = doneBytes;
    console.log(`\n[${i + 1}/${todo.length}] ${path.basename(f.file)}`);
    try {
      const result = await publishEpisode(
        {
          file: f.file,
          showTmdbId: f.showTmdbId,
          season: f.season,
          episode: f.episode,
          endEpisode: f.endEpisode,
          sha256: f.sha256,
          skipDownloads,
        },
        {
          run: runProcess,
          handbrakeCli: process.env.HANDBRAKE_CLI ?? '/usr/local/bin/HandBrakeCLI',
          r2,
          tmdb,
          cloud,
          openSubtitles: subs,
          workDir: path.join(os.tmpdir(), 'wheelhouse-cloud'),
          log: (line) => console.log(`  ${line}`),
          state: state.multipart[f.file] ?? null,
          saveState: (s) => {
            if (s) state.multipart[f.file] = s;
            else delete state.multipart[f.file];
            saveState(state);
          },
          onProgress: (bytes, size) => {
            doneBytes = before + bytes;
            const now = Date.now();
            if (now - lastPrint < 2000 && bytes < size) return;
            lastPrint = now;
            const elapsed = (now - started) / 1000;
            const rate = elapsed > 0 ? doneBytes / elapsed : 0;
            const line = `  ${Math.round((bytes / size) * 100)}% · ${fmtGb(doneBytes)} of ${fmtGb(total)} · about ${fmtTime((total - doneBytes) / (rate || 1))} left`;
            if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(90)}`);
            else console.log(line);
          },
        },
      );
      if (process.stdout.isTTY) process.stdout.write('\n');
      doneBytes = before + f.size;
      console.log(`  ✓ ${result.title}${result.subtitleNote ? ` (${result.subtitleNote})` : ''}`);
      if (/allowance is used up/.test(result.subtitleNote ?? '')) skipDownloads = true;
      results.push(`✓ ${f.show} ${result.title}`);
    } catch (error) {
      if (process.stdout.isTTY) process.stdout.write('\n');
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ ${message}`);
      results.push(`✗ ${path.basename(f.file)}: ${message}`);
    }
  }
  console.log(`\nTV done in ${fmtTime((Date.now() - started) / 1000)}:`);
  for (const r of results) console.log(`  ${r}`);
  if (results.some((r) => r.startsWith('✗'))) {
    console.log('\nRun the same command again to retry: finished episodes are skipped.');
    process.exitCode = 1;
  }
}

async function upload() {
  if (!flag('tv-only')) await uploadMovies();
  if (!flag('movies-only')) await uploadShows();
}

// -----------------------------------------------------------------------------
// people

async function people() {
  const cloud = cloudClient();
  const jf = jellyfin();
  if (!jf) {
    console.error('JELLYFIN_URL and JELLYFIN_API_KEY are needed to read people’s watch history.');
    process.exit(1);
  }
  const adminName = option('admin-name')[0];
  const dbFile =
    process.env.WHEELHOUSE_DB ?? path.resolve(process.env.DATA_DIR ?? 'data', 'wheelhouse.db');
  const db = fs.existsSync(dbFile) ? new DatabaseSync(dbFile, { readOnly: true }) : null;
  const all = <T>(sql: string, ...params: string[]) =>
    db ? (db.prepare(sql).all(...params) as T[]) : ([] as T[]);
  const hasTable = (name: string) =>
    Boolean(db?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

  // Jellyfin item id → cloud movie id (through TMDB ids).
  const inCloud = new Set(
    (await cloud.call<{ movies: { id: string }[] }>('GET', '/library')).movies.map((m) => m.id),
  );
  const idMap = new Map<string, string>();
  for (const item of await jf.movies()) {
    const tmdbId = item.ProviderIds?.Tmdb;
    if (tmdbId && inCloud.has(cloudMovieId(tmdbId))) idMap.set(item.Id, cloudMovieId(tmdbId));
  }
  const mapId = (id: string) => idMap.get(id) ?? null;
  console.log(`${idMap.size} of Jellyfin's movies are in the cloud.`);

  for (const user of await jf.users()) {
    const isAdmin = Boolean(user.Policy?.IsAdministrator);
    const name = isAdmin && adminName ? adminName : user.Name;
    const items = await jf.userMovies(user.Id);
    const state = items
      .filter((i) => mapId(i.Id) && i.UserData)
      .map((i) => ({
        itemId: mapId(i.Id)!,
        played: Boolean(i.UserData!.Played),
        favorite: Boolean(i.UserData!.IsFavorite),
        positionSeconds: Math.round((i.UserData!.PlaybackPositionTicks ?? 0) / 10_000_000),
        playCount: i.UserData!.PlayCount ?? 0,
        lastPlayed: i.UserData!.LastPlayedDate ?? null,
      }))
      .filter((s) => s.played || s.favorite || s.positionSeconds > 0 || s.playCount > 0);
    const uid = user.Id.replace(/-/g, '');
    const prefs = all<{ data: string }>('SELECT data FROM preferences WHERE user_id = ?', uid)[0];
    const collections = all<{
      id: string;
      name: string;
      description: string;
      kind: 'manual' | 'smart';
      rules: string | null;
      visibility: 'private' | 'shared';
      position: number;
      created_at: string;
    }>('SELECT * FROM collections WHERE owner_user_id = ?', uid).map((c) => ({
      name: c.name,
      description: c.description,
      kind: c.kind,
      rules: c.rules,
      visibility: c.visibility,
      position: c.position,
      createdAt: c.created_at,
      items: all<{ item_id: string }>(
        'SELECT item_id FROM collection_items WHERE collection_id = ? ORDER BY position',
        c.id,
      )
        .map((r) => mapId(r.item_id))
        .filter((x): x is string => Boolean(x)),
    }));
    const person = {
      name,
      isAdmin,
      state,
      preferences: prefs ? JSON.parse(prefs.data) : undefined,
      personal: all<{ item_id: string; rating: number | null; notes: string; updated_at: string }>(
        'SELECT * FROM personal_data WHERE user_id = ?',
        uid,
      )
        .filter((r) => mapId(r.item_id))
        .map((r) => ({
          itemId: mapId(r.item_id)!,
          rating: r.rating,
          notes: r.notes,
          updatedAt: r.updated_at,
        })),
      watchlist: hasTable('watchlist')
        ? all<{ item_id: string; added_at: string }>(
            'SELECT * FROM watchlist WHERE user_id = ?',
            uid,
          )
            .filter((r) => mapId(r.item_id))
            .map((r) => ({ itemId: mapId(r.item_id)!, addedAt: r.added_at }))
        : [],
      events: hasTable('watch_events')
        ? all<{ item_id: string; watched_at: string; seconds: number; finished: number }>(
            'SELECT * FROM watch_events WHERE user_id = ?',
            uid,
          )
            .filter((r) => mapId(r.item_id))
            .map((r) => ({
              itemId: mapId(r.item_id)!,
              at: r.watched_at,
              seconds: r.seconds,
              finished: r.finished === 1,
            }))
        : [],
      collections,
      requests: hasTable('movie_requests')
        ? all<{
            title: string;
            year: number | null;
            note: string;
            status: 'open' | 'added' | 'declined';
            item_id: string | null;
            created_at: string;
          }>('SELECT * FROM movie_requests WHERE user_id = ?', uid).map((r) => ({
            title: r.title,
            year: r.year,
            note: r.note,
            status: r.status,
            itemId: r.item_id ? mapId(r.item_id) : null,
            createdAt: r.created_at,
          }))
        : [],
    };
    const result = await cloud.call<{ created: boolean; rows: number }>(
      'POST',
      '/import/person',
      person,
    );
    console.log(
      `${result.created ? '+' : '='} ${name}${isAdmin ? ' (administrator)' : ''}: ${state.length} watched/favourite/resume, ${person.collections.length} collections, ${person.personal.length} ratings/notes, ${person.watchlist.length} on watchlist, ${person.events.length} history entries`,
    );
  }
  console.log('\nNew people are waiting for an invitation: make their links in Settings → People.');
}

async function bootstrap() {
  const name = option('name')[0];
  if (!name) {
    console.error('Give your name: npm run cloud:bootstrap -- --name "Evan"');
    process.exit(1);
  }
  const result = await cloudClient().call<{ url: string; expiresAt: string }>(
    'POST',
    '/bootstrap',
    { name },
  );
  console.log(
    `Your administrator invitation (works once, until ${result.expiresAt.slice(0, 10)}):\n\n  ${result.url}\n`,
  );
}

const commands: Record<string, () => Promise<void>> = { upload, people, bootstrap };
const run = commands[command];
if (!run) {
  console.log(
    'Usage: tsx scripts/cloud.ts upload | people | bootstrap  (see the top of this file)',
  );
} else {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
