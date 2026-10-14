import { useLoginForm } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The e2e server runs disc ripping against stand-in MakeMKV/HandBrake tools
// (e2e/fixtures/bin). "Inserting" a disc = creating a VIDEO_TS folder.

test('inserting a disc: progress, confirm the name, ready to watch', async ({ page }) => {
  const volumes = process.env.WH_E2E_VOLUMES!;
  await page.goto('/login');
  await useLoginForm(page);
  await page.getByLabel('Username').fill(`discs-${Date.now().toString(36)}`);
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main')).toBeVisible();

  await page.getByRole('link', { name: 'Discs' }).click();
  await expect(page.getByRole('heading', { name: 'Discs', level: 1 })).toBeVisible();

  // A different disc each run: a second copy of the same movie is (rightly) refused.
  const letters = Array.from({ length: 6 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  );
  const label = `TEST_FILM_${letters.join('').toUpperCase()}`;
  fs.mkdirSync(path.join(volumes, label, 'VIDEO_TS'), { recursive: true });
  const card = page.getByRole('listitem').filter({ hasText: label });
  await expect(card).toBeVisible({ timeout: 15_000 });
  // Without a Jellyfin API key (sample mode) the name is confirmed by hand.
  await expect(card.getByText('Needs you: confirm the name')).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: /^Use “Test Film/ }).click();
  await expect(card.getByText('Ready to watch')).toBeVisible({ timeout: 15_000 });

  // The disc is not ripped a second time while it is still in the drive.
  await page.waitForTimeout(2500);
  await expect(page.getByRole('listitem').filter({ hasText: label })).toHaveCount(1);
  fs.rmSync(path.join(volumes, label), { recursive: true, force: true });

  await card.getByRole('button', { name: 'Clear' }).click();
  await expect(card).toHaveCount(0);
});
