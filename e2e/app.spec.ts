import { expect, test, type Browser, type Page } from '@playwright/test';

/** A fresh user per test run, so repeated runs against one database stay independent. */
function uniqueUser(base: string) {
  return `${base}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function signIn(page: Page, user = uniqueUser('e2e')) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  // Wait for the app shell (session + preferences loaded), not just the URL change.
  await expect(page.getByRole('main')).toBeVisible();
}

async function newDevice(browser: Browser, user: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user);
  return { context, page };
}

test('sign-in rejects a wrong password and redirects back after success', async ({ page }) => {
  await page.goto('/browse');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Username').fill('e2e');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect username or password');
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/browse');
});

test('home shows the hero, Continue Watching and the sample-library label', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('region', { name: 'Featured' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Continue Watching' })).toBeVisible();
  await expect(page.getByText('Sample library').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Play|Resume/ }).first()).toBeVisible();
});

test('browse: search, filter, sort and random pick', async ({ page }) => {
  await signIn(page);
  await page.goto('/browse');
  await page.getByPlaceholder('Search titles').fill('samurai');
  await expect(page.getByRole('link', { name: /Seven Samurai/ })).toBeVisible();
  await expect(page).toHaveURL(/q=samurai/);
  await page.getByPlaceholder('Search titles').fill('');
  await expect(page).not.toHaveURL(/q=/);

  await page.getByRole('button', { name: /Filters/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Filters' });
  await dialog.getByRole('button', { name: /^Animation/ }).click();
  await dialog.getByRole('button', { name: /^Show \d+ movies?$/ }).click();
  await expect(page).toHaveURL(/genre=Animation/);
  const cards = page.getByRole('list', { name: 'Movies' }).getByRole('listitem');
  await expect(cards).toHaveCount(5);
  await expect(page.getByRole('button', { name: /Remove filter Animation/ })).toBeVisible();

  await page.getByLabel('Sort by').selectOption('year');
  await expect(page).toHaveURL(/sort=year/);
  await expect(cards.first()).toContainText('Spirited Away'); // newest first by default
  await page.getByRole('button', { name: /Descending/ }).click();
  await expect(page).toHaveURL(/dir=asc/);
  await expect(cards.first()).toContainText('Totoro');

  await page.getByRole('button', { name: 'Random pick' }).click();
  await expect(page).toHaveURL(/\/movie\//);
});

test('detail: favorite, rating and notes persist after reload', async ({ page }) => {
  await signIn(page);
  await page.goto('/movie/ugetsu-1953');
  await expect(page.getByRole('heading', { name: 'Ugetsu', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
  await page.getByRole('radio', { name: '4 stars' }).click();
  await page.getByLabel('Personal notes').fill('Watch the lake scene again.');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByText(/Saved/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
  await expect(page.getByRole('radio', { name: '4 stars' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByLabel('Personal notes')).toHaveValue('Watch the lake scene again.');
});

test('missing metadata is shown honestly', async ({ page }) => {
  await signIn(page);
  await page.goto('/movie/plan-9-1957');
  await expect(page.getByText('No synopsis is available for this movie.')).toBeVisible();
  await page.goto('/movie/no-such-movie');
  await expect(page.getByRole('heading', { name: 'Movie not found' })).toBeVisible();
});

test('collections: create, add from a movie, and see it on another device', async ({
  page,
  browser,
}) => {
  const user = uniqueUser('collector');
  await signIn(page, user);
  await page.goto('/collections');
  await page.getByRole('button', { name: 'New collection' }).click();
  const editor = page.getByRole('dialog', { name: 'New collection' });
  await editor.getByLabel('Name').fill('Rainy Sunday');
  await editor.getByRole('button', { name: 'Create collection' }).click();
  await expect(page.getByRole('heading', { name: 'Rainy Sunday' })).toBeVisible();

  await page.goto('/movie/tokyo-story-1953');
  await page.getByRole('button', { name: 'Add to collection' }).click();
  await page
    .getByRole('dialog', { name: 'Add to collection' })
    .getByRole('button', { name: /Rainy Sunday/ })
    .click();
  await expect(page.getByText('Added to Rainy Sunday')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('link', { name: 'Rainy Sunday' })).toBeVisible();

  const tablet = await newDevice(browser, user);
  await tablet.page.goto('/collections');
  await tablet.page.getByRole('link', { name: /Rainy Sunday/ }).click();
  await expect(tablet.page.getByRole('link', { name: /Tokyo Story/ })).toBeVisible();
  await tablet.context.close();
});

test('smart collection editor previews matches and creates the collection', async ({ page }) => {
  const user = uniqueUser('smart-e2e');
  await signIn(page, user);
  await page.goto('/collections');
  await page.getByRole('button', { name: 'New collection' }).click();
  const editor = page.getByRole('dialog', { name: 'New collection' });
  await editor.getByLabel('Name').fill('Wong Kar-wai');
  await editor.getByRole('radio', { name: 'Smart (rule-based)' }).click();
  await editor.getByRole('button', { name: 'Add rule' }).click();
  await editor.getByLabel('Rule field').selectOption('director');
  await editor.getByRole('button', { name: 'Wong Kar-wai' }).click();
  await expect(editor.getByText(/2 movies currently match/)).toBeVisible();
  await editor.getByRole('button', { name: 'Create collection' }).click();
  await expect(page.getByText('Smart collection')).toBeVisible();
  await expect(page.getByRole('link', { name: /Chungking Express/ })).toBeVisible();
});

test('settings: accent and theme apply immediately and follow the user', async ({
  page,
  browser,
}) => {
  const user = uniqueUser('stylist');
  await signIn(page, user);
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Lagoon' }).click();
  await page.getByRole('radio', { name: /Midnight/ }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent')))
    .toBe('#4fb3a9');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');

  const other = await newDevice(browser, user);
  await expect(other.page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await other.context.close();
});

test('settings: home sections can be hidden', async ({ page }) => {
  const user = uniqueUser('minimalist');
  await signIn(page, user);
  await page.goto('/settings#home');
  await page.getByRole('button', { name: 'Hide Continue Watching' }).click();
  await expect(page.getByRole('button', { name: 'Show Continue Watching' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recently Added' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Continue Watching' })).toHaveCount(0);
});

test('player: sample clip plays, is labelled as mock, and returns', async ({ page }) => {
  await signIn(page);
  await page.goto('/movie/his-girl-friday-1940');
  await page.getByRole('link', { name: 'Play', exact: true }).click();
  await expect(page).toHaveURL(/\/play\//);
  await expect(page.getByText('Sample clip · mock playback')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0), {
      timeout: 20_000,
    })
    .toBeGreaterThan(1);
  await page.keyboard.press('k');
  await expect.poll(() => page.evaluate(() => document.querySelector('video')?.paused)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/movie\/his-girl-friday-1940/);
});

test('search page: keyboard shortcut, Enter opens the top result', async ({ page }) => {
  await signIn(page);
  await page.keyboard.press('/');
  await expect(page).toHaveURL(/\/search/);
  await page.keyboard.type('rashomon');
  await expect(page.getByText('1 result')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/movie/rashomon-1950');
});

test('shows a clear offline banner and recovers when the server is back', async ({ page }) => {
  await signIn(page);
  await page.goto('/browse');
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await page.getByPlaceholder('Search titles').fill('heat');
  const banner = page.getByText('Cannot reach the Private Cinema server');
  await expect(banner).toBeVisible();
  // Retrying while the server is still unreachable keeps the banner up.
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(banner).toBeVisible();
  await page.unroute('**/api/**');
  // Recovery happens either through the Retry button or the app's own automatic retries.
  await expect(async () => {
    const retry = page.getByRole('button', { name: 'Retry' });
    if (await retry.isVisible()) await retry.click({ timeout: 1000 }).catch(() => undefined);
    await expect(banner).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: /Heat/ })).toBeVisible();
});

test('phone layout uses the bottom tab bar @phone', async ({ page }) => {
  const user = uniqueUser('phone-user');
  await signIn(page, user);
  const tabbar = page.getByRole('navigation', { name: 'Main' }).last();
  await expect(tabbar).toBeVisible();
  await tabbar.getByRole('link', { name: 'Browse' }).click();
  await expect(page).toHaveURL('/browse');
  await tabbar.getByRole('link', { name: 'Collections' }).click();
  await expect(page.getByRole('heading', { name: 'Collections', level: 1 })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
