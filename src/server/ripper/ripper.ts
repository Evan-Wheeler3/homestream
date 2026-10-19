import fs from 'node:fs';
import path from 'node:path';
import type {
  RipCandidate,
  RipDiscTitle,
  RipEpisode,
  RipKind,
  RipperHealth,
} from '../../shared/types.js';
import { nowIso } from '../db.js';
import { encodeArgs, parseEncodeProgress, parseScanDuration } from './handbrake.js';
import type { JobRecord, RipJobStore } from './jobs.js';
import {
  chooseMainTitle,
  classifyDisc,
  DRIVE_INSERTED,
  parseDiscInfo,
  parseDrives,
  parseMessages,
  isCopyPhase,
  parseProgress,
  parseProgressTitle,
  type DiscTitle,
  readErrorHint,
} from './makemkv.js';
import { episodeFileNames, guessTitle, guessTv, identify, movieFileNames } from './naming.js';
import type { Runner } from './process.js';
import type { JellyfinAdmin, Notifier } from './services.js';

export interface RipperConfig {
  enabled: boolean;
  ripsDir: string;
  moviesDir: string;
  /** Where TV episodes are filed (Jellyfin "Shows" library). */
  tvDir: string;
  /** Where discs appear when inserted (/Volumes on a Mac). */
  volumesDir: string;
  makemkvcon: string;
  handbrakeCli: string;
  preset: string;
  quality: number;
  /** Subtitle languages kept when compressing (ISO 639-2, e.g. "eng"); empty = none. */
  subtitleLanguages: string[];
  minMinutes: number;
  minFreeGb: number;
  /** Quit the Mac's DVD Player, which opens and starts playing when a DVD is inserted. */
  closeDvdPlayer: boolean;
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

/** How long a rip may go without progress before the Discs page warns about it. */
const STALL_MS = 15 * 60_000;
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
  /** Stops the current read or rip when its job is dismissed. */
  private discAbort: { jobId: string; controller: AbortController } | null = null;
  private encoderBusy = false;
  private polling = false;
  private stopped = true;
  /** Set when Jellyfin has no Shows library for the TV folder (checked in the background). */
  private tvLibraryWarning: string | null = null;
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
    void this.checkTvLibrary();
  }

  /** Warn when Jellyfin has no Shows library that covers the TV folder. */
  private async checkTvLibrary() {
    if (!this.deps.jellyfin) return;
    try {
      const folders = await this.deps.jellyfin.libraryFolders('tvshows');
      const tv = path.resolve(this.config.tvDir);
      const covered = folders.some((f) => {
        const rel = path.relative(path.resolve(f), tv);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      });
      this.tvLibraryWarning = covered
        ? null
        : `Jellyfin has no Shows library for ${this.config.tvDir}, so ripped TV episodes won’t appear. In Jellyfin: Dashboard → Libraries → Add Media Library → Shows, folder ${this.config.tvDir}.`;
    } catch (error) {
      this.log.warn('Could not check Jellyfin’s libraries:', describe(error));
    }
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
      ...(fs.existsSync(c.tvDir) ? [['TV', c.tvDir] as const] : []),
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
    if (this.tvLibraryWarning) warnings.push(this.tvLibraryWarning);
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
      for (const job of this.deps.jobs.withStatus('needs_choice', 'needs_episodes')) {
        if (!mounts.has(job.mountPath)) {
          this.fail(
            job,
            job.status === 'needs_episodes'
              ? 'The disc was removed before the episodes were confirmed. Insert it again.'
              : 'The disc was removed before a title was chosen. Insert it again.',
          );
        }
      }

      if (this.discBusy) return;
      for (const disc of present) {
        if (this.seenMounts.has(disc.mount)) continue;
        this.seenMounts.add(disc.mount);
        const waiting = this.deps.jobs
          .withStatus('needs_choice', 'needs_episodes')
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
    const abort = new AbortController();
    this.discAbort = { jobId: id, controller: abort };
    try {
      await this.closeDvdPlayer();
      let job = this.deps.jobs.get(id)!;
      let title: DiscTitle | RipDiscTitle | undefined;
      if (chosenIndex === undefined) {
        const scan = await this.scan(job);
        job = scan.job;
        const disc = classifyDisc(scan.titles);
        if (disc.kind === 'tv') {
          await this.askForEpisodes(job, disc.episodes);
          return;
        }
        await this.identify(job, job.guess ?? job.discLabel);
        job = this.deps.jobs.get(id)!;
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
      this.discAbort = null;
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

    const result = await run(c.makemkvcon, ['-r', 'info', `disc:${drive.index}`], {
      signal: this.signalFor(job.id),
    });
    const info = parseDiscInfo(result.output);
    if (info.titles.length === 0) {
      const messages = parseMessages(result.output);
      const why = messages.slice(-2).join(' ');
      throw new UserError(
        `MakeMKV couldn’t read the disc. ${why} ${readErrorHint(messages.join(' '))}`.trim(),
      );
    }

    const guess = guessTitle(info.name, job.discLabel);
    const updated = jobs.update(job.id, {
      driveIndex: drive.index,
      discName: info.name,
      guess,
      discTitles: info.titles.map(publicTitle),
    });
    return { job: updated, titles: info.titles };
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

  // ---------------------------------------------------------------------------
  // TV discs: confirm the show, season and episodes, then rip each episode

  /** Suggest the show, season and episode numbers, and wait for the user to confirm. */
  private async askForEpisodes(job: JobRecord, episodes: (DiscTitle | RipDiscTitle)[]) {
    const { jobs } = this.deps;
    const tv = guessTv(job.discName, job.discLabel);
    let show: RipCandidate | null = null;
    let candidates: RipCandidate[] = [];
    if (this.deps.jellyfin) {
      try {
        const outcome = identify(tv.show, await this.deps.jellyfin.searchShows(tv.show), 'show');
        if (outcome.kind === 'confident') show = outcome.match;
        candidates = outcome.kind === 'confident' ? [outcome.match] : outcome.candidates;
      } catch (error) {
        this.log.warn(`Show lookup failed for “${tv.show}”:`, describe(error));
      }
    }
    const season = tv.season ?? 1;
    // Carry on from the last disc of this season; failing that, guess from the disc number.
    const previous = jobs.lastEpisode(
      { title: show?.title ?? tv.show, tmdbId: show?.tmdbId ?? null },
      season,
    );
    const first =
      previous > 0
        ? previous + 1
        : tv.disc && tv.disc > 1
          ? (tv.disc - 1) * episodes.length + 1
          : 1;
    const message = 'Check the show, season and episode numbers, then start ripping.';
    const updated = jobs.update(job.id, {
      kind: 'tv',
      status: 'needs_episodes',
      guess: tv.show,
      title: show?.title ?? null,
      year: show?.year ?? null,
      tmdbId: show?.tmdbId ?? null,
      imdbId: show?.imdbId ?? null,
      candidates,
      season,
      episodes: [...episodes]
        .sort((a, b) => a.index - b.index)
        .map((t, i) => ({
          titleIndex: t.index,
          durationSeconds: t.durationSeconds,
          episode: first + i,
          state: 'pending' as const,
          path: null,
        })),
      message,
      progress: null,
    });
    await this.notify(updated, 'needs a hand', message);
  }

  /** The user confirmed a TV disc: rip the chosen titles as these episodes. */
  ripEpisodes(
    id: string,
    input: {
      show: RipCandidate;
      season: number;
      episodes: { titleIndex: number; episode: number }[];
    },
  ) {
    const job = this.requireJob(id);
    if (job.status !== 'needs_episodes' && job.status !== 'needs_choice') {
      throw new UserError('This disc isn’t waiting for episodes to be chosen.');
    }
    const title = input.show.title.trim();
    if (!title) throw new UserError('Enter the show’s name.');
    if (!Number.isInteger(input.season) || input.season < 0 || input.season > 99) {
      throw new UserError('Enter a season number between 0 and 99.');
    }
    if (input.episodes.length === 0) throw new UserError('Pick at least one episode to rip.');
    const numbers = new Set<number>();
    const titles = new Set<number>();
    for (const ep of input.episodes) {
      if (!job.discTitles.some((t) => t.index === ep.titleIndex)) {
        throw new UserError('That title is not on this disc.');
      }
      if (!Number.isInteger(ep.episode) || ep.episode < 1 || ep.episode > 999) {
        throw new UserError('Episode numbers must be whole numbers from 1.');
      }
      if (numbers.has(ep.episode)) throw new UserError(`Episode ${ep.episode} is used twice.`);
      if (titles.has(ep.titleIndex)) throw new UserError('Each title can only be one episode.');
      numbers.add(ep.episode);
      titles.add(ep.titleIndex);
    }
    if (this.discBusy) throw new UserError('The drive is busy with another disc.');
    if (!fs.existsSync(job.mountPath)) throw new UserError('The disc is no longer in the drive.');
    const year =
      input.show.year && input.show.year > 1880 && input.show.year < 2100
        ? Math.round(input.show.year)
        : null;
    this.deps.jobs.update(id, {
      kind: 'tv',
      title,
      year,
      tmdbId: input.show.tmdbId && /^\d+$/.test(input.show.tmdbId) ? input.show.tmdbId : null,
      imdbId: input.show.imdbId && /^tt\d+$/.test(input.show.imdbId) ? input.show.imdbId : null,
      season: input.season,
      episodes: [...input.episodes]
        .sort((a, b) => a.episode - b.episode)
        .map((ep) => ({
          titleIndex: ep.titleIndex,
          durationSeconds:
            job.discTitles.find((t) => t.index === ep.titleIndex)?.durationSeconds ?? 0,
          episode: ep.episode,
          state: 'pending',
          path: null,
        })),
      status: 'ripping',
      message: null,
      progress: 0,
    });
    void this.runEpisodes(id);
    return this.deps.jobs.get(id)!;
  }

  /** Correct a wrong guess: treat a waiting disc as a movie or as TV episodes. */
  async setKind(id: string, kind: RipKind) {
    const job = this.requireJob(id);
    if (job.status !== 'needs_episodes' && job.status !== 'needs_choice') {
      throw new UserError('This disc can only be changed while it waits for you.');
    }
    if (kind === 'tv') {
      if (job.status === 'needs_episodes') return job;
      const titles = job.discTitles.map((t) => ({
        ...t,
        name: '',
        segments: '',
        outputFile: '',
      }));
      const disc = classifyDisc(titles);
      const episodes =
        disc.kind === 'tv'
          ? disc.episodes
          : titles.filter((t) => t.durationSeconds >= 10 * 60 && t.durationSeconds <= 75 * 60);
      await this.askForEpisodes(job, episodes);
    } else {
      if (job.status === 'needs_choice') return job;
      this.deps.jobs.update(id, {
        kind: 'movie',
        status: 'needs_choice',
        season: null,
        episodes: [],
        title: null,
        year: null,
        tmdbId: null,
        imdbId: null,
        candidates: [],
        guess: guessTitle(job.discName, job.discLabel),
        discTitles: [...job.discTitles].sort((a, b) => b.durationSeconds - a.durationSeconds),
        message: 'Pick the movie’s title on the disc.',
      });
    }
    return this.deps.jobs.get(id)!;
  }

  private async runEpisodes(id: string) {
    this.discBusy = true;
    this.discAbort = { jobId: id, controller: new AbortController() };
    try {
      await this.ripEachEpisode(this.deps.jobs.get(id)!);
    } catch (error) {
      this.fail(this.deps.jobs.get(id)!, describe(error));
    } finally {
      this.discBusy = false;
      this.discAbort = null;
    }
    void this.poll();
  }

  private async ripEachEpisode(job: JobRecord) {
    const { jobs } = this.deps;
    this.ensureFreeSpace();
    await this.closeDvdPlayer();
    const episodes = job.episodes.map((ep) => ({ ...ep }));
    const todo = episodes.filter((ep) => ep.state === 'pending');
    const progress = this.progressWriter(job.id);
    for (const [i, ep] of todo.entries()) {
      const dir = this.episodeDir(job.id, ep);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const label = `Episode ${ep.episode} (${i + 1} of ${todo.length})`;
      jobs.update(job.id, { message: label });
      await this.ripTitle(job, ep.titleIndex, dir, {
        label,
        what: `Ripping episode ${ep.episode}`,
        progress: (p) => progress((i + p) / todo.length),
      });
      ep.state = 'ripped';
      jobs.update(job.id, { episodes });
    }

    await this.eject(job.mountPath);
    jobs.update(job.id, { status: 'ripped', progress: null, message: 'Waiting to be compressed' });
    this.kickEncoder();
  }

  private episodeDir(id: string, ep: RipEpisode) {
    return path.join(this.jobDir(id), `episode-${ep.titleIndex}`);
  }

  private async rip(job: JobRecord, title: DiscTitle | RipDiscTitle) {
    const { jobs } = this.deps;
    this.ensureFreeSpace();
    // Again, in case DVD Player opened after the disc was first noticed.
    await this.closeDvdPlayer();
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
    await this.ripTitle(job, title.index, dir, { label: null, what: 'Ripping', progress });

    await this.eject(job.mountPath);
    jobs.update(job.id, { status: 'ripped', progress: null, message: 'Waiting to be compressed' });
    this.kickEncoder();
  }

  /**
   * Copy one title off the disc into `dir` with MakeMKV. Throws when it fails,
   * is stopped, or leaves no MKV behind.
   */
  private async ripTitle(
    job: JobRecord,
    titleIndex: number,
    dir: string,
    report: {
      /** Shown before the phase message, e.g. "Episode 3 (1 of 4)". */
      label: string | null;
      /** Start of the error message, e.g. "Ripping episode 3". */
      what: string;
      progress: (p: number) => void;
    },
  ) {
    const { run, jobs } = this.deps;
    const message = (text: string | null) =>
      [report.label, text].filter(Boolean).join(' · ') || null;
    // MakeMKV first opens and analyses the disc, with its own progress that
    // reaches 100% before any copying starts; only the copy counts here.
    let copying = true;
    let lastActivity = Date.now();
    let lastValue = -1;
    let warned = false;
    const watchdog = setInterval(() => {
      if (warned || Date.now() - lastActivity < STALL_MS) return;
      warned = true;
      jobs.update(job.id, {
        message:
          'No progress for 15 minutes. MakeMKV is probably retrying parts of the disc it can’t read: it may be scratched or dirty. Press Stop, clean the disc and insert it again.',
      });
    }, 60_000);
    watchdog.unref?.();
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(
        this.config.makemkvcon,
        ['-r', '--progress=-same', 'mkv', `disc:${job.driveIndex ?? 0}`, String(titleIndex), dir],
        {
          signal: this.signalFor(job.id),
          onLine: (line) => {
            const phase = parseProgressTitle(line);
            if (phase !== null) {
              copying = isCopyPhase(phase);
              lastActivity = Date.now();
              if (copying) report.progress((lastValue = 0));
              jobs.update(job.id, {
                ...(copying || report.label ? {} : { progress: null }),
                message: message(copying ? null : 'Reading the disc’s layout (a few minutes)…'),
              });
              return;
            }
            const p = parseProgress(line);
            if (p === null || p === lastValue) return;
            lastValue = p;
            lastActivity = Date.now();
            if (warned) {
              warned = false;
              jobs.update(job.id, { message: message(null) });
            }
            if (copying) report.progress(p);
          },
        },
      );
    } finally {
      clearInterval(watchdog);
    }
    if (result.signal) {
      throw new UserError(
        `MakeMKV was stopped (${result.signal}) before it finished. Insert the disc again to start over.`,
      );
    }
    if (result.code !== 0 || !this.findFile(dir, '.mkv')) {
      const messages = parseMessages(result.output);
      const why = messages.slice(-2).join(' ');
      throw new UserError(
        `${report.what} failed. ${why} ${readErrorHint(messages.join(' '))}`.trim(),
      );
    }
  }

  /**
   * macOS opens DVD Player when a video DVD is inserted, and it holds the drive
   * while MakeMKV reads. Quit it (nothing happens if it isn't running).
   */
  private async closeDvdPlayer() {
    if (!this.config.closeDvdPlayer) return;
    try {
      const result = await this.deps.run('/usr/bin/pkill', ['-x', 'DVD Player']);
      if (result.code === 0) this.log.info('Closed DVD Player so it doesn’t hold the drive.');
    } catch (error) {
      this.log.warn('Could not close DVD Player:', describe(error));
    }
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
    if (job.kind === 'tv') return this.encodeEpisodes(job);
    const { jobs } = this.deps;
    const dir = this.jobDir(job.id);
    const mkv = this.findFile(dir, '.mkv');
    if (!mkv) throw new UserError('The ripped file is missing from the Rips folder.');
    jobs.update(job.id, { status: 'encoding', progress: 0, message: null });
    const progress = this.progressWriter(job.id);
    await this.compress(mkv, path.join(dir, 'compressed.mp4'), job.sourceSeconds ?? 0, progress);
    jobs.update(job.id, { status: 'filing', progress: null, message: null });
    await this.finish(job.id);
  }

  private async encodeEpisodes(job: JobRecord) {
    const { jobs } = this.deps;
    const episodes = job.episodes.map((ep) => ({ ...ep }));
    const todo = episodes.filter((ep) => ep.state === 'ripped');
    jobs.update(job.id, { status: 'encoding', progress: 0, message: null });
    const progress = this.progressWriter(job.id);
    for (const [i, ep] of todo.entries()) {
      const dir = this.episodeDir(job.id, ep);
      const mkv = this.findFile(dir, '.mkv');
      if (!mkv) {
        throw new UserError(`The rip of episode ${ep.episode} is missing from the Rips folder.`);
      }
      jobs.update(job.id, { message: `Episode ${ep.episode} (${i + 1} of ${todo.length})` });
      await this.compress(mkv, path.join(dir, 'compressed.mp4'), ep.durationSeconds, (p) =>
        progress((i + p) / todo.length),
      );
      ep.state = 'encoded';
      jobs.update(job.id, { episodes });
    }
    jobs.update(job.id, { status: 'filing', progress: null, message: null });
    await this.finish(job.id);
  }

  /** Compress one rip with HandBrake and check the result is complete. */
  private async compress(
    mkv: string,
    output: string,
    expectedSeconds: number,
    progress: (p: number) => void,
  ) {
    const { run } = this.deps;
    const c = this.config;
    fs.rmSync(output, { force: true });
    try {
      const result = await run(
        c.handbrakeCli,
        encodeArgs(mkv, output, c.preset, c.quality, c.subtitleLanguages),
        {
          onLine: (line) => {
            const p = parseEncodeProgress(line);
            if (p !== null) progress(p);
          },
        },
      );
      if (result.code !== 0 || !fs.existsSync(output)) {
        const tail = result.output.trim().split(/\r?\n/).slice(-1)[0] ?? '';
        throw new UserError(`HandBrake couldn’t compress the video. ${tail}`.trim());
      }

      // Check the result is complete before the original is deleted.
      const scan = await run(c.handbrakeCli, ['--scan', '-i', output]);
      const seconds = parseScanDuration(scan.output);
      const size = fs.statSync(output).size;
      const tolerance = Math.max(60, expectedSeconds * 0.02);
      if (
        !seconds ||
        size < 1_000_000 ||
        (expectedSeconds > 0 && Math.abs(seconds - expectedSeconds) > tolerance)
      ) {
        throw new UserError(
          `The compressed video looks incomplete (${Math.round((seconds ?? 0) / 60)} of ${Math.round(expectedSeconds / 60)} minutes). The original rip is kept, so you can retry.`,
        );
      }
    } catch (error) {
      // Never leave a partial file that a retry could mistake for a finished one.
      fs.rmSync(output, { force: true });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 3: name, file, import, announce

  private async finish(id: string) {
    let job = this.deps.jobs.get(id);
    if (!job) return;
    try {
      if (job.status === 'filing' && job.kind === 'tv') {
        job = this.fileEpisodes(job);
      } else if (job.status === 'filing') {
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
    moveFile(source, target);
    // The original rip is only removed once the movie is safely in place.
    fs.rmSync(this.jobDir(job.id), { recursive: true, force: true });
    return jobs.update(job.id, {
      status: 'importing',
      moviePath: target,
      message: 'Adding to Jellyfin…',
    });
  }

  /** Move each compressed episode into "TV/Show (Year)/Season NN/Show SNNENN.mp4". */
  private fileEpisodes(job: JobRecord): JobRecord {
    const { jobs } = this.deps;
    if (!job.title || job.season == null) {
      throw new UserError('This disc has no show and season. Dismiss it and insert it again.');
    }
    const names = (ep: RipEpisode) =>
      episodeFileNames({
        title: job.title!,
        year: job.year,
        tmdbId: job.tmdbId,
        season: job.season!,
        episode: ep.episode,
      });
    const showDir = path.join(this.config.tvDir, names(job.episodes[0]!).folder);
    const episodes = job.episodes.map((ep) => ({ ...ep }));
    const todo = episodes.filter((ep) => ep.state !== 'filed');
    // Check every episode first, so nothing is half-filed.
    for (const ep of todo) {
      const n = names(ep);
      if (fs.existsSync(path.join(showDir, n.seasonFolder, n.file))) {
        throw new UserError(
          `“${n.file}” is already in your TV folder. Move or rename it, then press Retry.`,
        );
      }
      if (!fs.existsSync(path.join(this.episodeDir(job.id, ep), 'compressed.mp4'))) {
        throw new UserError(
          `The compressed episode ${ep.episode} is missing from the Rips folder.`,
        );
      }
    }
    jobs.update(job.id, { message: 'Moving into your TV folder…' });
    for (const ep of todo) {
      const n = names(ep);
      const folder = path.join(showDir, n.seasonFolder);
      const target = path.join(folder, n.file);
      fs.mkdirSync(folder, { recursive: true });
      moveFile(path.join(this.episodeDir(job.id, ep), 'compressed.mp4'), target);
      ep.state = 'filed';
      ep.path = target;
      jobs.update(job.id, { episodes });
    }
    // The rips are only removed once every episode is safely in place.
    fs.rmSync(this.jobDir(job.id), { recursive: true, force: true });
    return jobs.update(job.id, {
      status: 'importing',
      moviePath: showDir,
      message: 'Adding to Jellyfin…',
    });
  }

  private async importIntoJellyfin(job: JobRecord) {
    const { jellyfin, jobs } = this.deps;
    const tv = job.kind === 'tv';
    const label = job.year ? `${job.title} (${job.year})` : job.title!;
    let movieId: string | null = null;
    if (jellyfin) {
      await jellyfin.refreshLibrary();
      const folder = tv
        ? path.basename(job.moviePath ?? '')
        : movieFileNames({ title: job.title!, year: job.year, tmdbId: job.tmdbId }).folder;
      const deadline = Date.now() + this.config.importTimeoutMs;
      while (!movieId && Date.now() < deadline && !this.stopped) {
        await sleep(this.config.importPollMs);
        try {
          movieId = tv
            ? await jellyfin.findShowByFolder(job.title!, folder)
            : await jellyfin.findMovieByFolder(job.title!, folder);
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
          : tv
            ? 'Filed. Jellyfin hasn’t listed the episodes yet; they will appear after its next scan.'
            : 'Filed. Jellyfin hasn’t listed it yet; it will appear after its next scan.',
      finishedAt: nowIso(),
    });
    const base = this.config.publicUrl;
    const page = movieId ? (tv ? `/show/${movieId}` : `/movie/${movieId}`) : '/';
    await this.deps.notifier.send({
      title: tv ? '📺 New on Wheelhouse' : '🎬 New on Wheelhouse',
      message: tv
        ? `${job.title} ${episodeRange(job)} ready to watch.`
        : `${label} is ready to watch.`,
      click: base ? `${base}${page}` : undefined,
      tags: [tv ? 'tv' : 'movie_camera'],
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
    if (job.kind === 'tv') return this.retryEpisodes(job);
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

  /** Pick a TV disc up where it stopped; finished episodes are never redone. */
  private retryEpisodes(job: JobRecord) {
    const { jobs } = this.deps;
    const at = (...states: RipEpisode['state'][]) =>
      job.episodes.length > 0 && job.episodes.every((ep) => states.includes(ep.state));
    if (at('encoded', 'filed')) {
      jobs.update(job.id, { status: 'filing', message: null });
      void this.finish(job.id);
    } else if (at('ripped', 'encoded', 'filed')) {
      jobs.update(job.id, {
        status: 'ripped',
        message: 'Waiting to be compressed',
        progress: null,
      });
      this.kickEncoder();
    } else {
      throw new UserError(
        'Not every episode was saved from this disc. Dismiss this and insert the disc again.',
      );
    }
    return jobs.get(job.id)!;
  }

  dismiss(id: string) {
    const job = this.requireJob(id);
    // Reading or ripping can be stopped (e.g. a scratched disc MakeMKV is stuck on).
    if ((job.status === 'scanning' || job.status === 'ripping') && this.discAbort?.jobId === id) {
      this.deps.jobs.update(id, { status: 'dismissed', progress: null });
      this.discAbort.controller.abort();
      setTimeout(() => void this.eject(job.mountPath).catch(() => undefined), 3000).unref?.();
      fs.rmSync(this.jobDir(id), { recursive: true, force: true });
      return;
    }
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

  async search(query: string, kind: RipKind = 'movie'): Promise<RipCandidate[]> {
    if (!this.deps.jellyfin)
      throw new UserError('Searching needs a Jellyfin API key (run npm run setup:ripper).');
    const q = query.trim().slice(0, 120);
    return kind === 'tv' ? this.deps.jellyfin.searchShows(q) : this.deps.jellyfin.searchMovies(q);
  }

  isUserError(error: unknown): error is Error {
    return error instanceof UserError;
  }

  // ---------------------------------------------------------------------------
  // Helpers

  private signalFor(jobId: string): AbortSignal | undefined {
    return this.discAbort?.jobId === jobId ? this.discAbort.controller.signal : undefined;
  }

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
      // A new phase starts again from 0.
      if (p < last) last = -1;
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

/** Rename, or copy and delete when the target is on another drive. */
function moveFile(source: string, target: string) {
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(source, target);
    fs.rmSync(source);
  }
}

/** "season 1, episodes 5–8 are" / "season 2, episode 3 is" */
function episodeRange(job: JobRecord): string {
  const numbers = job.episodes.map((ep) => ep.episode).sort((a, b) => a - b);
  const season = `season ${job.season}`;
  if (numbers.length === 1) return `${season}, episode ${numbers[0]} is`;
  const consecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1);
  const list = consecutive ? `${numbers[0]}–${numbers[numbers.length - 1]}` : numbers.join(', ');
  return `${season}, episodes ${list} are`;
}

function publicTitle(t: DiscTitle | RipDiscTitle): RipDiscTitle {
  return {
    index: t.index,
    durationSeconds: t.durationSeconds,
    sizeBytes: t.sizeBytes,
    chapters: t.chapters,
  };
}
