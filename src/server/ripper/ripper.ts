import fs from 'node:fs';
import path from 'node:path';
import type { RipCandidate, RipDiscTitle, RipperHealth } from '../../shared/types.js';
import { nowIso } from '../db.js';
import { encodeArgs, parseEncodeProgress, parseScanDuration } from './handbrake.js';
import type { JobRecord, RipJobStore } from './jobs.js';
import {
  chooseMainTitle,
  DRIVE_INSERTED,
  parseDiscInfo,
  parseDrives,
  parseMessages,
  parseProgress,
  type DiscTitle,
} from './makemkv.js';
import { guessTitle, identify, movieFileNames } from './naming.js';
import type { Runner } from './process.js';
import type { JellyfinAdmin, Notifier } from './services.js';

export interface RipperConfig {
  enabled: boolean;
  ripsDir: string;
  moviesDir: string;
  /** Where discs appear when inserted (/Volumes on a Mac). */
  volumesDir: string;
  makemkvcon: string;
  handbrakeCli: string;
  preset: string;
  quality: number;
  minMinutes: number;
  minFreeGb: number;
  ntfyServer: string;
  ntfyTopic: string | null;
  /** Address used in notification links, e.g. http://wheelhouse.local:8787 */
  publicUrl: string | null;
  jellyfinApiKey: string | null;
  pollMs: number;
  importTimeoutMs: number;
  importPollMs: number;
}

export interface RipperDeps {
  config: RipperConfig;
  jobs: RipJobStore;
  run: Runner;
  jellyfin: JellyfinAdmin | null;
  notifier: Notifier;
  /** Called after a movie is added, so Wheelhouse refreshes its library index. */
  onImported?: () => void;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

class UserError extends Error {}

const DISC_MARKERS = ['VIDEO_TS', 'BDMV'];
const RECENT_DISC_MS = 6 * 3600_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(error: unknown): string {
  if (error instanceof UserError) return error.message;
  const e = error as NodeJS.ErrnoException;
  if (e?.code === 'ENOENT' && e.path) return `Program not found: ${e.path}`;
  if (e?.code === 'EACCES' || e?.code === 'EPERM') {
    return `macOS blocked access to ${e.path ?? 'a folder'}. Allow Wheelhouse (node) to access removable volumes in System Settings → Privacy & Security.`;
  }
  return e instanceof Error ? e.message : String(error);
}

/**
 * Automatic disc ripping: insert a disc and it is ripped with MakeMKV, ejected,
 * compressed with HandBrake, named, filed into the Movies folder, added to
 * Jellyfin, and announced with a notification.
 *
 * Discs are read one at a time (one drive); compression runs separately, so the
 * next disc can be ripped while the previous one compresses.
 */
export class Ripper {
  private timer: NodeJS.Timeout | null = null;
  private readonly seenMounts = new Set<string>();
  private discBusy = false;
  private encoderBusy = false;
  private polling = false;
  private stopped = true;
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(private readonly deps: RipperDeps) {
    this.log = deps.logger ?? console;
  }

  get config() {
    return this.deps.config;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.recover();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.config.pollMs);
    this.kickEncoder();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Put jobs interrupted by a restart back into a sensible state. */
  private recover() {
    const { jobs } = this.deps;
    for (const job of jobs.withStatus('scanning', 'ripping')) {
      this.fail(job, 'Wheelhouse restarted while the disc was being read. Insert the disc again.');
    }
    for (const job of jobs.withStatus('encoding')) {
      jobs.update(job.id, { status: 'ripped', progress: null, message: null });
    }
    for (const job of jobs.withStatus('filing', 'importing')) {
      void this.finish(job.id);
    }
  }

