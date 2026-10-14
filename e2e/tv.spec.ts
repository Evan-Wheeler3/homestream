import { expect, test, type Page } from '@playwright/test';

// Runs in the "tv" project: an LG webOS browser user agent at 1920×1080.

async function signIn(page: Page) {
  const user = `tv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('main')).toBeVisible();
}

/** Press an LG remote button that browsers report only by key code (e.g. Back = 461). */
async function pressRemote(page: Page, keyCode: number) {
  await page.evaluate((code) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Unidentified',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'keyCode', { get: () => code });
    (document.activeElement ?? document.body).dispatchEvent(event);
  }, keyCode);
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    return {
      label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 60) ?? '',
      href: el.getAttribute('href'),
      x: r.left,
      y: r.top,
      // Position within its row of posters (rows scroll, so screen positions shift).
      row: el.closest('.row')?.querySelector('h2')?.textContent ?? null,
      column: el.closest('.row__track')
        ? Array.from(el.closest('.row__track')!.children).findIndex((c) => c.contains(el))
        : -1,
      inView: r.bottom > 0 && r.top < innerHeight,
    };
  });

test('@tv TV mode turns on by itself and the remote drives Home → detail → back', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('data-tv', '');
  // Focus starts on the page so the remote has somewhere to begin.
  await expect.poll(() => focused(page)).not.toBeNull();

  // Down into the first row of posters, then right along it.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('ArrowDown');
    const now = await focused(page);
    if (now?.href?.startsWith('/movie/')) break;
  }
  const start = await focused(page);
  expect(start?.href).toMatch(/^\/movie\//);
  // Scrolling to the focused poster is animated; it must end with the poster on screen.
  await expect.poll(async () => (await focused(page))?.inView).toBe(true);

  await page.keyboard.press('ArrowRight');
  const next = await focused(page);
  expect(next?.href).toMatch(/^\/movie\//);
  expect(next?.row).toBe(start?.row);
  expect(next!.column).toBe(start!.column + 1);

  // OK opens the movie; the detail page then has focus on a control.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(next!.href!);
  await expect.poll(() => focused(page)).not.toBeNull();

  // LG Back (461) returns to Home.
  await pressRemote(page, 461);
  await expect(page).toHaveURL('/');
});

test('@tv the remote controls playback and Back leaves the player', async ({ page }) => {
  await signIn(page);
  await page.goto('/movie/his-girl-friday-1940');
  const play = page.getByRole('link', { name: 'Play', exact: true });
  await play.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/play\//);
  // Starting playback from the remote goes full screen (hides the TV browser's toolbar).
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);

  const time = () => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
  const paused = () => page.evaluate(() => document.querySelector('video')?.paused);
  await expect.poll(time, { timeout: 20_000 }).toBeGreaterThan(1);

  // OK pauses and resumes.
  await page.keyboard.press('Enter');
  await expect.poll(paused).toBe(true);
  const before = await time();

  // Right skips forward 10 seconds; the LG Rewind button (412) goes back.
  await page.keyboard.press('ArrowRight');
  await expect.poll(time).toBeGreaterThan(before + 8);
  const skipped = await time();
  await pressRemote(page, 412);
  await expect.poll(time).toBeLessThan(skipped - 8);

  // LG Play (415) resumes.
  await pressRemote(page, 415);
  await expect.poll(paused).toBe(false);

  // Down reveals the controls and focuses one; arrows then move between controls.
  await page.keyboard.press('ArrowDown');
  const first = await focused(page);
  expect(first?.label).toMatch(/Pause|Play/);
  await page.keyboard.press('ArrowRight');
  const second = await focused(page);
  expect(second?.label).not.toBe(first?.label);
  expect(second!.x).toBeGreaterThan(first!.x);

  // Back hides the controls first, then leaves the player.
  await pressRemote(page, 461);
  await expect.poll(() => focused(page)).toBeNull();
  await pressRemote(page, 461);
  await expect(page).toHaveURL(/\/movie\/his-girl-friday-1940/);
});

test('@tv TV mode can be switched off for this device in Settings', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  const group = page.getByRole('radiogroup', { name: 'TV mode' });
  await group.getByRole('radio', { name: 'Off' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-tv');
  await page.reload();
  await expect(page.locator('html')).not.toHaveAttribute('data-tv');
  await page
    .getByRole('radiogroup', { name: 'TV mode' })
    .getByRole('radio', { name: 'Automatic' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-tv', '');
});
