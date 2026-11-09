import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { mentor, psql, sql, path, api, user, adjust, enter } from './fixtures';
const times = (p: Page) => p.getByRole('group', { name: 'Available times' }).getByRole('button');
const shot = (p: Page, t: TestInfo, name: string) =>
  p.screenshot({ path: t.outputPath(name + '.png'), fullPage: true, animations: 'disabled' });
const confirm = (p: Page) => p.getByRole('button', { name: 'Confirm booking', exact: true });
test.use({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });

test('profile to booking, lost receipt replay, sessions, cancellation and one refund', async ({
  page,
}, info) => {
  const id = '00000000-0000-4000-8000-000000000003';
  await adjust(id, 1);
  await page.goto('/?switch=1');
  await page.getByRole('button', { name: 'Continue as Alex Chen' }).click();
  await page.getByLabel('Search').fill('Maya');
  await expect(page.getByTestId('mentor-card')).toHaveCount(1);
  await page.getByRole('link', { name: 'View profile of Maya Okafor' }).click();
  await shot(page, info, 'profile');
  await page.getByRole('link', { name: 'Book a session' }).click();
  await expect(page.getByRole('heading', { name: 'Book a session' })).toBeVisible();
  await page.goto(path);
  await expect(page.getByText('Times in America/Vancouver', { exact: true })).toBeVisible();
  await shot(page, info, 'available');
  await times(page).first().click();
  await expect(page.getByText('Estimated after booking')).toBeVisible();
  await shot(page, info, 'review');
  // The server commits, but the browser loses the response. Replay must recover the same receipt.
  await page.route('**/book?week=*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await confirm(page).click();
  const retry = page.getByRole('button', { name: 'Retry confirmation' });
  await expect(retry).toBeVisible();
  await page.unroute('**/book?week=*');
  await page.reload();
  await retry.click();
  await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toBeVisible();
  await shot(page, info, 'receipt');
  expect((await api('/wallet/me', id)).totalSpendable).toBe(0);
  expect(sql(`SELECT count(*) FROM booking_requests WHERE mentee_id='${id}'`)).toBe('1');
  await page.getByRole('link', { name: 'View my sessions' }).click();
  await expect(page.getByRole('button', { name: 'Cancel session' })).toBeVisible();
  await shot(page, info, 'upcoming');
  await page.getByRole('button', { name: 'Cancel session' }).click();
  await expect(page.getByText('1 credit refund', { exact: true })).toBeVisible();
  await shot(page, info, 'full-refund');
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText('No upcoming sessions')).toBeVisible();
  await expect(page.getByText(/1 spendable credit/)).toBeVisible();
  const [session] = (await api('/sessions/me?status=past', id)).items;
  await api('/sessions/' + session.sessionId + '/cancel', id, { expectedRefundableCredits: 1 });
  expect((await api('/wallet/me', id)).totalSpendable).toBe(1);
  await page.getByRole('link', { name: 'Past', exact: true }).click();
  await expect(page.getByText('Cancelled by you')).toBeVisible();
  await page.goto('/wallet');
  await expect(page.getByTestId('spendable')).toHaveText('1');
  await page.getByRole('link', { name: 'View transaction history' }).click();
  for (const [label, delta] of [['Session booked', '-1 credit'], ['Cancellation refund', '+1 credit']]) {
    const movement = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
    await expect(movement).toHaveCount(1);
    await expect(movement).toContainText(delta);
    await movement.getByText('Transaction details').click();
    await expect(movement).toContainText(session.sessionId);
  }
});

test('real races refresh unavailable slots and spendable credits; zero blocks confirmation', async ({
  page,
}, info) => {
  const id = await user(1),
    competitor = await user(1);
  await enter(page, id);
  const first = times(page).first();
  await first.click();
  const slot = await first.getAttribute('data-start');
  await api('/sessions', competitor, { mentorId: mentor, startsAt: slot }, randomUUID());
  await confirm(page).click();
  await expect(page.getByText(/This time slot is no longer available/)).toBeVisible();
  await expect(page.locator(`[data-start="${slot}"]`)).toHaveCount(0);
  await shot(page, info, 'conflict');
  expect((await api('/wallet/me', id)).totalSpendable).toBe(1);
  await times(page).first().click();
  await adjust(id, -1);
  await confirm(page).click();
  await expect(page.getByText(/Your available balance changed/)).toBeVisible();
  await expect(page.getByText(/You need one spendable credit before/)).toBeVisible();
  await times(page).first().click();
  await expect(confirm(page)).toBeDisabled();
  await shot(page, info, 'insufficient');
  expect((await api('/sessions/me', id)).items).toHaveLength(0);
});

