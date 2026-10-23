import { useLoginForm } from './helpers';
import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  const user = `theater-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/login');
  await useLoginForm(page);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('main')).toBeVisible();
}

async function enter(page: Page) {
  await page.goto('/theater');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Wheelhouse Cinemas' });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  return welcome;
}

type Engine = {
  body: { x: number; y: number; z: number };
  yaw: number;
  simulate(i: { forward?: number; strafe?: number; sprint?: boolean }, s: number): void;
};

/** Faces a spot and walks there (through the same walls and doors as the keys). */
async function walkTo(page: Page, x: number, z: number, label: string) {
  const result = await page.evaluate(
    ([tx, tz]) => {
      const e = (window as unknown as { __theater: { engine: Engine } }).__theater.engine;
      let stuck = 0;
      for (let i = 0; i < 600; i++) {
        const dist = Math.hypot(tx! - e.body.x, tz! - e.body.z);
        if (dist < 0.2) return 'ok';
        e.yaw = Math.atan2(-(tx! - e.body.x), -(tz! - e.body.z));
        const before = { x: e.body.x, z: e.body.z };
        e.simulate({ forward: 1 }, Math.min(0.1, dist / 5.5));
        stuck = Math.hypot(e.body.x - before.x, e.body.z - before.z) < 0.005 ? stuck + 1 : 0;
        if (stuck >= 3) return `stuck at ${e.body.x.toFixed(2)}, ${e.body.z.toFixed(2)}`;
      }
      return `never got there: at ${e.body.x.toFixed(2)}, ${e.body.z.toFixed(2)}`;
    },
    [x, z],
  );
  expect(result, `walking to ${label}`).toBe('ok');
  // Let the page catch up with where you are.
  await page.waitForTimeout(400);
}

async function face(page: Page, yaw: number) {
  await page.evaluate((y) => {
    (window as unknown as { __theater: { engine: Engine } }).__theater.engine.yaw = y;
  }, yaw);
}

test('theater: snacks in your hands, a ticket for today’s movie, and the show starts after 3, 2, 1', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await signIn(page);
  await page.getByRole('link', { name: /Go to the movies/ }).click();
  await expect(page).toHaveURL('/theater');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Wheelhouse Cinemas' });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('canvas.theater__canvas')).toBeVisible();
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  await expect(page.getByRole('button', { name: /Just you/ })).toBeVisible();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: info.outputPath('theater-lobby.png') });

  // Snacks first: popcorn and a soda, from the money you arrive with.
  await page.getByRole('button', { name: 'Go to…' }).click();
  await page.getByRole('button', { name: 'Concessions' }).click();
  await page.getByRole('button', { name: /Buy snacks/ }).click();
  const stand = page.getByRole('dialog', { name: 'Concessions' });
  await expect(stand).toContainText('$30');
  await stand.getByRole('button', { name: /Popcorn/ }).click();
  await stand.getByRole('button', { name: /Soda/ }).click();
  await expect(stand).toBeHidden();
  await expect(page.locator('.theater__wallet')).toHaveText('💵 $18');
  const hands = page.getByRole('group', { name: 'Your snacks' });
  await hands.getByRole('button', { name: 'Eat (Popcorn)' }).click();
  await page.keyboard.press('2');
  await page.waitForTimeout(800);
  await page.screenshot({ path: info.outputPath('theater-snacks.png') });

  // The box office: today's lineup, one movie per theater.
  await page.getByRole('button', { name: 'Go to…' }).click();
  await page.getByRole('button', { name: 'Box office' }).click();
  await page.getByRole('button', { name: /Buy a ticket/ }).click();
  const box = page.getByRole('dialog', { name: 'Box office' });
  await expect(box.getByRole('heading', { name: 'Today’s lineup' })).toBeVisible();
  await box.locator('.lineup__card').nth(2).click();
  await expect(box).toContainText('Showing today in Theater 3');
  await box.getByRole('radio', { name: 'Private screening' }).click();
  const title = (await box.locator('.boxoffice__title').innerText()).replace(/\s*\(\d{4}\)$/, '');
  await box.getByRole('button', { name: 'Get a ticket' }).click();
  await expect(box).toBeHidden();
  const ticket = page.getByRole('complementary', { name: 'Your ticket' });
  await expect(ticket).toContainText('Theater 3');
  await expect(ticket).toContainText(title);

  await ticket.getByRole('button', { name: 'Find me a seat' }).click();
  await expect(page.locator('.theater__place')).toHaveText('Theater 3');
  const sit = page.getByRole('button', { name: /Sit in seat C5/ });
  await expect(sit).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath('theater-auditorium.png') });
  await sit.click();

  // Curtains open, 3, 2, 1, then the movie plays on the big screen.
  await expect(page.locator('.theater__count')).toHaveText(/^[123]$/);
  await page.waitForTimeout(900);
  await page.screenshot({ path: info.outputPath('theater-countdown.png') });
  await expect(page.locator('.theater__count')).not.toBeAttached({ timeout: 8000 });
  const controls = page.getByRole('group', { name: 'Movie controls' });
  await expect(controls.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelector<HTMLVideoElement>('.theater__video')?.currentTime ?? 0,
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0.5);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath('theater-playing.png') });
  // A sip from the cupholder.
  await hands.getByRole('button', { name: 'Drink (Soda)' }).click();

  await controls.getByRole('button', { name: 'Pause' }).click();
  await expect(controls.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await controls.getByRole('button', { name: 'Stand up' }).click();
  await expect(controls).toBeHidden();
  await expect(page.getByRole('button', { name: /Sit in seat/ })).toBeVisible();

  // Toss the soda, react, and return the ticket.
  await hands.getByRole('button', { name: 'Throw away the soda' }).click();
  await expect(hands.getByRole('button', { name: /Soda/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'React 😂' }).click();
  await expect(page.locator('.theater__float')).toHaveText('😂');
  await ticket.getByRole('button', { name: 'Return ticket' }).click();
  await expect(ticket).toBeHidden();
});

test('theater: the arcade machines are playable', async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page);
  const welcome = await enter(page);
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  await page.getByRole('button', { name: 'Go to…' }).click();
  await page.getByRole('button', { name: 'Arcade' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: info.outputPath('theater-arcade-corner.png') });
  // Over to Snack Snake, the machine by the wall.
  await walkTo(page, 12.4, 0.5, 'Snack Snake');
  await face(page, -Math.PI / 2);
  await page.getByRole('button', { name: /Play Snack Snake/ }).click();
  const game = page.getByRole('dialog', { name: 'Snack Snake' });
  await game.getByRole('button', { name: 'Insert coin' }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: info.outputPath('theater-arcade.png') });
  // It's running: left alone, the snake runs into the wall and the game ends.
  await expect(game.getByText(/GAME OVER/)).toBeVisible({ timeout: 60_000 });
  await expect(game.getByRole('button', { name: 'Play again' })).toBeVisible();
});

test('theater: "In the theater" on a movie page opens the box office with that movie', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/browse');
  await page.locator('a.poster-card').first().click();
  await expect(page).toHaveURL(/\/movie\//);
  const theaterLink = page.getByRole('link', { name: 'In the theater' });
  await expect(theaterLink).toBeVisible();
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  const { title } = (await (
    await page.request.get(`/api/movies/${encodeURIComponent(id)}`)
  ).json()) as { title: string };
  await theaterLink.click();
  const box = page.getByRole('dialog', { name: 'Box office' });
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(box.locator('.boxoffice__title')).toContainText(title);
});

test('theater on a phone: the thumbstick moves you, the other thumb turns the view @phone', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await signIn(page);
  const welcome = await enter(page);
  await expect(welcome).toContainText('left thumb');
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  await expect(page.getByText('Drag here to walk')).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: info.outputPath('theater-phone.png') });
  const size = page.viewportSize()!;
  const x = size.width * 0.2;
  const y = size.height * 0.65;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 4 });
  await expect(page.locator('.touch__stick')).toBeVisible();
  await expect(page.locator('.theater__place')).toHaveText('Hallway', { timeout: 60_000 });
  await page.mouse.up();
  // Push it to the right: you step right, and the view doesn't turn at all.
  const state = () =>
    page.evaluate(() => {
      const e = (window as unknown as { __theater: { engine: Engine } }).__theater.engine;
      return { x: e.body.x, yaw: e.yaw };
    });
  const yaw = async () => (await state()).yaw;
  const before = await state();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 4 });
  await page.waitForTimeout(1500);
  await page.mouse.up();
  const after = await state();
  expect(after.yaw).toBe(before.yaw);
  expect(after.x).toBeGreaterThan(before.x + 0.2);
  // Drag on the right half: you look around.
  const looked = await yaw();
  await page.mouse.move(size.width * 0.7, size.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(size.width * 0.5, size.height * 0.4, { steps: 4 });
  await page.mouse.up();
  expect(await yaw()).toBeGreaterThan(looked + 0.3);
});

test('theater on a phone turned sideways: the view fills the screen @phone', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await signIn(page);
  const welcome = await enter(page);
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  const portrait = page.viewportSize()!;
  await page.setViewportSize({ width: portrait.height, height: portrait.width });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: info.outputPath('theater-landscape.png') });
  const canvas = await page.locator('canvas.theater__canvas').boundingBox();
  expect(canvas!.width).toBeCloseTo(portrait.height, -1);
  expect(canvas!.height).toBeCloseTo(portrait.width, -1);
  // Not stretched: the drawing buffer has the same shape as the screen.
  const shape = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas.theater__canvas')!;
    return c.width / c.height;
  });
  expect(shape).toBeCloseTo(portrait.height / portrait.width, 1);
});

test('theater: walk forward, back, sideways, run, jump, and wherever you turn', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const welcome = await enter(page);
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  const where = () =>
    page.evaluate(() => {
      const e = (window as unknown as { __theater: { engine: Engine } }).__theater.engine;
      return { x: e.body.x, y: e.body.y, z: e.body.z, yaw: e.yaw };
    });
  const hold = async (key: string, ms = 600) => {
    const before = await where();
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
    const after = await where();
    return { dx: after.x - before.x, dz: after.z - before.z, dyaw: after.yaw - before.yaw };
  };
  // At the doors, facing the hallway (north is -z).
  expect((await hold('w')).dz).toBeLessThan(-0.2);
  expect((await hold('s')).dz).toBeGreaterThan(0.2);
  expect((await hold('d')).dx).toBeGreaterThan(0.2);
  expect((await hold('a')).dx).toBeLessThan(-0.2);
  const turned = await hold('ArrowRight', 900);
  expect(turned.dyaw).toBeLessThan(-0.3);
  await face(page, -Math.PI / 2);
  const east = await hold('ArrowUp');
  expect(east.dx).toBeGreaterThan(0.2);
  expect(Math.abs(east.dz)).toBeLessThan(0.1);
  // Running is faster than walking.
  const speed = await page.evaluate(() => {
    const e = (window as unknown as { __theater: { engine: Engine } }).__theater.engine;
    Object.assign(e.body, { x: 0, z: 6 });
    e.yaw = 0;
    e.simulate({ forward: 1 }, 0.5);
    const walked = 6 - e.body.z;
    Object.assign(e.body, { x: 0, z: 6 });
    e.simulate({ forward: 1, sprint: true }, 0.5);
    return { walked, ran: 6 - e.body.z };
  });
  expect(speed.ran).toBeGreaterThan(speed.walked * 1.4);
  // Space jumps.
  await page.keyboard.press('Space');
  await expect.poll(async () => (await where()).y, { timeout: 5000 }).toBeGreaterThan(0.2);
  await expect.poll(async () => (await where()).y, { timeout: 5000 }).toBe(0);
  // Dragging on the view turns it too.
  const before = (await where()).yaw;
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(500, 450, { steps: 5 });
  await page.mouse.up();
  expect((await where()).yaw).toBeGreaterThan(before + 0.3);
});

test('theater: walk the whole way on foot, from the doors to a seat and to The Collection', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  const welcome = await enter(page);
  await welcome.getByRole('button', { name: 'Let’s go' }).click();

  // Walk to the box office and buy a ticket for Theater 1's movie.
  await walkTo(page, -9.5, -4.3, 'the box office');
  await face(page, 0);
  await page.getByRole('button', { name: /Buy a ticket/ }).click();
  const box = page.getByRole('dialog', { name: 'Box office' });
  await box.locator('.lineup__card').first().click();
  await box.getByRole('radio', { name: 'Private screening' }).click();
  await box.getByRole('button', { name: 'Get a ticket' }).click();
  await expect(page.getByRole('complementary', { name: 'Your ticket' })).toContainText('Theater 1');

  // Past the usher, into the hallway, through Theater 1's door (on the left).
  await walkTo(page, 0, -12.5, 'the hallway');
  await expect(page.locator('.theater__place')).toHaveText('Hallway');
  await walkTo(page, -2.4, -12.5, 'Theater 1’s door');
  await walkTo(page, -5.5, -12.5, 'inside Theater 1');
  await expect(page.locator('.theater__place')).toHaveText('Theater 1');
  // Up the aisle stairs and along the walkway in front of row C.
  await walkTo(page, -14.5, -12.5, 'the aisle by row C');
  await walkTo(page, -14.5, -19.5, 'the middle of row C');
  await expect(page.getByRole('button', { name: /Sit in seat C5/ })).toBeVisible();
  await page.getByRole('button', { name: /Sit in seat C5/ }).click();
  await expect(page.getByRole('group', { name: 'Movie controls' })).toBeVisible();
  await page
    .getByRole('group', { name: 'Movie controls' })
    .getByRole('button', { name: 'Stand up' })
    .click();

  // Back out, down the hallway to The Collection.
  await walkTo(page, -14.5, -12.5, 'the aisle');
  await walkTo(page, -5.5, -12.5, 'the door');
  await walkTo(page, 0, -12.5, 'the hallway');
  await walkTo(page, 0, -74, 'the end of the hallway');
  await walkTo(page, 0, -78.5, 'The Collection');
  await expect(page.locator('.theater__place')).toHaveText('The Collection');
  // In front of the first wall of posters: one of them offers a ticket.
  await walkTo(page, 0.6, -80.3, 'in front of the posters');
  await face(page, 0);
  await expect(page.getByRole('button', { name: /Get a ticket/ })).toBeVisible();
  // And on round the zig-zag, through the gap at the east end.
  await walkTo(page, 8, -80, 'the end of the first wall');
  await walkTo(page, 8, -84.5, 'the second corridor');
});
