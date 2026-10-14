import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(`a11y-${Date.now().toString(36)}`);
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main')).toBeVisible();
}

async function audit(page: Page) {
  // Let images/fades settle so contrast is measured on the final rendering.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.id}: ${v.help} → ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 4)
          .join(' | ')}`,
    );
}

test('login page has no serious accessibility violations', async ({ page }) => {
  await page.goto('/login');
  expect(await audit(page)).toEqual([]);
});

for (const path of [
  '/',
  '/browse',
  '/search',
  '/movie/charade-1963',
  '/collections',
  '/settings',
  '/rips',
]) {
  test(`${path} has no serious accessibility violations`, async ({ page }) => {
    await signIn(page);
    await page.goto(path);
    expect(await audit(page)).toEqual([]);
  });
}