  health(): RipperHealth {
    const c = this.config;
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!fs.existsSync(c.makemkvcon)) {
      problems.push(`MakeMKV’s command-line tool wasn’t found at ${c.makemkvcon}.`);
    }
    if (!fs.existsSync(c.handbrakeCli)) {
      problems.push(`HandBrakeCLI wasn’t found at ${c.handbrakeCli}.`);
    }
    for (const [label, dir] of [
      ['Rips', c.ripsDir],
      ['Movies', c.moviesDir],
    ] as const) {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        problems.push(
          code === 'ENOENT'
            ? `The ${label} folder ${dir} doesn’t exist (is the drive plugged in?).`
            : `Wheelhouse can’t write to the ${label} folder ${dir} (${code}).`,
        );
      }
    }
    if (!this.deps.jellyfin) {
      warnings.push(
        'No Jellyfin API key: movies are filed, but naming help and instant library updates are off.',
      );
    }
    if (!c.ntfyTopic) warnings.push('Phone notifications are off (no ntfy topic set).');
    return {
      enabled: true,
      problems,
      warnings,
      watching: !this.stopped,
      canSearch: Boolean(this.deps.jellyfin),
    };
  }

  // ---------------------------------------------------------------------------
  // Disc detection

  private discMounts(): { mount: string; label: string }[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.config.volumesDir);
    } catch {
      return [];
    }
    const discs: { mount: string; label: string }[] = [];
    for (const name of entries) {
      const mount = path.join(this.config.volumesDir, name);
      if (DISC_MARKERS.some((m) => fs.existsSync(path.join(mount, m)))) {
        discs.push({ mount, label: name });
      }
    }
    return discs;
  }

  /** Check for newly inserted discs. Public so tests can drive it. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const present = this.discMounts();
      const mounts = new Set(present.map((d) => d.mount));
      for (const mount of [...this.seenMounts])
        if (!mounts.has(mount)) this.seenMounts.delete(mount);

      // A disc waiting for a title choice was taken out: nothing more can be done.
      for (const job of this.deps.jobs.withStatus('needs_choice')) {
        if (!mounts.has(job.mountPath)) {
          this.fail(job, 'The disc was removed before a title was chosen. Insert it again.');
        }
      }

      if (this.discBusy) return;
      for (const disc of present) {
        if (this.seenMounts.has(disc.mount)) continue;
        this.seenMounts.add(disc.mount);
        const waiting = this.deps.jobs
          .withStatus('needs_choice')
          .find((j) => j.mountPath === disc.mount);
        if (waiting) continue;
        const recent = this.deps.jobs.recentForLabel(disc.label, RECENT_DISC_MS);
        if (recent) {
          this.log.info(`Disc ${disc.label} was already ripped recently; ignoring it.`);
          continue;
        }
        const job = this.deps.jobs.create({ discLabel: disc.label, mountPath: disc.mount });
        this.log.info(`Disc inserted: ${disc.label}`);
        void this.runDisc(job.id);
        break; // one drive at a time
      }
    } finally {
      this.polling = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 1: scan and rip (holds the drive)

  private async runDisc(id: string, chosenIndex?: number) {
    this.discBusy = true;
    try {
      let job = this.deps.jobs.get(id)!;
      let title: DiscTitle | RipDiscTitle | undefined;
      if (chosenIndex === undefined) {
        const scan = await this.scan(job);
        job = scan.job;
        const choice = chooseMainTitle(scan.titles, this.config.minMinutes);
        if (choice.kind === 'ambiguous') {
          this.deps.jobs.update(id, {
            status: 'needs_choice',
            message: choice.reason,
            discTitles: choice.candidates.map(publicTitle),
            progress: null,
          });
          await this.notify(job, 'needs a hand', choice.reason);
          return;
        }
        title = choice.title;
      } else {
        title = job.discTitles.find((t) => t.index === chosenIndex);
        if (!title) throw new UserError('That title is not on this disc.');
      }
      await this.rip(job, title);
    } catch (error) {
      this.fail(this.deps.jobs.get(id)!, describe(error));
    } finally {
      this.discBusy = false;
    }
    // Another disc may have been inserted meanwhile.
    void this.poll();
  }

  private async scan(job: JobRecord) {
    const { run, jobs } = this.deps;
    const c = this.config;
    jobs.update(job.id, { status: 'scanning', message: 'Reading the disc…', progress: null });

    const list = await run(c.makemkvcon, ['-r', '--cache=1', 'info', 'disc:9999']);
    const inserted = parseDrives(list.output).filter((d) => d.state === DRIVE_INSERTED);
    const drive =
      inserted.find((d) => d.discName === job.discLabel) ??
      (inserted.length === 1 ? inserted[0] : undefined);
    if (!drive) {
      throw new UserError(
        inserted.length
          ? 'Several discs are inserted and MakeMKV can’t tell which is which. Leave one in.'
          : 'MakeMKV can’t see the disc. Close the MakeMKV app if it’s open, then insert the disc again.',
      );
    }

    const result = await run(c.makemkvcon, ['-r', 'info', `disc:${drive.index}`]);
    const info = parseDiscInfo(result.output);
    if (info.titles.length === 0) {
      const why = parseMessages(result.output).slice(-2).join(' ');
      // "OS access mode" / "Failed to open disc": macOS refused raw access to the drive.
      const permission = /OS access mode|Failed to open disc/i.test(why)
        ? ' macOS is probably blocking access to the drive: in System Settings → Privacy & Security → Full Disk Access, turn on “node” (/usr/local/bin/node) and MakeMKV, restart Wheelhouse, then press Retry.'
        : '';
      throw new UserError(`MakeMKV couldn’t read the disc. ${why}${permission}`.trim());
    }

    const guess = guessTitle(info.name, job.discLabel);
    const updated = jobs.update(job.id, {
      driveIndex: drive.index,
      discName: info.name,
      guess,
      discTitles: info.titles.map(publicTitle),
    });
    await this.identify(updated, guess);
    return { job: jobs.get(job.id)!, titles: info.titles };
  }

  /** Look the guessed title up; fill in the movie if the match is certain. */
  private async identify(job: JobRecord, guess: string) {
    if (!this.deps.jellyfin || job.title) return;
    try {
      const results = await this.deps.jellyfin.searchMovies(guess);
      const outcome = identify(guess, results);
      if (outcome.kind === 'confident') {
        const m = outcome.match;
        this.deps.jobs.update(job.id, {
          title: m.title,
          year: m.year,
          tmdbId: m.tmdbId,
          imdbId: m.imdbId,
          candidates: [m],
        });
      } else {
        this.deps.jobs.update(job.id, { candidates: outcome.candidates });
      }
    } catch (error) {
      this.log.warn(`Movie lookup failed for “${guess}”:`, describe(error));
    }
  }

  private async rip(job: JobRecord, title: DiscTitle | RipDiscTitle) {
    const { run, jobs } = this.deps;
    const c = this.config;
    this.ensureFreeSpace();
    const dir = this.jobDir(job.id);
    fs.mkdirSync(dir, { recursive: true });
    jobs.update(job.id, {
      status: 'ripping',
      titleIndex: title.index,
      sourceSeconds: title.durationSeconds,
      message: null,
      progress: 0,
    });

    const progress = this.progressWriter(job.id);
    const result = await run(
      c.makemkvcon,
      ['-r', '--progress=-same', 'mkv', `disc:${job.driveIndex ?? 0}`, String(title.index), dir],
      {
        onLine: (line) => {
          const p = parseProgress(line);
          if (p !== null) progress(p);
        },
      },
    );
    const mkv = this.findFile(dir, '.mkv');
    if (result.code !== 0 || !mkv) {
      const why = parseMessages(result.output).slice(-2).join(' ');
      throw new UserError(`Ripping failed. ${why}`.trim());
    }

    await this.eject(job.mountPath);
    jobs.update(job.id, { status: 'ripped', progress: null, message: 'Waiting to be compressed' });
    this.kickEncoder();
  }

  private async eject(mount: string) {
    const { run } = this.deps;
    try {
      const result = await run('/usr/bin/drutil', ['eject']);
      if (result.code === 0) return;
    } catch {
      /* fall through */
    }
    try {
      await run('/usr/sbin/diskutil', ['eject', mount]);
    } catch (error) {
      this.log.warn('Could not eject the disc:', describe(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 2: compress (one at a time, independent of the drive)

  private kickEncoder() {
    if (this.encoderBusy || this.stopped) return;
    const next = this.deps.jobs.withStatus('ripped')[0];
    if (!next) return;
    this.encoderBusy = true;
    void this.encode(next)
      .catch((error) => this.fail(this.deps.jobs.get(next.id)!, describe(error)))
      .finally(() => {
        this.encoderBusy = false;
        this.kickEncoder();
      });
  }

  private async encode(job: JobRecord) {
    const { run, jobs } = this.deps;
    const c = this.config;
    const dir = this.jobDir(job.id);
    const mkv = this.findFile(dir, '.mkv');
    if (!mkv) throw new UserError('The ripped file is missing from the Rips folder.');
    const output = path.join(dir, 'compressed.mp4');
    fs.rmSync(output, { force: true });
    jobs.update(job.id, { status: 'encoding', progress: 0, message: null });

    const progress = this.progressWriter(job.id);
    try {
      const result = await run(c.handbrakeCli, encodeArgs(mkv, output, c.preset, c.quality), {
        onLine: (line) => {
          const p = parseEncodeProgress(line);
          if (p !== null) progress(p);
        },
      });
      if (result.code !== 0 || !fs.existsSync(output)) {
        const tail = result.output.trim().split(/\r?\n/).slice(-1)[0] ?? '';
        throw new UserError(`HandBrake couldn’t compress the movie. ${tail}`.trim());
      }

      // Check the result is complete before the original is deleted.
      const scan = await run(c.handbrakeCli, ['--scan', '-i', output]);
      const seconds = parseScanDuration(scan.output);
      const expected = job.sourceSeconds ?? 0;
      const size = fs.statSync(output).size;
      const tolerance = Math.max(60, expected * 0.02);
      if (
        !seconds ||
        size < 1_000_000 ||
        (expected > 0 && Math.abs(seconds - expected) > tolerance)
      ) {
        throw new UserError(
          `The compressed movie looks incomplete (${Math.round((seconds ?? 0) / 60)} of ${Math.round(expected / 60)} minutes). The original rip is kept, so you can retry.`,
        );
      }
    } catch (error) {
      // Never leave a partial file that a retry could mistake for a finished one.
      fs.rmSync(output, { force: true });
      throw error;
    }

    jobs.update(job.id, { status: 'filing', progress: null, message: null });
    await this.finish(job.id);
  }

  // ---------------------------------------------------------------------------
  // Stage 3: name, file, import, announce

  private async finish(id: string) {
    let job = this.deps.jobs.get(id);
    if (!job) return;
    try {
      if (job.status === 'filing') {
        if (!job.title) {
          const reason =
            job.candidates.length > 1
              ? 'Which movie is this? Pick the right one.'
              : `Confirm the movie’s name${job.guess ? ` (best guess: “${job.guess}”)` : ''}.`;
          this.deps.jobs.update(id, { status: 'needs_name', message: reason });
          await this.notify(job, 'needs a name', reason);
          return;
        }
        job = this.file(job);
        if (job.status !== 'importing') return;
      }
      if (job.status === 'importing') await this.importIntoJellyfin(job);
    } catch (error) {
      this.fail(this.deps.jobs.get(id)!, describe(error));
    }
  }

  private file(job: JobRecord): JobRecord {
    const { jobs } = this.deps;
    const names = movieFileNames({ title: job.title!, year: job.year, tmdbId: job.tmdbId });
    const folder = path.join(this.config.moviesDir, names.folder);
    const target = path.join(folder, names.file);
    const source = path.join(this.jobDir(job.id), 'compressed.mp4');

    if (!fs.existsSync(source)) {
      // Already moved before a restart?
      if (fs.existsSync(target))
        return jobs.update(job.id, { status: 'importing', moviePath: target });
      throw new UserError('The compressed movie is missing from the Rips folder.');
    }
    if (fs.existsSync(target)) {
      const message = `“${names.file}” is already in your Movies folder. Pick a different name, or dismiss this rip.`;
      jobs.update(job.id, { status: 'needs_name', message });
      void this.notify(job, 'needs a name', message);
      return jobs.get(job.id)!;
    }

    jobs.update(job.id, { message: 'Moving into your Movies folder…' });
    fs.mkdirSync(folder, { recursive: true });
    try {
      fs.renameSync(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      fs.copyFileSync(source, target);
      fs.rmSync(source);
    }
    // The original rip is only removed once the movie is safely in place.
    fs.rmSync(this.jobDir(job.id), { recursive: true, force: true });
    return jobs.update(job.id, {
      status: 'importing',
      moviePath: target,
      message: 'Adding to Jellyfin…',
    });
  }

  private async importIntoJellyfin(job: JobRecord) {
    const { jellyfin, jobs } = this.deps;
    const label = job.year ? `${job.title} (${job.year})` : job.title!;
    let movieId: string | null = null;
    if (jellyfin) {
      await jellyfin.refreshLibrary();
      const folder = movieFileNames({
        title: job.title!,
        year: job.year,
        tmdbId: job.tmdbId,
      }).folder;
      const deadline = Date.now() + this.config.importTimeoutMs;
      while (!movieId && Date.now() < deadline && !this.stopped) {
        await sleep(this.config.importPollMs);
        try {
          movieId = await jellyfin.findMovieByFolder(job.title!, folder);
        } catch (error) {
          this.log.warn('Checking Jellyfin for the new movie failed:', describe(error));
        }
      }
    }
    this.deps.onImported?.();
    const done = jobs.update(job.id, {
      status: 'done',
      movieId,
      progress: null,
      message:
        movieId || !jellyfin
          ? null
          : 'Filed. Jellyfin hasn’t listed it yet; it will appear after its next scan.',
      finishedAt: nowIso(),
    });
    const base = this.config.publicUrl;
    await this.deps.notifier.send({
      title: '🎬 New on Wheelhouse',
      message: `${label} is ready to watch.`,
      click: base ? (movieId ? `${base}/movie/${movieId}` : `${base}/`) : undefined,
      tags: ['movie_camera'],
    });
    this.log.info(`Added ${label} (${done.moviePath})`);
  }

  // ---------------------------------------------------------------------------
  // Actions from the Rips page

  chooseTitle(id: string, index: number) {
    const job = this.requireJob(id);
    if (job.status !== 'needs_choice') throw new UserError('This disc isn’t waiting for a choice.');
    if (!job.discTitles.some((t) => t.index === index))
      throw new UserError('That title is not on this disc.');
    if (this.discBusy) throw new UserError('The drive is busy with another disc.');
    if (!fs.existsSync(job.mountPath)) throw new UserError('The disc is no longer in the drive.');
    this.deps.jobs.update(id, { status: 'ripping', message: null, progress: 0 });
    void this.runDisc(id, index);
    return this.deps.jobs.get(id)!;
  }

  resolveName(id: string, movie: RipCandidate) {
    const job = this.requireJob(id);
    if (job.status === 'done' || job.status === 'dismissed')
      throw new UserError('This rip is already finished.');
    const title = movie.title.trim();
    if (!title) throw new UserError('Enter the movie’s title.');
    const year =
      movie.year && movie.year > 1880 && movie.year < 2100 ? Math.round(movie.year) : null;
    this.deps.jobs.update(id, {
      title,
      year,
      tmdbId: movie.tmdbId && /^\d+$/.test(movie.tmdbId) ? movie.tmdbId : null,
      imdbId: movie.imdbId && /^tt\d+$/.test(movie.imdbId) ? movie.imdbId : null,
      message: null,
    });
    if (job.status === 'needs_name') {
      this.deps.jobs.update(id, { status: 'filing' });
      void this.finish(id);
    }
    return this.deps.jobs.get(id)!;
  }

  retry(id: string) {
    const job = this.requireJob(id);
    if (job.status !== 'failed') throw new UserError('Only failed rips can be retried.');
    const dir = this.jobDir(job.id);
    if (fs.existsSync(path.join(dir, 'compressed.mp4'))) {
      // Compression finished; only the last steps need repeating.
      this.deps.jobs.update(id, { status: 'filing', message: null });
      void this.finish(id);
    } else if (this.findFile(dir, '.mkv')) {
      this.deps.jobs.update(id, {
        status: 'ripped',
        message: 'Waiting to be compressed',
        progress: null,
      });
      this.kickEncoder();
    } else if (fs.existsSync(job.mountPath)) {
      // Failed while reading the disc, and it is still in the drive: start again.
      if (this.discBusy)
        throw new UserError('The drive is busy with another disc. Try again shortly.');
      this.deps.jobs.update(id, {
        status: 'scanning',
        message: 'Reading the disc…',
        progress: null,
      });
      void this.runDisc(id);
    } else {
      throw new UserError('Nothing was saved from this disc. Insert it again to start over.');
    }
    return this.deps.jobs.get(id)!;
  }

  dismiss(id: string) {
    const job = this.requireJob(id);
    if (['scanning', 'ripping', 'encoding', 'filing', 'importing'].includes(job.status)) {
      throw new UserError('This disc is still being worked on.');
    }
    // Leftover rip files go too; a finished movie in the Movies folder is never touched.
    fs.rmSync(this.jobDir(id), { recursive: true, force: true });
    this.deps.jobs.update(id, { status: 'dismissed', progress: null });
  }

  listJobs() {
    return this.deps.jobs.list();
  }

  async search(query: string): Promise<RipCandidate[]> {
    if (!this.deps.jellyfin)
      throw new UserError('Searching needs a Jellyfin API key (run npm run setup:ripper).');
    return this.deps.jellyfin.searchMovies(query.trim().slice(0, 120));
  }

  isUserError(error: unknown): error is Error {
    return error instanceof UserError;
  }

  // ---------------------------------------------------------------------------
  // Helpers

  private requireJob(id: string): JobRecord {
    const job = this.deps.jobs.get(id);
    if (!job || job.status === 'dismissed') throw new UserError('That rip no longer exists.');
    return job;
  }

  private jobDir(id: string) {
    return path.join(this.config.ripsDir, `wheelhouse-${id}`);
  }

  private findFile(dir: string, ext: string): string | null {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const files = entries
      .filter((f) => f.toLowerCase().endsWith(ext))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return files[0] ?? null;
  }

  private ensureFreeSpace() {
    const need = this.config.minFreeGb * 1024 ** 3;
    try {
      const stats = fs.statfsSync(this.config.ripsDir);
      const free = stats.bavail * stats.bsize;
      if (free < need) {
        throw new UserError(
          `Not enough space on the drive: ${(free / 1024 ** 3).toFixed(1)} GB free, ${this.config.minFreeGb} GB needed.`,
        );
      }
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError(
        `The Rips folder ${this.config.ripsDir} isn’t available: ${describe(error)}`,
      );
    }
  }

  /** Throttled progress updates (the database is written at most every 2%). */
  private progressWriter(id: string) {
    let last = -1;
    return (p: number) => {
      if (p - last < 0.02 && p < 1) return;
      last = p;
      this.deps.jobs.update(id, { progress: Math.round(p * 1000) / 1000 });
    };
  }

  private fail(job: JobRecord, message: string) {
    if (!job || job.status === 'dismissed') return;
    this.deps.jobs.update(job.id, { status: 'failed', message, progress: null });
    this.log.warn(`Rip of ${job.discLabel} failed: ${message}`);
    void this.notify(job, 'had a problem', message);
  }

  private async notify(job: JobRecord, what: string, message: string) {
    const name = job.title ?? job.guess ?? job.discLabel;
    const base = this.config.publicUrl;
    await this.deps.notifier.send({
      title: `Disc “${name}” ${what}`,
      message,
      click: base ? `${base}/rips` : undefined,
      priority: 'high',
      tags: ['warning'],
    });
  }
}

function publicTitle(t: DiscTitle | RipDiscTitle): RipDiscTitle {
  return {
    index: t.index,
    durationSeconds: t.durationSeconds,
    sizeBytes: t.sizeBytes,
    chapters: t.chapters,
  };
}
