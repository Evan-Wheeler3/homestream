import { expect, test, type Browser, type Page } from '@playwright/test';

async function enter(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  const other = page.getByRole('button', { name: 'Sign in as someone else' });
  const username = page.getByLabel('Username');
  await expect(username.or(other)).toBeVisible();
  if (await other.isVisible()) await other.click();
  await username.fill(process.env.E2E_USERNAME!);
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
  await page.goto('/theater');
  const welcome = page.getByRole('dialog', { name: 'Welcome to Wheelhouse Cinemas' });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.getByRole('button', { name: 'Let’s go' }).click();
  return { context, page };
}

async function goTo(page: Page, place: string) {
  await page.getByRole('button', { name: 'Go to…' }).click();
  await page.getByRole('button', { name: place }).click();
}

test('theater: two people in the building, one shared showing, in step', async ({
  browser,
}, info) => {
  test.skip(Boolean(process.env.CLOUD_URL), 'Uses the local test instance');
  test.setTimeout(240_000);
  const a = await enter(browser);
  const b = await enter(browser);
  // Both connected to the same building.
  await expect(a.page.getByRole('button', { name: /2 here/ })).toBeVisible({ timeout: 15_000 });
  await expect(b.page.getByRole('button', { name: /2 here/ })).toBeVisible();

  // A buys a shared ticket.
  await goTo(a.page, 'Box office');
  await a.page.getByRole('button', { name: /Buy a ticket/ }).click();
  const boxA = a.page.getByRole('dialog', { name: 'Box office' });
  await boxA.getByRole('button', { name: /Pulp Fiction/ }).click();
  await expect(boxA.getByRole('radio', { name: 'Watch together' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await boxA.getByRole('button', { name: 'Get a ticket' }).click();
  await expect(a.page.getByRole('complementary', { name: 'Your ticket' })).toContainText(
    'Theater 1',
  );

  // B sees it at the box office and joins.
  await goTo(b.page, 'Box office');
  // A (back by the doors) can see B over at the box office.
  await goTo(a.page, 'Lobby');
  await a.page.waitForTimeout(1500);
  await a.page.screenshot({ path: info.outputPath('theater-someone-else.png') });
  await b.page.getByRole('button', { name: /Buy a ticket/ }).click();
  const boxB = b.page.getByRole('dialog', { name: 'Box office' });
  await expect(boxB.getByText('Now showing together')).toBeVisible();
  await boxB.getByRole('button', { name: 'Join' }).click();
  await expect(b.page.getByRole('complementary', { name: 'Your ticket' })).toContainText(
    'Pulp Fiction',
  );

  // Both find seats and sit; the showing starts for both.
  for (const { page } of [a, b]) {
    await page
      .getByRole('complementary', { name: 'Your ticket' })
      .getByRole('button', { name: 'Find me a seat' })
      .click();
    await page.getByRole('button', { name: /Sit in seat/ }).click();
    await expect(
      page.getByRole('group', { name: 'Movie controls' }).getByRole('button', { name: 'Pause' }),
    ).toBeVisible({ timeout: 10_000 });
  }
  // A and B got different seats next to each other.
  await b.page.getByRole('button', { name: /2 here/ }).click();
  await expect(b.page.getByRole('dialog', { name: 'Who’s here' })).toContainText(
    /seated in Theater 1[\s\S]*seated in Theater 1/,
  );
  await b.page.keyboard.press('Escape');

  // A pauses: it pauses for B too. B plays: it plays for A.
  await a.page
    .getByRole('group', { name: 'Movie controls' })
    .getByRole('button', { name: 'Pause' })
    .click();
  await expect(
    b.page
      .getByRole('group', { name: 'Movie controls' })
      .getByRole('button', { name: 'Play', exact: true }),
  ).toBeVisible();
  await b.page
    .getByRole('group', { name: 'Movie controls' })
    .getByRole('button', { name: 'Play', exact: true })
    .click();
  await expect(
    a.page.getByRole('group', { name: 'Movie controls' }).getByRole('button', { name: 'Pause' }),
  ).toBeVisible();

  // Reactions reach the other person (a pop over their head; here: the message arrives).
  await b.page.getByRole('button', { name: 'Say something' }).click();
  await b.page.getByLabel('Say something').fill('Best scene!');
  await b.page.keyboard.press('Enter');
  await expect(a.page.getByRole('list', { name: 'Messages' })).toContainText('Best scene!');

  // When B leaves, A is on their own again.
  await b.context.close();
  await expect(a.page.getByRole('button', { name: /1 here/ })).toBeVisible({ timeout: 10_000 });
  await a.context.close();
});
