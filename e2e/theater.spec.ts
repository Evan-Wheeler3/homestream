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

test('theater: get a ticket, find a seat, sit down, and the movie starts after 3, 2, 1', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await signIn(page);
  await page.getByRole('link', { name: /Go to the movies/ }).click();
  await expect(page).toHaveURL('/theater');
  // First visit: the welcome.
  const welcome = page.getByRole('dialog', { name: 'Welcome to Wheelhouse Cinemas' });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('canvas.theater__canvas')).toBeVisible();
  await page.screenshot({ path: info.outputPath('theater-welcome.png') });
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  // On the home server it's just you.
  await expect(page.getByRole('button', { name: /Just you/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('theater-lobby.png') });

  // To the box office.
  await page.getByRole('button', { name: 'Go to…' }).click();
  await page.getByRole('button', { name: 'Box office' }).click();
  await page.getByRole('button', { name: /Buy a ticket/ }).click();
  const box = page.getByRole('dialog', { name: 'Box office' });
  await expect(box).toBeVisible();
  await box.getByLabel('Search movies').fill('a');
  await box.locator('.boxoffice__movie').first().click();
  await box.getByRole('radio', { name: 'Private screening' }).click();
  const title = (await box.locator('.boxoffice__title').innerText()).replace(/\s*\(\d{4}\)$/, '');
  await box.getByRole('button', { name: 'Get a ticket' }).click();
  await expect(box).toBeHidden();
  const ticket = page.getByRole('complementary', { name: 'Your ticket' });
  await expect(ticket).toContainText('Theater 1');
  await expect(ticket).toContainText(title);

  // The usher knows where to go; the door needs the ticket.
  await ticket.getByRole('button', { name: 'Find me a seat' }).click();
  await expect(page.locator('.theater__place')).toHaveText('Theater 1');
  const sit = page.getByRole('button', { name: /Sit in seat C5/ });
  await expect(sit).toBeVisible();
  await page.screenshot({ path: info.outputPath('theater-auditorium.png') });
  await sit.click();

  // 3, 2, 1, then the movie plays on the big screen.
  await expect(page.getByText(/^[123]$/)).toBeAttached();
  await page.screenshot({ path: info.outputPath('theater-countdown.png') });
  await expect(page.getByText(/^[123]$/)).not.toBeAttached({ timeout: 6000 });
  const controls = page.getByRole('group', { name: 'Movie controls' });
  await expect(controls.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelector<HTMLVideoElement>('.theater__video')?.currentTime ?? 0,
        ),
      {
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(0.5);
  await page.waitForTimeout(800);
  await page.screenshot({ path: info.outputPath('theater-playing.png') });

  // Pausing and standing up.
  await controls.getByRole('button', { name: 'Pause' }).click();
  await expect(controls.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await controls.getByRole('button', { name: 'Stand up' }).click();
  await expect(controls).toBeHidden();
  await expect(page.getByRole('button', { name: /Sit in seat/ })).toBeVisible();

  // Snacks, and a reaction.
  await page.getByRole('button', { name: 'Go to…' }).click();
  await page.getByRole('button', { name: 'Concessions' }).click();
  await page.getByRole('button', { name: /Get snacks/ }).click();
  await page
    .getByRole('dialog', { name: 'Concessions' })
    .getByRole('button', { name: 'Popcorn' })
    .click();
  await expect(page.locator('.theater__snack')).toHaveText('🍿');
  await page.getByRole('button', { name: 'React 😂' }).click();
  await expect(page.locator('.theater__float')).toHaveText('😂');

  // Returning the ticket frees the theater.
  await ticket.getByRole('button', { name: 'Return ticket' }).click();
  await expect(ticket).toBeHidden();
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
  ).json()) as {
    title: string;
  };
  await theaterLink.click();
  const box = page.getByRole('dialog', { name: 'Box office' });
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(box.locator('.boxoffice__title')).toContainText(title);
});

test('theater on a phone: a thumbstick walks you around @phone', async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto('/theater');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Wheelhouse Cinemas' });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await expect(welcome).toContainText('thumbstick');
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  const stick = page.locator('.joystick');
  await expect(stick).toBeVisible();
  await page.screenshot({ path: info.outputPath('theater-phone.png') });
  // Push the stick forward: you walk from the lobby into the hallway.
  const box = (await stick.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 50, { steps: 4 });
  await expect(page.locator('.theater__place')).toHaveText('Hallway', { timeout: 30_000 });
  await page.mouse.up();
  // Push it to the right: you turn right.
  const yaw = () =>
    page.evaluate(
      () => (window as unknown as { __theater: { engine: { yaw: number } } }).__theater.engine.yaw,
    );
  const before = await yaw();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 50, y, { steps: 4 });
  await page.waitForTimeout(1500);
  await page.mouse.up();
  expect(await yaw()).toBeLessThan(before - 0.2);
});

