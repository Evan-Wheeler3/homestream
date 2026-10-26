import fs from 'node:fs';
import path from 'node:path';
import type { UpdateStatus } from '../shared/types.js';
import { runProcess, type Runner } from './ripper/process.js';

export interface UpdaterOptions {
  /** The Wheelhouse folder (contains package.json and .git). */
  root: string;
  run?: Runner;
  /** Called after a successful update to restart the server. */
  restart?: () => void;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'info' | 'warn'>;
}

const CHECK_TTL_MS = 10 * 60_000;

/** True when a service manager (launchd, systemd) will start the server again after it exits. */
export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.XPC_SERVICE_NAME?.includes('wheelhouse') || env.INVOCATION_ID);
}

/**
 * In-app updates for a git install: check GitHub for new commits on the
 * current branch, then pull, install, build and restart.
 */
export class Updater {
  private readonly run: Runner;
  private readonly env: NodeJS.ProcessEnv;
  private checked: (Omit<UpdateStatus, 'state'> & { at: number }) | null = null;
  private pending: Promise<void> = Promise.resolve();
  /** The newest version on GitHub at the last check (a commit id). */
  latest: string | null = null;
  private state: UpdateStatus['state'] = {
    running: false,
    step: null,
    error: null,
    finishedAt: null,
    restarting: false,
  };

  constructor(private readonly opts: UpdaterOptions) {
    this.run = opts.run ?? runProcess;
    // Services start with a minimal PATH; make sure npm, node and git are found.
    const nodeDir = path.dirname(process.execPath);
    const env = opts.env ?? process.env;
    this.env = {
      ...env,
      PATH: [nodeDir, env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
        .filter(Boolean)
        .join(path.delimiter),
    };
  }

  private get isGit() {
    return fs.existsSync(path.join(this.opts.root, '.git'));
  }

  private async git(args: string[]) {
    const result = await this.run('git', args, { cwd: this.opts.root, env: this.env });
    if (result.code !== 0)
      throw new Error(result.output.trim().split('\n').slice(-1)[0] || `git ${args[0]} failed`);
    return result.output.trim();
  }

  async status(force = false): Promise<UpdateStatus> {
    if (!this.isGit) {
      return {
        supported: false,
        reason:
          'This copy of Wheelhouse was installed from a download, not with git. Reinstall it with git (see README → Backups and updates) to update from here.',
        branch: null,
        current: null,
        behind: 0,
        changes: [],
        checkedAt: null,
        state: this.state,
      };
    }
    if (!force && this.checked && Date.now() - this.checked.at < CHECK_TTL_MS) {
      return { ...this.checked, state: this.state };
    }
    // Never run git alongside an update in progress (they would fight over the repository).
    if (this.state.running) {
      return {
        supported: true,
        reason: null,
        branch: this.checked?.branch ?? null,
        current: this.checked?.current ?? null,
        behind: this.checked?.behind ?? 0,
        changes: this.checked?.changes ?? [],
        checkedAt: this.checked?.checkedAt ?? null,
        state: this.state,
      };
    }
    try {
      const branch = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const [sha = '', date = '', ...subject] = (
        await this.git(['log', '-1', '--format=%h%n%cI%n%s'])
      ).split('\n');
      await this.git(['fetch', '--quiet', 'origin', branch]);
      const behind = Number(await this.git(['rev-list', '--count', `HEAD..origin/${branch}`])) || 0;
      this.latest = await this.git(['rev-parse', `origin/${branch}`]);
      const changes = behind
        ? (await this.git(['log', '--format=%s', '-n', '15', `HEAD..origin/${branch}`]))
            .split('\n')
            .filter(Boolean)
        : [];
      this.checked = {
        supported: true,
        reason: null,
        branch,
        current: { sha, date, subject: subject.join('\n') },
        behind,
        changes,
        checkedAt: new Date().toISOString(),
        at: Date.now(),
      };
      return { ...this.checked, state: this.state };
    } catch (error) {
      return {
        supported: true,
        reason: `Couldn’t check for updates: ${error instanceof Error ? error.message : String(error)}`,
        branch: null,
        current: null,
        behind: 0,
        changes: [],
        checkedAt: new Date().toISOString(),
        state: this.state,
      };
    }
  }

  /** Start updating in the background; progress is reported through status(). */
  start(): UpdateStatus['state'] {
    if (!this.isGit) throw new Error('Updates need a git install.');
    if (this.state.running) return this.state;
    this.state = {
      running: true,
      step: 'Downloading',
      error: null,
      finishedAt: null,
      restarting: false,
    };
    this.pending = this.perform();
    return this.state;
  }

  private async restore(sha: string): Promise<boolean> {
    try {
      this.state = { ...this.state, step: 'Putting the previous version back' };
      await this.git(['reset', '--keep', sha]);
      for (const args of [
        ['install', '--no-audit', '--no-fund'],
        ['run', 'build'],
      ]) {
        const result = await this.run('npm', args, { cwd: this.opts.root, env: this.env });
        if (result.code !== 0) return false;
      }
      return true;
    } catch (error) {
      this.opts.logger?.warn('Could not put the previous version back:', error);
      return false;
    }
  }

  /** Resolves once the update that's running (if any) has finished or failed. */
  finished(): Promise<void> {
    return this.pending;
  }

  private async perform() {
    const steps: [string, string, string[]][] = [
      ['Downloading', 'git', ['pull', '--ff-only']],
      ['Installing', 'npm', ['install', '--no-audit', '--no-fund']],
      ['Building', 'npm', ['run', 'build']],
    ];
    let previous: string | null = null;
    let downloaded = false;
    try {
      previous = await this.git(['rev-parse', 'HEAD']);
      for (const [label, cmd, args] of steps) {
        this.state = { ...this.state, step: label };
        const result = await this.run(cmd, args, { cwd: this.opts.root, env: this.env });
        if (result.code !== 0) {
          const tail = result.output.trim().split('\n').slice(-3).join(' ');
          throw new Error(`${label} failed: ${tail}`);
        }
        if (label === 'Downloading') downloaded = true;
      }
      this.checked = null;
      const restart = Boolean(this.opts.restart);
      this.state = {
        running: false,
        step: restart ? 'Restarting' : 'Restart Wheelhouse to finish',
        error: null,
        finishedAt: new Date().toISOString(),
        restarting: restart,
      };
      this.opts.logger?.info('Update installed.');
      if (restart) setTimeout(() => this.opts.restart?.(), 1500);
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      // Don't leave a half-installed version to be started next time: put the old one back.
      if (downloaded && previous && (await this.restore(previous))) {
        message += ' The previous version was put back.';
      }
      this.checked = null;
      this.state = {
        running: false,
        step: null,
        error: message,
        finishedAt: new Date().toISOString(),
        restarting: false,
      };
      this.opts.logger?.warn('Update failed:', this.state.error);
    }
  }
}

export interface AutoUpdaterOptions {
  updater: Updater;
  /** Safe to restart now: nothing ripping, compressing or uploading, and nobody watching. */
  idle: () => boolean;
  /** Stop starting new work (true) while an update installs, or carry on (false). */
  hold?: (on: boolean) => void;
  everyMs: number;
  notify?: (title: string, message: string) => Promise<unknown>;
  logger?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Installs new versions by itself, but only when Wheelhouse is idle, so a rip,
 * a compression, an upload or someone's movie is never cut off by a restart.
 */
export class AutoUpdater {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** A version that failed to install: not tried again until there's a newer one. */
  private failed: string | null = null;

