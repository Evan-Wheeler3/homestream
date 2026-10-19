import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

test('download an episode from the cloud and find it under Downloads', async ({ page }) => {
  test.skip(
    Boolean(process.env.CLOUD_URL),
    'Changes downloads on this device only, but keep it local',
  );
  await page.goto('/login');
  const other = page.getByRole('button', { name: 'Sign in as someone else' });
  const username = page.getByLabel('Username');
  await expect(username.or(other)).toBeVisible();
  if (await other.isVisible()) await other.click();
  await username.fill(process.env.E2E_USERNAME!);
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  await page.goto('/show/tmdbtv-e2e');
  await page
    .getByRole('button', { name: /^Download Test Show · S1/ })
    .first()
    .click();
  await expect(page.getByText('Pilot is ready to watch offline')).toBeVisible({ timeout: 30_000 });
  await page.goto('/downloads');
  const item = page.locator('.download', { hasText: 'Pilot' });
  await expect(item).toContainText('Test Show');
  await expect(item.getByRole('link', { name: 'Play' })).toHaveAttribute(
    'href',
    '/play/episode/tmdbtv-e2e-s01e01',
  );
  // The saved video is served from the device, with seeking.
  const ranged = await page.evaluate(async () => {
    const list = JSON.parse(localStorage.getItem('wh-downloads-v1') ?? '[]') as {
      playback: { url: string };
    }[];
    const r = await fetch(list[0]!.playback.url, { headers: { Range: 'bytes=0-99' } });
    return { status: r.status, length: (await r.arrayBuffer()).byteLength };
  });
  expect(ranged).toEqual({ status: 206, length: 100 });
});
