import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { admin, mentor, base, api, user, sql, enter, adjust } from './fixtures';
const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: info.outputPath(name + '.png'), animations: 'disabled' });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
test.use({ timezoneId: 'Asia/Kolkata' });
test('mentor schedule changes slots, handles conflicts, joins early and refunds on cancellation', async ({
  page,
}, info) => {
  test.setTimeout(65000);
  const owner = randomUUID(),
    mentee = await user(1);
  sql(`INSERT INTO users(id,role,display_name,timezone) VALUES ('${owner}','mentor','Dashboard mentor','Europe/London');
 INSERT INTO mentor_profiles(mentor_id,bio) VALUES ('${owner}','Test mentor')`);
  const day = '2090-01-02',
    dayName = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(day));
  const slots = async () =>
    (await api('/mentors/' + owner + '/slots?from=' + day + '&to=' + day, mentee)).slots;
  await enter(page, owner, '/mentor');
  await expect(page.getByRole('heading', { name: 'Mentor dashboard' })).toBeVisible();
  await shot(page, info, 'mentor-home');
  await page.getByRole('link', { name: 'Manage availability' }).click();
  const section = page.getByRole('region', { name: dayName, exact: true }),
    dlg = page.getByRole('dialog');
  await section.getByRole('button', { name: 'Add window' }).click();
  await dlg.getByLabel('Start time').fill('09:00');
  await dlg.getByLabel('End time').fill('10:00');
  await shot(page, info, 'weekly-editor');
  await button(page, 'Save window').click();
  await expect(dlg).toHaveCount(0);
  expect(await slots()).toHaveLength(2);
  await section.getByRole('button', { name: 'Edit' }).click();
  await dlg.getByLabel('End time').fill('11:00');
  await button(page, 'Save window').click();
  await expect(dlg).toHaveCount(0);
  expect(await slots()).toHaveLength(4);
  await section.getByRole('button', { name: 'Add window' }).click();
  await dlg.getByLabel('Start time').fill('09:30');
  await dlg.getByLabel('End time').fill('10:30');
  await button(page, 'Save window').click();
  await expect(dlg.getByRole('alert')).toContainText('overlap');
  await button(page, 'Back').click();
  const session = await api(
    '/sessions',
    mentee,
    { mentorId: owner, startsAt: (await slots())[0].startsAt },
    randomUUID(),
  );
  expect(
    (await api('/mentor/sessions?status=upcoming', mentor)).items.map(
      (s: { sessionId: string }) => s.sessionId,
    ),
  ).not.toContain(session.sessionId);
  await button(page, 'Add blockout').click();
  await dlg.getByLabel('Start with offset').fill(day + 'T10:05Z');
  await dlg.getByLabel('End with offset').fill(day + 'T10:15Z');
  await dlg.getByLabel('Reason (optional)').fill('Office closed');
  await shot(page, info, 'blockout-editor');
  await button(page, 'Save blockout').click();
  await expect(dlg).toHaveCount(0);
  expect(await slots()).toHaveLength(2);
  const original = (await api('/mentor/blockouts', owner))[0];
  const blocks = page.locator('#blockouts');
  await blocks.getByRole('button', { name: 'Edit' }).click();
  await dlg.getByLabel('Start with offset').fill(day + 'T09:05Z');
  await button(page, 'Save blockout').click();
  await expect(dlg.getByRole('alert')).toContainText('BLOCKOUT_CONFLICT');
  await shot(page, info, 'blockout-conflict');
  await dlg.getByLabel('Start with offset').fill(day + 'T10:30Z');
  await dlg.getByLabel('End with offset').fill(day + 'T11:00Z');
  await dlg.getByLabel('Reason (optional)').fill('Updated');
  await button(page, 'Save blockout').click();
  await expect(dlg).toHaveCount(0);
  const [edited] = await api('/mentor/blockouts', owner);
  expect(edited.id).toBe(original.id);
  expect(edited.reason).toBe('Updated');
  expect(edited.startsAt).toContain('10:30');
  expect(edited.endsAt).toContain('11:00');
  await blocks.getByRole('button', { name: 'Delete' }).click();
  await button(page, 'Confirm deletion').click();
  await expect(dlg).toHaveCount(0);
  expect(await slots()).toHaveLength(3);
  await section.getByRole('button', { name: 'Delete' }).click();
  await button(page, 'Confirm deletion').click();
  await expect(dlg).toHaveCount(0);
  expect(await slots()).toHaveLength(0);
  sql(
    `UPDATE sessions SET starts_at=now()+interval '4 minutes',ends_at=now()+interval '34 minutes' WHERE id='${session.sessionId}'`,
  );
  await page.goto('/mentor/sessions');
  await button(page, 'Join session').click();
  await expect(button(page, 'Attendance recorded')).toBeDisabled();
  const [joined] = (await api('/mentor/sessions?status=upcoming', owner)).items;
  expect(joined.status).toBe('scheduled');
  expect(joined.joinedMentorAt).toBeTruthy();
  await shot(page, info, 'mentor-sessions');
  await button(page, 'Cancel session').click();
  await expect(dlg).toContainText('full one-credit refund');
  await shot(page, info, 'mentor-cancel');
  await button(page, 'Confirm cancellation').click();
  await expect(page.getByText('No upcoming sessions')).toBeVisible();
  expect((await api('/wallet/me', mentee)).totalSpendable).toBe(1);
  expect(sql(`SELECT count(*) FROM outbox_events WHERE event_key='mentor-cancelled:${session.sessionId}' AND type='MENTOR_CANCELLED'`)).toBe('1');
  await page.getByRole('link', { name: 'Past', exact: true }).click();
  await expect(page.getByText('Cancelled by mentor')).toBeVisible();
  await expect(button(page, 'Cancel session')).toHaveCount(0);
});
test('admin lookup, audit, validation, confirmed grants and safe replay after response loss', async ({
  page,
}, info) => {
  test.setTimeout(65000);
  const target = await user(0);
  await enter(page, admin, '/admin');
  await expect(page.getByRole('heading', { name: 'Admin dashboard' })).toBeVisible();
  await shot(page, info, 'admin-lookup');
  await page.getByLabel('Name or user ID').fill(target);
  await button(page, 'Search users').click();
  await page.getByRole('link', { name: new RegExp(target) }).click();
  const reason = page.getByLabel('Adjustment reason'),
    quantity = page.getByLabel('Quantity'),
    review = button(page, 'Review adjustment'),
    confirm = button(page, 'Confirm adjustment');
  await reason.fill(' ');
  await review.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Enter a reason');
  await reason.fill('Dashboard correction');
  await quantity.fill('0');
  await review.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await quantity.fill('3');
  await review.click();
  await shot(page, info, 'adjustment-review');
  await confirm.dblclick();
  await expect(page.getByText('3 spendable credits')).toBeVisible();
  await expect(page.getByText('Adjustment confirmed')).toBeVisible();
  await shot(page, info, 'admin-receipt');
  await page.getByText('Transaction details').click();
  await expect(page.getByText(admin, { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('revoke');
  await reason.fill('Return two');
  await quantity.fill('2');
  await review.click();
  await confirm.click();
  await expect(page.getByText('1 spendable credit')).toBeVisible();
  await reason.fill('Too many');
  await review.click();
  await confirm.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('INSUFFICIENT_CREDITS');
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('grant');
  await reason.fill('Restore after interruption');
  await review.click();
  await page.route('**/admin?*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort();
  });
  await confirm.click();
  await expect(button(page, 'Retry saved adjustment')).toBeVisible();
  const saved = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('credit-adjustment:'))!;
    return { key, request: JSON.parse(sessionStorage.getItem(key)!) };
  });
  await page.unroute('**/admin?*');
  await page.reload();
  await button(page, 'Retry saved adjustment').click();
  await expect(page.getByText('Adjustment confirmed')).toBeVisible();
  await expect(page.getByText('3 spendable credits')).toBeVisible();
  expect(
    sql(
      `SELECT count(*) FROM credit_adjustments WHERE mentee_id='${target}' AND reason='Restore after interruption'`,
    ),
  ).toBe('1');
  // Simulate a stale, conflicting saved intent. The real API must reject its reused key.
  await page.evaluate(
    ({ key, request }) => sessionStorage.setItem(key, JSON.stringify({ ...request, delta: 99 })),
    saved,
  );
  await page.reload();
  await button(page, 'Retry saved adjustment').click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('IDEMPOTENCY_CONFLICT');
  expect((await api('/wallet/me', target)).totalSpendable).toBe(3);
  for (let i = 0; i < 19; i++) await adjust(target, 1);
  await page.reload();
  await page.getByRole('link', { name: 'Older transactions' }).click();
  await expect(page.getByRole('link', { name: 'Latest transactions' })).toBeVisible();
  await shot(page, info, 'admin-ledger');
  await page.goto('/admin?user=' + mentor);
  await expect(page.getByText('Only mentees hold credits.')).toBeVisible();
  await expect(review).toHaveCount(0);
  await page.goto('/admin?user=' + randomUUID());
  await expect(page.getByText(/TARGET_USER_NOT_FOUND/)).toBeVisible();
});
test('dashboard role boundaries and responsive themes', async ({ page }, info) => {
  const id = await user(0);
  const lookup = await api('/admin/users?q=' + id, admin);
  expect(lookup.items).toHaveLength(1);
  expect(Object.keys(lookup.items[0]).sort()).toEqual(['displayName', 'id', 'role']);
  expect(lookup.items[0].id).toBe(id);
  for (const [actor, path, home] of [
    [id, '/mentor/availability', '/mentors'],
    [mentor, '/admin/ledger', '/mentor'],
    [admin, '/mentor/sessions', '/admin'],
  ]) {
    await enter(page, actor, path);
    await expect(page).toHaveURL(new RegExp(home + '$'));
  }
  for (const [actor, path] of [
    [id, '/admin/users'],
    [mentor, '/admin/users'],
    [id, '/mentor/sessions'],
    [id, '/mentor/availability'],
    [id, '/admin/users/' + id + '/ledger'],
  ]) {
    const r = await fetch(base + path, { headers: { 'X-User-Id': actor } });
    expect(r.status).toBe(403);
  }
  for (const [actor, path, heading] of [
    [mentor, '/mentor/availability', 'Weekly availability'],
    [admin, '/admin?user=' + id, 'Credit ledger'],
  ]) {
    await enter(page, actor, path);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    for (const width of [375, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 850 });
      for (const dark of [false, true]) {
        if ((await page.locator('html').evaluate((e) => e.classList.contains('dark'))) !== dark)
          await page.getByTestId('theme-toggle').click();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(0);
        await shot(
          page,
          info,
          (actor === mentor ? 'mentor' : 'admin') + '-' + width + '-' + (dark ? 'dark' : 'light'),
        );
      }
    }
  }
});