  constructor(private readonly opts: AutoUpdaterOptions) {}

  start() {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.opts.everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check: install the new version if there is one and now is a good time. */
  async tick(): Promise<'none' | 'waiting' | 'installed' | 'failed' | 'skipped'> {
    if (this.busy) return 'skipped';
    this.busy = true;
    const { updater, idle, hold, notify, logger } = this.opts;
    try {
      const status = await updater.status(true);
      if (!status.supported || status.reason || status.behind === 0 || status.state.running) {
        return 'none';
      }
      const target = updater.latest;
      if (target && target === this.failed) return 'skipped';
      if (!idle()) return 'waiting';
      hold?.(true);
      // Something may have started between the check and the hold.
      if (!idle()) {
        hold?.(false);
        return 'waiting';
      }
      logger?.info(`Installing an update automatically: ${status.changes[0] ?? ''}`);
      updater.start();
      await updater.finished();
      const after = (await updater.status()).state;
      if (after.error) {
        hold?.(false);
        this.failed = target;
        await notify?.(
          'Wheelhouse couldn’t update itself',
          `${after.error} Open Settings → Updates on the Mac to try again.`,
        ).catch(() => undefined);
        return 'failed';
      }
      await notify?.(
        'Wheelhouse updated',
        status.changes.slice(0, 3).join(' · ') || 'A new version is installed.',
      ).catch(() => undefined);
      return 'installed';
    } catch (error) {
      hold?.(false);
      logger?.warn(
        'Automatic update check failed:',
        error instanceof Error ? error.message : error,
      );
      return 'failed';
    } finally {
      this.busy = false;
    }
  }
}