test('theater: walk forward, back, sideways, and wherever you turn', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto('/theater');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Wheelhouse Cinemas' });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  const where = () =>
    page.evaluate(() => {
      const e = (
        window as unknown as { __theater: { engine: { x: number; z: number; yaw: number } } }
      ).__theater.engine;
      return { x: e.x, z: e.z, yaw: e.yaw };
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
  // Turn right with the arrow key, then walk: you go the way you're facing (east, +x).
  const turned = await hold('ArrowRight', 900);
  expect(turned.dyaw).toBeLessThan(-0.3);
  await page.evaluate(() => {
    const e = (window as unknown as { __theater: { engine: { yaw: number } } }).__theater.engine;
    e.yaw = -Math.PI / 2;
  });
  const east = await hold('ArrowUp');
  expect(east.dx).toBeGreaterThan(0.2);
  expect(Math.abs(east.dz)).toBeLessThan(0.1);
  // Dragging on the view turns it too.
  const before = (await where()).yaw;
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(500, 450, { steps: 5 });
  await page.mouse.up();
  expect((await where()).yaw).toBeGreaterThan(before + 0.3);
  // Walls stop you, but you slide along them: walk diagonally into the east wall.
  await page.evaluate(() => {
    const e = (
      window as unknown as { __theater: { engine: { x: number; z: number; yaw: number } } }
    ).__theater.engine;
    Object.assign(e, { x: 13.3, z: 7, yaw: -Math.PI / 4 });
  });
  const slide = await hold('w', 800);
  expect(slide.dz).toBeLessThan(-0.15);
  expect((await where()).x).toBeLessThan(13.75);
});

test('theater: walk the whole way on foot, from the doors to a seat and to The Collection', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  await page.goto('/theater');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Wheelhouse Cinemas' });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  type E = { x: number; z: number; yaw: number };
  /** Faces the target and walks there (through the same walls and doors as the keys). */
  const walkTo = async (x: number, z: number, label: string) => {
    const result = await page.evaluate(
      ([tx, tz]) => {
        const e = (
          window as unknown as {
            __theater: {
              engine: E & { simulate(i: { forward: number }, s: number): void };
            };
          }
        ).__theater.engine;
        let stuck = 0;
        for (let i = 0; i < 400; i++) {
          const dist = Math.hypot(tx! - e.x, tz! - e.z);
          if (dist < 0.2) return 'ok';
          e.yaw = Math.atan2(-(tx! - e.x), -(tz! - e.z));
          const before = { x: e.x, z: e.z };
          e.simulate({ forward: 1 }, Math.min(0.1, dist / 4.2));
          stuck = Math.hypot(e.x - before.x, e.z - before.z) < 0.005 ? stuck + 1 : 0;
          if (stuck >= 3) return `stuck at ${e.x.toFixed(2)}, ${e.z.toFixed(2)}`;
        }
        return `never got there: at ${e.x.toFixed(2)}, ${e.z.toFixed(2)}`;
      },
      [x, z],
    );
    expect(result, `walking to ${label}`).toBe('ok');
    // Let the page catch up with where you are.
    await page.waitForTimeout(400);
  };

  // Walk to the box office and buy a ticket there.
  await walkTo(-8.5, -4.3, 'the box office');
  await page.evaluate(() => {
    (window as unknown as { __theater: { engine: E } }).__theater.engine.yaw = 0;
  });
  await page.getByRole('button', { name: /Buy a ticket/ }).click();
  const box = page.getByRole('dialog', { name: 'Box office' });
  await box.locator('.boxoffice__movie').first().click();
  await box.getByRole('radio', { name: 'Private screening' }).click();
  await box.getByRole('button', { name: 'Get a ticket' }).click();
  await expect(page.getByRole('complementary', { name: 'Your ticket' })).toContainText('Theater 1');

  // Past the usher, into the hallway, through Theater 1's door (on the left).
  await walkTo(0, -6, 'the hallway entrance');
  await walkTo(0, -13, 'the hallway');
  await expect(page.locator('.theater__place')).toHaveText('Hallway');
  await walkTo(-2.4, -13, 'Theater 1’s door');
  await walkTo(-5.5, -13, 'inside Theater 1');
  await expect(page.locator('.theater__place')).toHaveText('Theater 1');
  // Up the side aisle (it's stairs) and along the walkway in front of row C to the middle.
  await walkTo(-14.15, -13.2, 'the aisle by row C');
  await walkTo(-14.15, -19.5, 'the middle of row C');
  await expect(page.getByRole('button', { name: /Sit in seat C/ })).toBeVisible();
  await page.getByRole('button', { name: /Sit in seat C/ }).click();
  await expect(page.getByRole('group', { name: 'Movie controls' })).toBeVisible();
  await page
    .getByRole('group', { name: 'Movie controls' })
    .getByRole('button', { name: 'Stand up' })
    .click();

  // Back out, down the hallway to The Collection.
  await walkTo(-14.15, -13.2, 'the aisle');
  await walkTo(-5.5, -13, 'the door');
  await walkTo(0, -13, 'the hallway');
  await walkTo(0, -78, 'the end of the hallway');
  await walkTo(0, -81, 'The Collection');
  await expect(page.locator('.theater__place')).toHaveText('The Collection');
  // Up to the first wall of posters: one of them offers a ticket.
  await walkTo(0.6, -81.3, 'in front of the posters');
  await page.evaluate(() => {
    (window as unknown as { __theater: { engine: E } }).__theater.engine.yaw = 0;
  });
  await expect(page.getByRole('button', { name: /Get a ticket/ })).toBeVisible();
});
