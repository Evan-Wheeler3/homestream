import { useLoginForm } from './helpers';
import { expect, test, type Browser, type Page } from '@playwright/test';

/** A fresh user per test run, so repeated runs against one database stay independent. */
function uniqueUser(base: string) {
  return `${base}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function signIn(page: Page, user = uniqueUser('e2e')) {
  await page.goto('/login');
  await useLoginForm(page);
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
  await useLoginForm(page);
  await page.getByLabel('Username').fill('e2e');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect username or password');
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/browse');
});

test("who's watching: pick a profile, enter its password, switch profile", async ({ browser }) => {
  const name = uniqueUser('Profile');
  const first = await newDevice(browser, name);
  await first.context.close();

  // Another device: the person shows up on the "Who's watching?" screen.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toBeVisible();
  await page.getByRole('button', { name }).click();
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('main')).toBeVisible();

  // "Switch profile" goes back to the picker.
  await page.getByRole('button', { name: /Switch profile/ }).click();
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toBeVisible();
  await context.close();
});

test('home shows the hero, Continue Watching and the sample-library label', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('region', { name: 'Featured' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Continue Watching' })).toBeVisible();
  await expect(page.getByText('Sample library').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Play|Resume/ }).first()).toBeVisible();
});

test('browse: search, filter, sort and spin from the filtered list', async ({ page }) => {
  await signIn(page);
  await page.goto('/browse');
  await page.getByPlaceholder('Search titles').fill('samurai');
  await expect(page.getByRole('link', { name: /Seven Samurai/ })).toBeVisible();
  await expect(page).toHaveURL(/q=samurai/);
  await page.getByPlaceholder('Search titles').fill('');
  await expect(page).not.toHaveURL(/q=/);

  await page.getByRole('button', { name: /All filters/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Filters' });
  await dialog.getByRole('button', { name: /^Animation/ }).click();
  await dialog.getByRole('button', { name: /^Show \d+ movies?$/ }).click();
  await expect(page).toHaveURL(/genre=Animation/);
  const cards = page.getByRole('list', { name: 'Movies' }).getByRole('listitem');
  await expect(cards).toHaveCount(5);
  // The genre now shows in its quick-filter pill.
  await expect(
    page.getByRole('group', { name: 'Quick filters' }).getByRole('button', { name: 'Animation' }),
  ).toBeVisible();

  await page.getByLabel('Sort by').selectOption('year');
  await expect(page).toHaveURL(/sort=year/);
  await expect(cards.first()).toContainText('Spirited Away'); // newest first by default
  await page.getByRole('button', { name: /Descending/ }).click();
  await expect(page).toHaveURL(/dir=asc/);
  await expect(cards.first()).toContainText('Totoro');

  await page.getByRole('link', { name: 'Spin the wheel' }).click();
  await expect(page).toHaveURL(/\/spin\?.*genre=Animation/);
  await expect(page.getByText(/Only animation/)).toBeVisible();
});

test('quick filters: runtime and director in one tap each', async ({ page }) => {
  await signIn(page);
  await page.goto('/browse');
  const quick = page.getByRole('group', { name: 'Quick filters' });
  const cards = page.getByRole('list', { name: 'Movies' }).getByRole('listitem');

  await quick.getByRole('button', { name: 'Runtime' }).click();
  await page.getByRole('button', { name: 'Over 2 hours' }).click();
  await expect(page).toHaveURL(/runtimeMin=121/);
  await expect(quick.getByRole('button', { name: 'Over 2 hours' })).toBeVisible();
  await expect(cards.filter({ hasText: 'Seven Samurai' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'Rashomon' })).toHaveCount(0); // 88 minutes

  await quick.getByRole('button', { name: 'Director' }).click();
  await page.getByLabel('Find a director').fill('kuros');
  await page.getByRole('button', { name: /^Akira Kurosawa/ }).click();
  await expect(page).toHaveURL(/director=Akira\+Kurosawa|director=Akira%20Kurosawa/);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Seven Samurai');

  await quick.getByRole('button', { name: 'Clear' }).click();
  await expect(page).not.toHaveURL(/runtimeMin|director/);
});

test('spin the wheel: it lands on a movie, and "not tonight" takes it off', async ({ page }) => {
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Spin', exact: true }).click();
  await expect(page).toHaveURL(/\/spin\?watched=unwatched/);
  const onWheel = page.getByRole('list', { name: 'Movies on the wheel' }).getByRole('listitem');
  await expect(onWheel).toHaveCount(8);

  await page.getByRole('button', { name: 'Spin the wheel' }).click();
  // The full, animated spin takes about six seconds.
  const result = page
    .getByRole('region', { name: /./ })
    .filter({ hasText: 'Tonight you’re watching' });
  await expect(result).toBeVisible({ timeout: 12_000 });
  const title = (await result.getByRole('heading', { level: 2 }).textContent())!.trim();
  await expect(onWheel.filter({ hasText: title })).toHaveCount(1);
  await expect(result.getByRole('button', { name: /Play|Resume/ })).toBeVisible();

  await result.getByRole('button', { name: /Not tonight/ }).click();
  await expect(onWheel).toHaveCount(7);
  await expect(onWheel.filter({ hasText: title })).toHaveCount(0);
});

test('spin the wheel with reduced motion stops almost at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page);
  await page.goto('/spin?slots=6');
  await expect(
    page.getByRole('list', { name: 'Movies on the wheel' }).getByRole('listitem'),
  ).toHaveCount(6);
  await page.getByRole('button', { name: 'Spin the wheel' }).click();
  await expect(page.getByText('Tonight you’re watching')).toBeVisible({ timeout: 2500 });
  await page.getByRole('link', { name: 'Details' }).click();
  await expect(page).toHaveURL(/\/movie\//);
});

test('detail: title logo art and the trailer player', async ({ page }) => {
  await signIn(page);
  await page.goto('/movie/charade-1963');
  // The title is logo art, still announced as the page heading.
  const heading = page.getByRole('heading', { name: 'Charade', level: 1 });
  await expect(heading.getByRole('img', { name: 'Charade' })).toBeVisible();
  await page.getByRole('button', { name: 'Trailer' }).click();
  const dialog = page.getByRole('dialog', { name: /Trailer/ });
  await expect(dialog.locator('video')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('people: director and actor pages, from the movie page and from search', async ({ page }) => {
  await signIn(page);
  await page.goto('/movie/the-general-1926');
  await page.getByRole('link', { name: 'Buster Keaton' }).first().click();
  await expect(page).toHaveURL(/\/person\/Buster%20Keaton/);
  await expect(page.getByRole('heading', { name: 'Buster Keaton', level: 1 })).toBeVisible();
  const directed = page.getByRole('list', { name: 'Directed by Buster Keaton' });
  await expect(directed.getByRole('link', { name: /Sherlock Jr/ })).toBeVisible();
  await page.getByRole('link', { name: 'Spin their movies' }).click();
  await expect(page).toHaveURL(/\/spin\?(director|actor)=Buster/);

  await page.goto('/search');
  await page.getByPlaceholder('Titles, directors, actors…').fill('mifune');
  await page
    .getByRole('region', { name: 'People' })
    .getByRole('link', { name: /Toshiro Mifune/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Toshiro Mifune', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Starring Toshiro Mifune' }).getByRole('listitem'),
  ).toHaveCount(2);
});

test('watchlist: add from the movie page, see it on Home, spin from it', async ({ page }) => {
  await signIn(page);
  for (const id of ['ugetsu-1953', 'the-kid-1921']) {
    await page.goto(`/movie/${id}`);
    await page.getByRole('button', { name: 'Add to watchlist' }).click();
    await expect(page.getByRole('button', { name: 'Remove from watchlist' })).toBeVisible();
  }
  await page.goto('/');
  const row = page.getByRole('region', { name: 'My Watchlist' });
  await expect(row.getByRole('link', { name: /Ugetsu/ })).toBeVisible();
  await expect(row.getByRole('link', { name: /The Kid/ })).toBeVisible();
  // Recommendations based on what was watched most recently.
  await expect(page.getByRole('heading', { name: /^Because you watched / })).toBeVisible();

  await page.goto('/spin?watchlist=1');
  await expect(page.getByRole('radio', { name: 'Watchlist' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(
    page.getByRole('list', { name: 'Movies on the wheel' }).getByRole('listitem'),
  ).toHaveCount(2);
});

test('Wrapped: the year in movies, from the Home card', async ({ page }) => {
  await signIn(page);
  await page.evaluate(async () => {
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'wheelhouse' };
    const b = { itemId: 'seven-samurai-1954', playSessionId: 'e2e-wrapped', method: 'DirectPlay' };
    await fetch('/api/playback/start', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ ...b, positionSeconds: 0 }),
    });
    await fetch('/api/playback/stop', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ ...b, positionSeconds: 3600 }),
    });
  });
  await page.goto('/');
  await page.getByRole('link', { name: /Your \d{4} in movies/ }).click();
  await expect(page).toHaveURL(/\/wrapped/);
  await expect(page.getByRole('heading', { level: 1, name: /Your \d{4} in movies/ })).toBeVisible();
  await expect(page.getByText('hours watched')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Movies watched' }).getByRole('link', { name: /Seven Samurai/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'All time' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'All your movies' })).toBeVisible();
});

test('movie night: the TV shows a code, a guest votes on a phone, the TV reveals the winner', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.goto('/night');
  await page.getByRole('radio', { name: 'Everything' }).click();
  await page.getByRole('radio', { name: '3' }).click();
  await page.getByRole('button', { name: 'Start movie night' }).click();
  const codeEl = page.getByLabel(/^Code /);
  await expect(codeEl).toBeVisible();
  const code = (await codeEl.textContent())!.trim();
  const choices = page.getByRole('list', { name: 'Choices' }).getByRole('listitem');
  await expect(choices).toHaveCount(3);
  const firstTitle = (await choices.first().locator('strong').textContent())!.trim();

  // A guest's phone: no account.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await phone.newPage();
  await guest.goto('/vote');
  await guest.getByLabel('Code on the TV').fill(code.toLowerCase());
  await guest.getByLabel('Your name').fill('Guest');
  await guest.getByRole('button', { name: 'Join' }).click();
  await guest.getByRole('button', { name: new RegExp(firstTitle) }).click();
  await expect(guest.getByRole('heading', { name: 'Vote counted' })).toBeVisible();
  await expect(guest).toHaveURL(/\/vote/); // never sent to sign in

  // The TV updates by itself, then reveals.
  await expect(page.getByText('Voted: Guest')).toBeVisible({ timeout: 6000 });
  await page.getByRole('button', { name: 'Close voting and reveal' }).click();
  await expect(page.getByRole('heading', { level: 2, name: firstTitle })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Play' })).toBeVisible();
  await expect(guest.getByRole('heading', { name: firstTitle })).toBeVisible({ timeout: 6000 });
  await phone.close();
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

test('requests: ask for a missing movie from search and mark it added', async ({ page }) => {
  await signIn(page);
  const title = `Zork ${Date.now().toString(36)}`;
  await page.goto(`/search?q=${encodeURIComponent(title)}`);
  await page.getByRole('link', { name: `Ask for “${title}”` }).click();
  await expect(page).toHaveURL(/\/requests/);
  await expect(page.getByLabel('Movie')).toHaveValue(title);
  await page.getByLabel('Year (optional)').fill('1999');
  await page.getByRole('button', { name: 'Ask for it' }).click();
  const request = page.locator('.request', { hasText: title });
  await expect(request).toContainText('Asked for');
  await request.getByRole('button', { name: 'Added' }).click();
  await expect(request).toContainText('Added');
  await expect(request.getByRole('button', { name: 'Reopen' })).toBeVisible();
});

test('sharing: invitation, streaming limits and who is watching', async ({ page, browser }) => {
  const viewer = uniqueUser('brother');
  const other = await newDevice(browser, viewer);
  await other.page.goto('/movie/his-girl-friday-1940');
  await other.page.getByRole('link', { name: 'Play', exact: true }).click();
  await expect(other.page).toHaveURL(/\/play\//);

  await signIn(page);
  await page.goto('/settings#sharing');
  await expect(page.getByRole('heading', { name: 'Share with family' })).toBeVisible();
  await expect(page.getByLabel('Invitation')).toContainText('Install Tailscale');
  await page.getByLabel(`Streaming limit for ${viewer}`).selectOption({ label: '4 Mbps — 720p' });
  await expect(page.getByText('Limit saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(`Streaming limit for ${viewer}`)).toHaveValue('4000000');
  await expect(page.locator('.watching__item', { hasText: viewer })).toContainText(
    'His Girl Friday',
    { timeout: 15_000 },
  );
  await other.context.close();
});

test('shows a clear offline banner and recovers when the server is back', async ({ page }) => {
  await signIn(page);
  await page.goto('/browse');
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await page.getByPlaceholder('Search titles').fill('heat');
  const banner = page.getByText('Cannot reach the Wheelhouse server');
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
