import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { api, base, db, enter, mentor, admin, user, sql, adjust } from './fixtures';

const snap = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true, animations: 'disabled' });
test.use({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });

function deliverTwice(providerId: string, event: string) {
  // Sign and deliver inside the disposable API container. The test/browser receives no secret.
  const code = `const {createHmac,randomUUID}=require('node:crypto');
    const key=process.env.WEBHOOK_SECRET||require('node:fs').readFileSync(process.env.WEBHOOK_SECRET_FILE,'utf8').trim();
    const body=JSON.stringify({eventId:randomUUID(),paymentId:process.argv[1],type:'payment.'+process.argv[2],occurredAt:new Date().toISOString()});
    const signature='sha256='+createHmac('sha256',key).update(body).digest('hex');
    (async()=>{for(let i=0;i<2;i++){const r=await fetch('http://localhost:3001/webhooks/fake-payments',{method:'POST',headers:{'content-type':'application/json','x-webhook-signature':signature},body});if(!r.ok)throw Error(await r.text())}})();`;
  execFileSync('docker', ['exec', db + '-api', 'node', '-e', code, providerId, event]);
}

test('pack stays pending until signed delivery, duplicate delivery grants once and reversal is visible', async ({
  page,
}, info) => {
  const id = await user(0);
  await enter(page, id, '/wallet');
  await expect(page.getByTestId('spendable')).toHaveText('0');
  await expect(page.getByText('No transactions yet')).toBeVisible();
  await snap(page, info, 'empty-wallet');
  await page.getByRole('button', { name: 'Buy 4 credits' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await snap(page, info, 'purchase-dialog');
  await page.getByRole('button', { name: 'Confirm purchase' }).dblclick();
  await expect(page.getByText('Pending', { exact: true })).toBeVisible();
  await expect(page.getByTestId('spendable')).toHaveText('0');
  const orders = await api('/wallet/me?include=purchases', id);
  expect(orders.purchases).toHaveLength(1);
  await page.getByText('Complete demo payment').click();
  await snap(page, info, 'pending');
  const provider = orders.purchases[0].providerPaymentId;
  deliverTwice(provider, 'succeeded');
  await page.getByRole('button', { name: 'Refresh wallet' }).click();
  await expect(page.getByTestId('spendable')).toHaveText('4');
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pack purchase' })).toHaveCount(1);
  await snap(page, info, 'completed');
  deliverTwice(provider, 'refunded');
  await page.getByRole('button', { name: 'Refresh wallet' }).click();
  await expect(page.getByTestId('spendable')).toHaveText('0');
  await expect(page.getByText('Refunded', { exact: true })).toBeVisible();
  await expect(page.getByText('-4 credits', { exact: true })).toBeVisible();
  const stranger = await user(0);
  expect((await api('/wallet/me?include=purchases&menteeId=' + id, stranger)).purchases).toHaveLength(0);
  expect((await api('/wallet/me?menteeId=' + id, stranger)).totalSpendable).toBe(0);
});

test('history paginates all ledger entries; failed reads have retry and failed purchase never grants credit', async ({
  page,
}, info) => {
  const id = await user(1);
  for (let i = 0; i < 20; i++) await adjust(id, 1);
  await enter(page, id, '/wallet/history');
  await expect(page.getByRole('heading', { name: 'Admin grant' })).toHaveCount(20);
  await snap(page, info, 'transaction-history');
  await page.getByRole('link', { name: 'Older transactions' }).click();
  await expect(page.getByRole('heading', { name: 'Admin grant' })).toHaveCount(1);
  await page.goto('/wallet/history?cursor=' + randomUUID());
  await expect(page.getByText('Error code: INVALID_PAGE')).toBeVisible();
  await page.goto('/wallet');
  await page.route('**/wallet', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  await page.getByRole('button', { name: 'Buy 4 credits' }).click();
  await page.getByRole('button', { name: 'Confirm purchase' }).click();
  await expect(page.getByText(/Purchase could not be verified/)).toBeVisible();
  expect((await api('/wallet/me?include=purchases', id)).purchases).toHaveLength(0);
  expect((await api('/wallet/me', id)).totalSpendable).toBe(21);
  await page.unroute('**/wallet');
  await page.reload();
  await page.route('**/wallet', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort();
  });
  await page.getByRole('button', { name: 'Buy 4 credits' }).click();
  await page.getByRole('button', { name: 'Confirm purchase' }).click();
  await expect(page.getByText(/Purchase could not be verified/)).toBeVisible();
  await page.reload();
  await expect(page.getByText('Pending', { exact: true })).toBeVisible();
  expect((await api('/wallet/me?include=purchases', id)).purchases).toHaveLength(1);
  await expect(page.getByTestId('spendable')).toHaveText('21');
});

test('past sessions show recorded debits, refunds and attendance awards; expiry is visible before the sweep', async ({
  page,
}, info) => {
  const id = await user(8);
  const { slots } = await api('/mentors/' + mentor + '/slots?from=2096-02-01&to=2096-02-14', id);
  const book = (index: number) =>
    api('/sessions', id, { mentorId: mentor, startsAt: slots[index].startsAt }, randomUUID());
  const first = await book(0),
    second = await book(1);
  await api('/sessions/' + first.sessionId + '/cancel', id, { expectedRefundableCredits: 1 });
  await api('/mentor/sessions/' + second.sessionId + '/cancel', mentor, {});
  // Resolve real bookings with the lifecycle service's trusted clock at fixed historical instants.
  for (const [i, outcome] of ['completed', 'no_show_mentee', 'no_show_mentor', 'no_show_mentor'].entries()) {
    const s = await book(i + 2);
    const day = '2020-02-0' + (i + 1);
    const joinedMentor = outcome === 'no_show_mentor' ? 'NULL' : 'starts_at';
    const joinedMentee = outcome === 'no_show_mentee' ? 'NULL' : 'starts_at';
    sql(`UPDATE sessions SET starts_at='${day}T10:00:00Z',ends_at='${day}T10:30:00Z' WHERE id='${s.sessionId}';
      UPDATE sessions SET joined_mentor_at=${joinedMentor},joined_mentee_at=${joinedMentee} WHERE id='${s.sessionId}'`);
    if (i === 2) {
      // Historical fixture: the lot and original grant predate their expiry. No sweep entry exists yet.
      const lot = randomUUID();
      sql(`BEGIN;
        UPDATE sessions SET status='no_show_mentor' WHERE id='${s.sessionId}';
        INSERT INTO credit_lots(id,mentee_id,session_id,credit_type,original_quantity,created_at,expires_at)
          VALUES ('${lot}','${id}','${s.sessionId}','ROLLOVER',1,'2020-02-03T10:36Z','2020-03-04T10:36Z');
        INSERT INTO ledger_entries(mentee_id,lot_id,session_id,kind,delta,created_at,idempotency_key)
          VALUES ('${id}','${lot}','${s.sessionId}','NO_SHOW_ROLLOVER',1,'2020-02-03T10:36Z','mentor-no-show:${s.sessionId}');
        COMMIT`);
      continue;
    }
    const code = `require('reflect-metadata');const {NestFactory}=require('@nestjs/core'),{ApiModule}=require('./apps/api/dist/api.module'),
      {LifecycleService}=require('./apps/api/dist/sessions/lifecycle.service');(async()=>{const app=await NestFactory.createApplicationContext(ApiModule,{logger:false});
      try {await app.get(LifecycleService).resolveSession(process.argv[1],new Date(process.argv[2]))}finally{await app.close()}})()`;
    execFileSync('docker', [
      'exec',
      db + '-api',
      'node',
      '-e',
      code,
      s.sessionId,
      i === 3 ? new Date().toISOString() : day + 'T10:36:00Z',
    ]);
  }
  await enter(page, id, '/sessions?status=past');
  for (const status of [
    'Completed',
    'Mentee no-show',
    'Mentor no-show',
    'Cancelled by mentor',
    'Cancelled by you',
  ])
    await expect(page.getByText(status, { exact: true }).first()).toBeVisible();
  for (const summary of await page.getByText('Attendance & credit details', { exact: true }).all())
    await summary.click();
  for (const label of [
    'Session booked',
    'Cancellation refund',
    'Mentor cancellation refund',
    'Mentor no-show award',
    'No refund or rollover award recorded',
  ])
    await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
  await snap(page, info, 'session-history');
  await page.goto('/wallet');
  await expect(page.getByTestId('spendable')).toHaveText('5');
  await expect(page.getByText('1 credit · Next to expire')).toBeVisible();
  await expect(page.getByText(/Last expired rollover lot/)).toBeVisible();
  await snap(page, info, 'mixed-wallet');
  for (const width of [375, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      0,
    );
    if (width === 375) {
      await snap(page, info, 'mobile-wallet');
      await page.getByTestId('theme-toggle').click();
      await snap(page, info, 'dark-wallet');
      await page.getByRole('button', { name: 'Buy 4 credits' }).click();
      await expect(page.getByRole('button', { name: 'Confirm purchase' })).toBeInViewport();
      await page.keyboard.press('Escape');
    }
    for (const path of ['/wallet/history', '/sessions?status=past', '/wallet']) {
      await page.goto(path);
      const heading = path === '/wallet' ? 'My wallet' : path.includes('sessions') ? 'My sessions' : 'Transaction history';
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      for (const theme of ['light', 'dark']) {
        if (
          (await page.locator('html').getAttribute('class'))?.split(' ').includes('dark') !==
          (theme === 'dark')
        )
          await page.getByTestId('theme-toggle').click();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        const view = path === '/wallet' ? 'overview' : path.includes('sessions') ? 'sessions' : 'ledger';
        await page.screenshot({
          path: info.outputPath(view + '-' + width + '-' + theme + '.png'),
          animations: 'disabled',
        });
      }
    }
  }
});
test('wallet and history enforce account and role boundaries', async ({ page }) => {
  await page.goto('/wallet');
  await expect(page).toHaveURL(/signin-required/);
  for (const [id, home] of [
    [mentor, '/mentor'],
    [admin, '/admin'],
  ]) {
    await enter(page, id, '/wallet/history');
    await expect(page).toHaveURL(new RegExp(home + '$'));
    const r = await fetch(base + '/wallet/me?include=purchases', { headers: { 'X-User-Id': id } });
    expect(r.status).toBe(403);
  }
});
