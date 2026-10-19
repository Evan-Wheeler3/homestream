import { expect, test, type Page } from '@playwright/test';

const local = !process.env.CLOUD_URL;

async function signIn(page: Page) {
  await page.goto('/login');
  const other = page.getByRole('button', { name: 'Sign in as someone else' });
  const username = page.getByLabel('Username');
  await expect(username.or(other)).toBeVisible();
  if (await other.isVisible()) await other.click();
  await username.fill(process.env.E2E_USERNAME!);
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('main')).toBeVisible();
}

/** Plays the first movie and checks the video really advances, then seeks. */
async function playFirstMovie(page: Page) {
  await page.goto('/browse');
  const first = page.locator('a.poster-card').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page).toHaveURL(/\/movie\//);
  await page
    .getByRole('link', { name: /^(Play|Resume)/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/play\//);
  const video = page.locator('video');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 })
    .toBeGreaterThan(0.5);
  // Seeking needs Range requests to work.
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = Math.max(1, (v.duration || 10) - 3);
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThan(2);
  return video;
}

test('signed out, everything redirects to sign-in and media is private', async ({
  page,
  request,
}) => {
  await page.goto('/browse');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText(/invited/)).toBeVisible();
  expect((await request.get('/api/movies')).status()).toBe(401);
});

test('sign in, browse, open a movie and play it with seeking', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Recently Added' })).toBeVisible();
  await playFirstMovie(page);
});

test('subtitles are off by default and can be turned on', async ({ page }) => {
  test.skip(!local, 'Needs the seeded movie with subtitles');
  await signIn(page);
  await page.goto('/movie/e2e-1');
  await page
    .getByRole('link', { name: /^(Play|Resume)/ })
    .first()
    .click();
  const video = page.locator('video');
  await expect(video).toBeVisible();
  await expect(page.locator('video track')).toHaveCount(1);
  const showing = () =>
    video.evaluate(
      (v: HTMLVideoElement) => [...v.textTracks].filter((t) => t.mode === 'showing').length,
    );
  expect(await showing()).toBe(0);
  await page.mouse.move(400, 400);
  await page.getByRole('button', { name: /Subtitles/ }).click();
  await page.getByRole('menuitemradio', { name: /English/ }).click();
  await expect.poll(showing).toBe(1);
});

test('resume point is remembered after stopping', async ({ page }) => {
  await signIn(page);
  await playFirstMovie(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/movie\//);
  await page.reload();
  await expect(page.getByRole('link', { name: /Resume/ }).first()).toBeVisible({ timeout: 15_000 });
});

test('admin: invite someone, who then creates an account from the link', async ({
  page,
  browser,
}) => {
  test.skip(!local, 'Creates accounts');
  await signIn(page);
  await page.goto('/settings#sharing');
  await page.getByLabel('Invite someone').fill('Sam');
  await page.getByRole('button', { name: 'Make invitation link' }).click();
  const url = await page.locator('.cloud-link__url').inputValue();
  expect(url).toMatch(/\/invite\//);
  await expect(page.getByText('Invited · link works until')).toBeVisible();

  const guest = await browser.newContext();
  const tab = await guest.newPage();
  await tab.goto(url);
  await expect(tab.getByText('Welcome, Sam')).toBeVisible();
  await tab.getByLabel('Username').fill('sam');
  await tab.getByLabel('Password', { exact: true }).fill('sam password');
  await tab.getByLabel('Type it again').fill('sam password');
  await tab.getByRole('button', { name: 'Create account' }).click();
  await expect(tab).toHaveURL('/');
  await expect(tab.getByRole('main')).toBeVisible();
  // The link works only once.
  await tab.goto(url);
  await expect(tab.getByText(/already been used/)).toBeVisible();
  await guest.close();
});

test('admin settings show storage, backups and subtitles; Jellyfin options are gone', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Storage and backups' })).toBeVisible();
  await expect(page.getByText(/a month/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Subtitles', exact: true })).toBeVisible();
  await expect(page.getByText('Maximum streaming quality')).toHaveCount(0);
  await expect(page.getByText('Prefer direct play')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Updates' })).toHaveCount(0);
});

test('Discs shows the Mac as offline when it is not reporting', async ({ page }) => {
  test.skip(!local, 'The real Mac may be online');
  await signIn(page);
  await page.goto('/rips');
  await expect(page.getByText('Mac offline.')).toBeVisible();
});

test('@phone the phone layout signs in, browses and plays', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('navigation').last()).toBeVisible();
  await playFirstMovie(page);
});

test('@tv TV mode turns on by itself and plays from the remote', async ({ page }) => {
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('data-tv');
  await playFirstMovie(page);
});
