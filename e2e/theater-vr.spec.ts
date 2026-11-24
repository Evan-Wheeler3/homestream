// VR mode with hand tracking only (no controllers), on an emulated Oculus Quest 1
// (Meta's WebXR emulator, iwer): pinch at the floor to teleport, pinch at the
// floating menu to get a ticket, sit down, and play, pause and skip the movie.
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { useLoginForm } from './helpers';

type Button = { id: string; label: string };
/** The engine's insides, as tests poke at them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Menu = { title: string; lines: string[]; buttons: Button[] };

async function signIn(page: Page) {
  await page.goto('/login');
  await useLoginForm(page);
  await page.getByLabel('Username').fill(`vr-${Date.now().toString(36)}`);
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}

/** A headset with hand tracking, standing in the middle of the room. */
async function headset(page: Page) {
  await page.addInitScript({ path: path.resolve('node_modules/iwer/build/iwer.min.js') });
  await page.addInitScript(() => {
    const w = window as unknown as {
      IWER: {
        XRDevice: new (config: unknown) => {
          installRuntime(o: object): void;
          primaryInputMode: string;
          position: { set(x: number, y: number, z: number): void };
        };
        oculusQuest1: unknown;
      };
      __xrDevice: unknown;
    };
    const device = new w.IWER.XRDevice(w.IWER.oculusQuest1);
    device.installRuntime({ forceInstall: true });
    device.primaryInputMode = 'hand';
    device.position.set(0, 1.6, 0);
    w.__xrDevice = device;
  });
}

/** Test helpers in the page: aim the right hand at a point in the building, read the menu. */
async function installHelpers(page: Page) {
  await page.evaluate(() => {
    type V = { set(...a: number[]): void; x: number; y: number; z: number };
    const w = window as unknown as Record<string, unknown> & {
      __xrDevice: {
        position: V;
        hands: Record<string, { position: V; quaternion: V; updatePinchValue(v: number): void }>;
      };
      __theater: { engine: Loose };
    };
    const engine = () => w.__theater.engine;
    w.__aim = (x: number, y: number, z: number) => {
      const rig = engine().rig;
      const ry = rig.rotation.y;
      const dx = x - rig.position.x;
      const dz = z - rig.position.z;
      // The building's coordinates → the headset's room.
      const local = [
        Math.cos(ry) * dx - Math.sin(ry) * dz,
        y - rig.position.y,
        Math.sin(ry) * dx + Math.cos(ry) * dz,
      ];
      const head = w.__xrDevice.position;
      const hand = w.__xrDevice.hands.right!;
      const from = [head.x + 0.2, head.y - 0.35, head.z - 0.25];
      hand.position.set(from[0]!, from[1]!, from[2]!);
      const d = local.map((v, i) => v - from[i]!);
      const n = Math.hypot(...d);
      const [dx2, dy2, dz2] = d.map((v) => v / n) as [number, number, number];
      // The rotation that turns "forward" (0, 0, -1) to point that way.
      const q = [dy2, -dx2, 0, 1 - dz2];
      const qn = Math.hypot(...q) || 1;
      hand.quaternion.set(q[0]! / qn, q[1]! / qn, q[2]! / qn, q[3]! / qn);
    };
    w.__button = (id: string) => {
      const vr = engine().vr;
      const r = vr.layout.buttons.find((b: { id: string }) => b.id === id);
      if (!r) return null;
      const u = (r.x + r.w / 2) / vr.layout.width - 0.5;
      const v = 0.5 - (r.y + r.h / 2) / vr.layout.height;
      vr.panel.updateMatrixWorld();
      const e = vr.panel.matrixWorld.elements;
      return [
        e[0] * u + e[4] * v + e[12],
        e[1] * u + e[5] * v + e[13],
        e[2] * u + e[6] * v + e[14],
      ];
    };
    w.__pinch = (value: number) => w.__xrDevice.hands.right!.updatePinchValue(value);
  });
}

const engineState = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as { __theater: { engine: Loose } }).__theater.engine;
    return {
      body: { x: e.body.x as number, z: e.body.z as number },
      yaw: e.yaw as number,
      seated: e.isSeated as boolean,
      menuShown: e.vr.panel.visible as boolean,
      hover: e.vr.hover as string | null,
      menu: e.vrPanel as Menu,
    };
  });

