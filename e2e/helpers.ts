import { expect, type Page } from '@playwright/test';

/**
 * The sign-in page shows "Who's watching?" once people have signed in on this
 * server; tests that type a username switch to the plain form first.
 */
export async function useLoginForm(page: Page) {
  const other = page.getByRole('button', { name: 'Sign in as someone else' });
  const username = page.getByLabel('Username');
  await expect(username.or(other)).toBeVisible();
  if (await other.isVisible()) await other.click();
  await expect(username).toBeVisible();
}
