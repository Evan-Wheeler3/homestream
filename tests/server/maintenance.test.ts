import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db';
import { Maintenance } from '../../src/server/maintenance';
import type { Notification } from '../../src/server/ripper/services';

const quiet = { info: () => undefined, warn: () => undefined };

describe('maintenance', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-maint-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  function setup(opts: { lowSpaceGb?: number; keep?: number } = {}) {
    const dataDir = tmp();
    const db = openDatabase(dataDir);
    db.prepare(
      "INSERT INTO preferences (user_id, data, updated_at) VALUES ('u1', '{\"theme\":\"sepia\"}', 'now')",
    ).run();
    fs.mkdirSync(path.join(dataDir, 'artwork'));
    fs.writeFileSync(path.join(dataDir, 'artwork', 'a.jpg'), 'img');
    let clock = Date.parse('2026-10-14T08:00:00Z');
    const sent: Notification[] = [];
    const m = new Maintenance({
      db,
      dataDir,
      backupDir: path.join(dataDir, 'backups'),
      keepBackups: opts.keep ?? 3,
      drives: [{ label: 'Movies', path: dataDir }],
      lowSpaceGb: opts.lowSpaceGb ?? 1,
      notifier: { send: async (n) => void sent.push(n) },
      logger: quiet,
      now: () => clock,
    });
    return { m, db, dataDir, sent, advance: (ms: number) => (clock += ms) };
  }

  it('makes a restorable backup with artwork, once a day', async () => {
    const { m, dataDir, advance } = setup();
    await m.tick();
    expect(m.backups().count).toBe(1);
    const dir = fs.readdirSync(path.join(dataDir, 'backups'))[0]!;
    const copy = new DatabaseSync(path.join(dataDir, 'backups', dir, 'wheelhouse.db'));
    expect(copy.prepare('SELECT data FROM preferences').get()).toEqual({
      data: '{"theme":"sepia"}',
    });
    copy.close();
    expect(fs.existsSync(path.join(dataDir, 'backups', dir, 'artwork', 'a.jpg'))).toBe(true);

    advance(3600_000); // an hour later: nothing new
    await m.tick();
    expect(m.backups().count).toBe(1);
    advance(24 * 3600_000); // a day later: another one
    await m.tick();
    expect(m.backups().count).toBe(2);
  });

  it('keeps only the most recent backups', () => {
    const { m, advance } = setup({ keep: 3 });
    for (let i = 0; i < 5; i++) {
      m.backupNow();
      advance(24 * 3600_000);
    }
    expect(m.backups().count).toBe(3);
  });

  it('reports drives and warns once a day when one is nearly full', async () => {
    const { m, sent, advance } = setup({ lowSpaceGb: 10_000_000 }); // any real disk is "low"
    const [drive] = m.drives();
    expect(drive).toMatchObject({ label: 'Movies', available: true, low: true });
    expect(drive!.freeBytes).toBeGreaterThan(0);
    await m.tick();
    await m.tick();
    expect(sent.filter((n) => /almost full/.test(n.title))).toHaveLength(1);
    advance(25 * 3600_000);
    await m.tick();
    expect(sent.filter((n) => /almost full/.test(n.title))).toHaveLength(2);
  });

  it('reports a disconnected drive instead of failing', () => {
    const { db, dataDir } = setup();
    const m = new Maintenance({
      db,
      dataDir,
      backupDir: path.join(dataDir, 'b'),
      keepBackups: 2,
      drives: [{ label: 'LaCie', path: '/Volumes/NotPluggedIn/Movies' }],
      lowSpaceGb: 30,
      logger: quiet,
    });
    expect(m.drives()).toEqual([
      expect.objectContaining({ label: 'LaCie', available: false, low: false }),
    ]);
  });
});
