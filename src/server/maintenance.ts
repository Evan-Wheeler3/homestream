import fs from 'node:fs';
import path from 'node:path';
import type { BackupStatus, DriveStatus } from '../shared/types.js';
import type { Db } from './db.js';
import type { Notifier } from './ripper/services.js';

export interface MaintenanceOptions {
  db: Db;
  dataDir: string;
  backupDir: string;
  keepBackups: number;
  /** Folders whose drives are reported (and watched for low space). */
  drives: { label: string; path: string }[];
  lowSpaceGb: number;
  notifier?: Notifier | null;
  publicUrl?: string | null;
  logger?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
}

const DAY = 24 * 3600_000;
const BACKUP_PREFIX = 'wheelhouse-';

/**
 * Housekeeping that runs inside the server: a database backup every day
 * (keeping the most recent ones), and a warning when a drive is nearly full.
 */
export class Maintenance {
  private timer: NodeJS.Timeout | null = null;
  private lastSpaceWarning = new Map<string, number>();
  private readonly log: Pick<Console, 'info' | 'warn'>;
  private readonly now: () => number;

  constructor(private readonly opts: MaintenanceOptions) {
    this.log = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 3600_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Hourly: back up if the last backup is a day old; warn about full drives. */
  async tick() {
    try {
      const last = this.backups().last;
      if (!last || this.now() - Date.parse(last) > DAY - 3600_000) this.backupNow();
    } catch (error) {
      this.log.warn('Automatic backup failed:', error instanceof Error ? error.message : error);
    }
    await this.checkSpace();
  }

  /** A consistent copy of the database (and uploaded artwork), safe while running. */
  backupNow(): string {
    const stamp = new Date(this.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const target = path.join(this.opts.backupDir, `${BACKUP_PREFIX}${stamp}`);
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, 'wheelhouse.db');
    fs.rmSync(file, { force: true });
    this.opts.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const artwork = path.join(this.opts.dataDir, 'artwork');
    if (fs.existsSync(artwork))
      fs.cpSync(artwork, path.join(target, 'artwork'), { recursive: true });
    this.prune();
    this.log.info(`Backup written to ${target}`);
    return target;
  }

  private list(): string[] {
    try {
      return fs
        .readdirSync(this.opts.backupDir)
        .filter((n) => n.startsWith(BACKUP_PREFIX))
        .filter((n) => fs.existsSync(path.join(this.opts.backupDir, n, 'wheelhouse.db')))
        .sort();
    } catch {
      return [];
    }
  }

  private prune() {
    const all = this.list();
    for (const name of all.slice(0, Math.max(0, all.length - this.opts.keepBackups))) {
      fs.rmSync(path.join(this.opts.backupDir, name), { recursive: true, force: true });
    }
  }

  backups(): BackupStatus {
    const all = this.list();
    const newest = all.at(-1);
    // Folder names carry the UTC time they were made: wheelhouse-YYYY-MM-DD-HH-MM.
    const m = newest && /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(newest);
    const last = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z` : null;
    return { enabled: true, dir: this.opts.backupDir, count: all.length, last };
  }

  drives(): DriveStatus[] {
    const seen = new Set<string>();
    const result: DriveStatus[] = [];
    for (const d of this.opts.drives) {
      try {
        const stats = fs.statfsSync(d.path);
        const total = stats.blocks * stats.bsize;
        const free = stats.bavail * stats.bsize;
        // Folders on the same drive are reported once.
        const key = `${stats.blocks}:${stats.bsize}:${stats.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          label: d.label,
          path: d.path,
          available: true,
          freeBytes: free,
          totalBytes: total,
          low: free < this.opts.lowSpaceGb * 1024 ** 3,
        });
      } catch {
        result.push({
          label: d.label,
          path: d.path,
          available: false,
          freeBytes: null,
          totalBytes: null,
          low: false,
        });
      }
    }
    return result;
  }

  private async checkSpace() {
    if (!this.opts.notifier) return;
    for (const drive of this.drives()) {
      if (!drive.low || drive.freeBytes == null) continue;
      const last = this.lastSpaceWarning.get(drive.path) ?? 0;
      if (this.now() - last < DAY) continue;
      this.lastSpaceWarning.set(drive.path, this.now());
      const gb = (drive.freeBytes / 1024 ** 3).toFixed(0);
      await this.opts.notifier.send({
        title: `${drive.label} drive is almost full`,
        message: `Only ${gb} GB left. New movies may not fit; free up space or add a drive.`,
        click: this.opts.publicUrl ? `${this.opts.publicUrl}/settings#server` : undefined,
        priority: 'high',
        tags: ['warning'],
      });
    }
  }
}