async function pinch(page: Page) {
  await page.evaluate(() => (window as unknown as { __pinch(v: number): void }).__pinch(1));
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as unknown as { __pinch(v: number): void }).__pinch(0));
  await page.waitForTimeout(400);
}

async function aim(page: Page, at: number[]) {
  await page.evaluate(
    ([x, y, z]) => (window as unknown as { __aim(...a: number[]): void }).__aim(x!, y!, z!),
    at,
  );
}

/** Points at a menu button (it lights up) and pinches. */
async function press(page: Page, id: string) {
  const at = await page.evaluate(
    (id) => (window as unknown as { __button(id: string): number[] | null }).__button(id),
    id,
  );
  expect(at, `the menu has a "${id}" button`).not.toBeNull();
  await aim(page, at!);
  await expect.poll(async () => (await engineState(page)).hover).toBe(id);
  await pinch(page);
}

const labels = async (page: Page) => (await engineState(page)).menu.buttons.map((b) => b.label);

test('VR with hand tracking: teleport, get a ticket, sit down and watch', async ({ page }) => {
  test.setTimeout(120_000);
  await headset(page);
  await signIn(page);
  await page.goto('/theater');
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Enter VR' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __theater: { engine: { inVr: boolean } } }).__theater.engine.inVr,
      ),
    )
    .toBe(true);
  await installHelpers(page);
  await expect.poll(async () => (await engineState(page)).menuShown).toBe(true);
  expect(await labels(page)).toEqual([
    'Get a ticket',
    'Lobby',
    'Turn left',
    'Turn right',
    'Hide menu',
    'Exit VR',
  ]);

  // Point at the floor a few metres ahead (off to the side of the menu) and pinch: you're there.
  const start = await engineState(page);
  const target = [start.body.x + 1.2, 0, start.body.z - 3.5];
  await aim(page, target);
  await page.waitForTimeout(300);
  await pinch(page);
  const there = await engineState(page);
  expect(Math.hypot(there.body.x - target[0]!, there.body.z - target[2]!)).toBeLessThan(0.3);

  // Hide the menu; pinching at the ceiling brings it back.
  await press(page, 'hide');
  expect((await engineState(page)).menuShown).toBe(false);
  await aim(page, [there.body.x, 6, there.body.z - 2]);
  await pinch(page);
  expect((await engineState(page)).menuShown).toBe(true);

  // Turning is in 45° steps.
  const yaw = (await engineState(page)).yaw;
  await press(page, 'right');
  await expect.poll(async () => (await engineState(page)).yaw).toBeCloseTo(yaw - Math.PI / 4, 1);

  // The box office on the menu: the newest movies first.
  await press(page, 'movies');
  const boxOffice = (await engineState(page)).menu;
  expect(boxOffice.title).toBe('Box office: pick a movie');
  const movie = boxOffice.buttons.find((b) => b.id.startsWith('movie:'))!;
  await press(page, movie.id);
  await expect
    .poll(() => labels(page))
    .toContainEqual(expect.stringMatching(/^Sit down in Theater \d+$/));

  // Sit down: straight to a good seat, and the movie starts after the countdown.
  await press(page, 'sit');
  await expect.poll(async () => (await engineState(page)).seated).toBe(true);
  const title = movie.label.replace(/ \(\d{4}\)$/, '');
  expect((await engineState(page)).menu.title).toBe(title);
  await expect
    .poll(async () => (await engineState(page)).menu.lines[0], { timeout: 20_000 })
    .toMatch(/^Playing · 0:0[1-9]/);
  const video = page.locator('.theater__video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(1);

  // Pause and skip ahead from the menu.
  await press(page, 'toggle');
  await expect.poll(async () => (await engineState(page)).menu.lines[0]).toMatch(/^Paused/);
  expect(await labels(page)).toContain('Play');
  const before = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await press(page, 'ahead');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(before + 20);

  // Stand up, then leave VR: back to the flat theater.
  await press(page, 'stand');
  await expect.poll(async () => (await engineState(page)).seated).toBe(false);
  await press(page, 'exit');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __theater: { engine: { inVr: boolean } } }).__theater.engine.inVr,
      ),
    )
    .toBe(false);
  await expect(page.getByRole('button', { name: 'Enter VR' })).toBeVisible();
});
