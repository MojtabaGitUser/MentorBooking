import { expect, test, type Page } from '@playwright/test';

// Runs against the Compose stack with the seed loaded (see README "UI tests").
const MAYA = '00000000-0000-4000-8000-000000000006';

async function signInAs(page: Page, name: string) {
  // The account picker's "switch" view, so this also works when already signed in.
  await page.goto('/?switch=1');
  await page.getByRole('button', { name: `Continue as ${name}` }).click();
  await page.waitForURL(/\/(mentors|mentor|admin)$/);
  // Interact only after hydration, as a real user would after the page settles.
  await page.waitForLoadState('networkidle');
}
// Next.js adds an empty role="alert" route announcer; match our alerts by their text.
const alert = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });
const cards = (page: Page) => page.getByTestId('mentor-card');

test.describe('mentor directory (mentee)', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'Alex Chen');
    await expect(page).toHaveURL(/\/mentors$/);
  });

  test('lists real mentors from the API with name, timezone, bio, weekly days and initials avatar', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: 'Find your mentor' })).toBeVisible();
    await expect(page.getByTestId('result-count')).toHaveText('5 mentors');
    await expect(cards(page)).toHaveCount(5);
    await expect(cards(page).getByRole('heading', { level: 2 })).toHaveText(['Amelia Reed', 'Hana Sato', 'Lucas Martins', 'Maya Okafor', 'Ravi Sen']);
    const maya = cards(page).filter({ hasText: 'Maya Okafor' });
    await expect(maya).toContainText('Lagos · GMT+1');
    await expect(maya).toContainText('Frontend developer focused on accessible');
    await expect(maya).toContainText('Mon · Wed');
    await expect(maya.locator('[aria-hidden="true"]', { hasText: 'MO' })).toBeVisible();
    await expect(cards(page).filter({ hasText: 'Amelia Reed' })).toContainText('No weekly hours yet');
    // No fabricated reputation or pricing data: the API exposes none.
    await expect(page.locator('main')).not.toContainText(/★|\(\d+ reviews?\)|\brating\b|verified|\$\d/i);
  });

  test('debounced search, timezone filter, chips and reset update the URL and results without a reload', async ({ page }) => {
    await page.evaluate(() => { (window as unknown as { marker: boolean }).marker = true; });
    await page.getByLabel('Search').fill('sql');
    await expect(page).toHaveURL(/\?q=sql$/);
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page)).toContainText('Ravi Sen');
    await expect(page.getByTestId('result-count')).toHaveText('1 mentor found');
    await page.getByLabel('Search').fill('');
    await expect(cards(page)).toHaveCount(5);
    await page.getByLabel('Timezone').selectOption('Asia/Tokyo');
    await expect(page).toHaveURL(/timezone=Asia%2FTokyo/);
    await expect(cards(page)).toHaveText([/Hana Sato/]);
    await page.getByRole('link', { name: 'Remove timezone filter' }).click();
    await expect(cards(page)).toHaveCount(5);
    await page.getByLabel('Search').fill('zzzz');
    await expect(page.getByText('No mentors match your search.')).toBeVisible();
    await expect(page.getByTestId('result-count')).toHaveText('0 mentors found');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/mentors$/);
    await expect(cards(page)).toHaveCount(5);
    await expect(page.getByLabel('Search')).toHaveValue('');
    expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true);
  });

  test('a shared URL restores the filters', async ({ page }) => {
    await page.goto('/mentors?q=code&timezone=America/Sao_Paulo');
    await expect(page.getByLabel('Search')).toHaveValue('code');
    await expect(page.getByLabel('Timezone')).toHaveValue('America/Sao_Paulo');
    await expect(cards(page)).toHaveText([/Lucas Martins/]);
  });

  test('profile shows bio, weekly hours, openings in the viewer timezone and the booking link', async ({ page }) => {
    await cards(page).filter({ hasText: 'Maya Okafor' }).getByRole('link', { name: /View profile/ }).click();
    await expect(page).toHaveURL(`/mentors/${MAYA}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Maya Okafor' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Mentors');
    await expect(page.getByTestId('mentor-bio')).toContainText('accessible, maintainable interfaces');
    await expect(page.getByRole('row', { name: /Monday/ })).toContainText('09:00–12:00');
    await expect(page.getByRole('row', { name: /Wednesday/ })).toContainText('14:00–17:00');
    const panel = page.getByTestId('booking-panel');
    await expect(panel).toContainText('shown in your timezone (Vancouver)');
    await expect(panel.getByRole('link', { name: 'Book a session' })).toHaveAttribute('href', '/mentors/'+MAYA+'/book');
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Mentors' }).click();
    await expect(page).toHaveURL(/\/mentors$/);
  });

  test('unknown and malformed mentor IDs show the not-found experience', async ({ page }) => {
    for (const id of ['00000000-0000-4000-8000-000000000099', 'not-a-mentor']) {
      await page.goto(`/mentors/${id}`);
      await expect(page.getByRole('heading', { name: "We couldn't find this mentor" })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Browse mentors' })).toBeVisible();
    }
  });

  test('mentee navigation: live booking and directory items, the rest clearly upcoming and not links', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Discover mentors', 'My sessions', 'My wallet', 'History']);
    await expect(nav.getByRole('link', { name: 'Discover mentors' })).toHaveAttribute('aria-current', 'page');
    for (const label of ['Profile']) {
      await expect(nav.locator('[aria-disabled="true"]', { hasText: label })).toContainText('Soon');
    }
  });

  test('keyboard: skip link, search field and profile link are reachable and operable', async ({ page }) => {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.getByLabel('Search').focus();
    await page.keyboard.type('Hana');
    await expect(cards(page)).toHaveCount(1);
    const profile = cards(page).getByRole('link', { name: /View profile of Hana Sato/ });
    await profile.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Hana Sato' })).toBeVisible();
  });

  test('theme toggle switches and persists across reloads', async ({ page }) => {
    const html = page.locator('html');
    const wasDark = await html.evaluate(el => el.classList.contains('dark'));
    await page.getByTestId('theme-toggle').click();
    await expect(html).toHaveClass(wasDark ? /^(?!.*dark)/ : /dark/);
    await page.reload();
    await expect(html).toHaveClass(wasDark ? /^(?!.*dark)/ : /dark/);
  });

  test('account menu offers switching and signing out', async ({ page }) => {
    await page.getByRole('button', { name: /Account menu for Alex Chen/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/');
    await page.goto('/mentors');
    await expect(page).toHaveURL(/\/\?error=signin-required/);
  });
});

test.describe('layout', () => {
  for (const width of [375, 768, 1280, 1440]) {
    test(`no horizontal overflow at ${width}px on the directory and profile`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(page, 'Alex Chen');
      for (const path of ['/mentors', `/mentors/${MAYA}`, '/mentors?q=zzzz']) {
        await page.goto(path);
        await expect(page.locator('main')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(0);
      }
    });
  }

  test('mobile drawer opens, traps focus, navigates and closes with Escape', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAs(page, 'Alex Chen');
    await expect(page.locator('#app-sidebar')).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
    await page.goto(`/mentors/${MAYA}`);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await drawer.getByRole('link', { name: 'Discover mentors' }).click();
    await expect(page).toHaveURL(/\/mentors$/);
    await expect(drawer).toBeHidden();
  });

  test('desktop sidebar collapses to icons and remembers it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInAs(page, 'Alex Chen');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.locator('[data-shell]')).toHaveAttribute('data-collapsed', 'true');
    await page.reload();
    await expect(page.locator('[data-shell]')).toHaveAttribute('data-collapsed', 'true');
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(page.locator('[data-shell]')).toHaveAttribute('data-collapsed', 'false');
  });
});

test.describe('authentication and roles', () => {
  test('signed-out visitors are sent to account selection', async ({ page }) => {
    for (const path of ['/mentors', `/mentors/${MAYA}`, '/mentor', '/admin']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/\?error=signin-required/);
      await expect(alert(page, 'Please choose a demo account')).toBeVisible();
    }
  });

  test('mentors and admins get their own navigation; the API refuses them the directory', async ({ page }) => {
    await signInAs(page, 'Amelia Reed');
    await expect(page).toHaveURL(/\/mentor$/);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Dashboard', 'My sessions', 'Availability']);
    await expect(nav).toContainText('Availability');
    await expect(nav).not.toContainText('Discover mentors');
    await page.goto('/mentors');
    await expect(alert(page, 'The mentor directory is for mentee accounts')).toContainText('FORBIDDEN');
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/mentor$/);

    await signInAs(page, 'Demo Admin');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('navigation', { name: 'Main' })).toContainText('Credit adjustments');
  });
});

// Optional: point E2E_API_DOWN_URL at a web server whose API_BASE_URL is unreachable.
test('API outage shows an actionable error, never an empty directory', async ({ page }) => {
  const url = process.env.E2E_API_DOWN_URL;
  test.skip(!url, 'Set E2E_API_DOWN_URL to run');
  const response = await page.request.get(url! + '/mentors', { headers: { cookie: 'mb_demo_user=00000000-0000-4000-8000-000000000003' } });
  const html = await response.text();
  expect(html).toContain('t reach the booking service');
  expect(html).toContain('NETWORK_ERROR');
  expect(html).not.toContain('No mentors yet');
});
