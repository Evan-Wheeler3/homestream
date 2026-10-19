import { expect, test } from '@playwright/test';
import { useLoginForm } from './helpers';

test.use({ serviceWorkers: 'allow' });

test('download a movie, then watch it with no connection', async ({ page, context }) => {
  await page.goto('/login');
  await useLoginForm(page);
  await page.getByLabel('Username').fill(`offline-${Date.now().toString(36)}`);
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  // The service worker takes over once it's installed.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  await page.goto('/movie/his-girl-friday-1940');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByText('His Girl Friday is ready to watch offline')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: 'Downloaded' })).toBeVisible();

  await page.goto('/downloads');
  await expect(page.locator('.download', { hasText: 'His Girl Friday' })).toBeVisible();

  // No network at all: the app still opens, lists the download and plays it.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('You’re offline')).toBeVisible({ timeout: 15_000 });
  await page
    .locator('.download', { hasText: 'His Girl Friday' })
    .getByRole('link', { name: 'Play' })
    .click();
  await expect(page).toHaveURL(/\/play\/his-girl-friday-1940/);
  await expect
    .poll(() => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0), {
      timeout: 20_000,
    })
    .toBeGreaterThan(1);
  // Seeking works from the saved copy too.
  await page.evaluate(() => {
    const v = document.querySelector('video')!;
    v.currentTime = Math.max(1, (v.duration || 10) - 3);
  });
  await expect
    .poll(() => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0))
    .toBeGreaterThan(2);

  // Leaving the player offline keeps the position; back online, it's sent.
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/\/play\//);
  await context.setOffline(false);
  await page.goto('/movie/his-girl-friday-1940');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('wh-offline-progress-v1')), {
      timeout: 15_000,
    })
    .toBe('{}');
  const user = await page.evaluate(async () => {
    const r = await fetch('/api/movies/his-girl-friday-1940');
    return ((await r.json()) as { user: { lastPlayed: string } }).user;
  });
  expect(Date.now() - Date.parse(user.lastPlayed)).toBeLessThan(120_000);
});
