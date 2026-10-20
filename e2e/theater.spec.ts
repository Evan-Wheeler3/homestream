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
  test.setTimeout(90_000);
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
  const heading = await page.getByRole('heading', { level: 1 }).innerText();
  await page.getByRole('link', { name: 'In the theater' }).click();
  const box = page.getByRole('dialog', { name: 'Box office' });
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(box.locator('.boxoffice__title')).toContainText(heading.split('\n')[0]!);
});

test('theater on a phone: a thumbstick walks you around @phone', async ({ page }, info) => {
  test.setTimeout(90_000);
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
});