test('refund changes require a second explicit confirmation; mentor cancellation and overlap are visible', async ({
  page,
}, info) => {
  const id = await user(2);
  await enter(page, id);
  await times(page).first().click();
  const start = await times(page).first().getAttribute('data-start');
  // A different mentor offers this same half hour.
  const second = '00000000-0000-4000-8000-000000000001';
  sql(`INSERT INTO weekly_availability (mentor_id,weekday,start_local,end_local)
    VALUES ('${second}',extract(isodow FROM '${start}'::timestamptz AT TIME ZONE 'Europe/London'),'00:00','23:59')`);
  const other = await api('/sessions', id, { mentorId: second, startsAt: start }, randomUUID());
  await confirm(page).click();
  await expect(page.getByText(/You already have a session/)).toBeVisible();
  await api('/mentor/sessions/' + other.sessionId + '/cancel', second, {});
  await page.goto('/sessions?status=past');
  await expect(page.getByText('Cancelled by mentor')).toBeVisible();
  const booked = await api('/sessions', id, { mentorId: mentor, startsAt: start }, randomUUID());
  await page.goto('/sessions');
  await page.getByRole('button', { name: 'Cancel session' }).click();
  await expect(page.getByText('1 credit refund', { exact: true })).toBeVisible();
  // Move this test fixture across the cutoff between preview and confirmation.
  sql(
    `UPDATE sessions SET starts_at=now()+interval '24 hours',ends_at=now()+interval '24 hours 30 minutes' WHERE id='${booked.sessionId}'`,
  );
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText(/refund outcome has changed/)).toBeVisible();
  await expect(page.getByText('0 credit refund', { exact: true })).toBeVisible();
  expect((await api('/sessions/me?status=upcoming', id)).items).toHaveLength(1);
  await shot(page, info, 'changed-preview');
  await page.setViewportSize({ width: 375, height: 812 });
  const dialog = page.getByRole('dialog');
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  await expect(dialog.getByRole('button', { name: 'Confirm cancellation' })).toBeInViewport();
  await shot(page, info, 'mobile-refund');
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText(/0 credit refunded/)).toBeVisible();
  expect((await api('/wallet/me', id)).totalSpendable).toBe(1);
});

test('empty, responsive and dark calendar views; access rules', async ({ page }, info) => {
  const id = await user(1);
  await enter(page, id, '/mentors/00000000-0000-4000-8000-000000000002/book');
  await expect(page.getByText(/No openings this week/)).toBeVisible();
  await page.goto(path);
  await page.getByRole('link', { name: 'Next week' }).click();
  await expect(page).toHaveURL(/week=2090-01-08/);
  await page.goBack();
  await expect(page).toHaveURL(/week=2090-01-01/);
  for (const width of [375, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      0,
    );
    if (width === 375) {
      await times(page).first().click();
      await shot(page, info, 'mobile');
      await page.getByTestId('theme-toggle').click();
      await shot(page, info, 'mobile-dark');
    }
  }
  await page.goto('/sessions');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.context().clearCookies();
  await page.goto(path);
  await expect(page).toHaveURL(/signin-required/);
  await enter(page, mentor, '/sessions');
  await expect(page).toHaveURL(/\/mentor$/);
});

test('loading and retry after a slot read fails', async ({ page }) => {
  const id = await user(1);
  await enter(page, id, '/sessions');
  const blocker = spawn('docker', [
    ...psql,
    `BEGIN; LOCK TABLE weekly_availability IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(1.2); COMMIT`,
  ]);
  const done = new Promise((resolve) => blocker.on('exit', resolve));
  await expect
    .poll(() =>
      sql(
        "SELECT count(*) FROM pg_locks WHERE relation='weekly_availability'::regclass AND mode='AccessExclusiveLock' AND granted",
      ),
    )
    .toBe('1');
  await page.goto(path, { waitUntil: 'commit' });
  await expect(page.getByText('Loading schedule…')).toBeAttached();
  await done;
  await expect(times(page).first()).toBeVisible();
  // Fail only a schedule read in this test database; auth and the existing user stay available.
  sql('REVOKE SELECT ON weekly_availability FROM mentor_app');
  try {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  } finally {
    sql('GRANT SELECT ON weekly_availability TO mentor_app');
  }
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(times(page).first()).toBeVisible();
});

test('Join records mentee attendance once inside the early window', async ({ page }) => {
  const id = await user(1);
  await enter(page, id);
  const startsAt = await times(page).first().getAttribute('data-start');
  const session = await api('/sessions', id, { mentorId: mentor, startsAt }, randomUUID());
  sql(
    `UPDATE sessions SET starts_at=now()+interval '4 minutes', ends_at=now()+interval '34 minutes' WHERE id='${session.sessionId}'`,
  );
  await page.goto('/sessions');
  await page.getByRole('button', { name: 'Join session' }).click();
  await expect(page.getByRole('button', { name: 'Attendance recorded' })).toBeDisabled();
  const [joined] = (await api('/sessions/me?status=upcoming', id)).items;
  expect(joined.joinedMenteeAt).toBeTruthy();
  expect(joined.status).toBe('scheduled');
});

test('switching demo accounts in another tab cannot debit the new account from a stale review', async ({ page }) => {
  const original = await user(1);
  const replacement = await user(1);
  await enter(page, original);
  await times(page).first().click();
  await page.context().addCookies([{ name: 'mb_demo_user', value: replacement, url: process.env.E2E_BASE_URL! }]);
  await confirm(page).click();
  await expect(confirm(page)).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toHaveCount(0);
  for (const id of [original, replacement]) {
    expect((await api('/wallet/me', id)).totalSpendable).toBe(1);
    expect((await api('/sessions/me', id)).items).toHaveLength(0);
  }
});
