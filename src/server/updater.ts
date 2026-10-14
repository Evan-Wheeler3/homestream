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
    try {
      const branch = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const [sha = '', date = '', ...subject] = (
        await this.git(['log', '-1', '--format=%h%n%cI%n%s'])
      ).split('\n');
      await this.git(['fetch', '--quiet', 'origin', branch]);
      const behind = Number(await this.git(['rev-list', '--count', `HEAD..origin/${branch}`])) || 0;
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
    void this.perform();
    return this.state;
  }

  private async perform() {
    const steps: [string, string, string[]][] = [
      ['Downloading', 'git', ['pull', '--ff-only']],
      ['Installing', 'npm', ['install', '--no-audit', '--no-fund']],
      ['Building', 'npm', ['run', 'build']],
    ];
    try {
      for (const [label, cmd, args] of steps) {
        this.state = { ...this.state, step: label };
        const result = await this.run(cmd, args, { cwd: this.opts.root, env: this.env });
        if (result.code !== 0) {
          const tail = result.output.trim().split('\n').slice(-3).join(' ');
          throw new Error(`${label} failed: ${tail}`);
        }
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
      this.state = {
        running: false,
        step: null,
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
        restarting: false,
      };
      this.opts.logger?.warn('Update failed:', this.state.error);
    }
  }
}
