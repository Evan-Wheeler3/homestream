import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, type Runner } from '../../src/server/ripper/process';
import { isSupervised, Updater } from '../../src/server/updater';

// Real git repositories (an "origin" and an installed clone); npm is faked.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

describe('in-app updates', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  function repos() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-upd-'));
    dirs.push(root);
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(origin, 'README'), 'v1');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'First version');
    const install = path.join(root, 'install');
    git(root, 'clone', '-q', origin, install);
    const publish = (file: string, message: string) => {
      fs.writeFileSync(path.join(origin, file), message);
      git(origin, 'add', '.');
      git(origin, 'commit', '-q', '-m', message);
    };
    return { install, publish };
  }

  const npmCalls: string[][] = [];
  const runner =
    (npmCode = 0): Runner =>
    async (cmd, args, opts) => {
      if (cmd === 'npm') {
        npmCalls.push(args);
        return { code: npmCode, output: npmCode ? 'npm ERR! build broke' : 'ok' };
      }
      return runProcess(cmd, args, opts);
    };

  async function waitIdle(u: Updater) {
    for (let i = 0; i < 200; i++) {
      const s = await u.status();
      if (!s.state.running) return s;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('update never finished');
  }

  it('finds new changes, installs them, and restarts', async () => {
    const { install, publish } = repos();
    let restarted = false;
    const u = new Updater({ root: install, run: runner(), restart: () => (restarted = true) });

    expect((await u.status(true)).behind).toBe(0);
    publish('feature.txt', 'Add the wheel');
    publish('fix.txt', 'Fix TV focus');
    const before = await u.status(true);
    expect(before.supported).toBe(true);
    expect(before.branch).toBe('main');
    expect(before.current?.subject).toBe('First version');
    expect(before.behind).toBe(2);
    expect(before.changes).toEqual(['Fix TV focus', 'Add the wheel']);

    npmCalls.length = 0;
    u.start();
    const after = await waitIdle(u);
    expect(after.state.error).toBeNull();
    expect(after.state.restarting).toBe(true);
    expect(fs.readFileSync(path.join(install, 'fix.txt'), 'utf8')).toBe('Fix TV focus');
    expect(npmCalls.map((a) => a[0])).toEqual(['install', 'run']);
    await new Promise((r) => setTimeout(r, 1700));
    expect(restarted).toBe(true);
    expect((await u.status(true)).behind).toBe(0);
  });

  it('reports a failed build and asks for a manual restart when unsupervised', async () => {
    const { install, publish } = repos();
    publish('x.txt', 'Something');
    const failing = new Updater({ root: install, run: runner(1) });
    failing.start();
    expect((await waitIdle(failing)).state.error).toMatch(
      /Installing failed: npm ERR! build broke/,
    );

    const ok = new Updater({ root: install, run: runner() });
    ok.start();
    const done = await waitIdle(ok);
    expect(done.state).toMatchObject({ restarting: false, step: 'Restart Wheelhouse to finish' });
  });

  it('explains that downloaded (non-git) installs cannot update themselves', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-zip-'));
    dirs.push(plain);
    const u = new Updater({ root: plain, run: runner() });
    const s = await u.status();
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/installed from a download/);
    expect(() => u.start()).toThrow(/git/);
  });

  it('knows when a service manager will restart it', () => {
    expect(isSupervised({ XPC_SERVICE_NAME: 'com.wheelhouse.app' })).toBe(true);
    expect(isSupervised({ INVOCATION_ID: 'abc' })).toBe(true);
    expect(isSupervised({ XPC_SERVICE_NAME: '0' })).toBe(false);
  });
});
