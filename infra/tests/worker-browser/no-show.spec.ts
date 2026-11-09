import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { api, db, enter, mentor, sql, user } from '../booking-browser/fixtures';

// The runner starts a separate API/database for this journey because a worker tick scans all due rows.
// Only this trusted container harness can supply the clock to the real join and worker services.
function atBoundary(sessionId: string, menteeId: string, startsAt: string) {
  const code = `
    require('reflect-metadata');
    const { NestFactory } = require('@nestjs/core');
    const { ApiModule } = require('./apps/api/dist/api.module');
    const { WorkerService } = require('./apps/api/dist/worker/worker.service');
    const { LifecycleService } = require('./apps/api/dist/sessions/lifecycle.service');
    const [sessionId, id, start] = process.argv.slice(1);
    (async () => {
      const app = await NestFactory.createApplicationContext(ApiModule, { logger: false });
      try {
        const clock = minutes => new Date(Date.parse(start) + minutes * 60000);
        await app.get(LifecycleService).join({ id, role: 'mentee' }, sessionId, clock(-5));
        const worker = app.get(WorkerService);
        const reports = [];
        for (const now of [clock(0), new Date(clock(35).getTime()-1), clock(35), clock(35)]) {
          reports.push(await worker.tick({ now }));
        }
        console.log(JSON.stringify(reports));
      } finally { await app.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
  return JSON.parse(
    execFileSync('docker', ['exec', db + '-api', 'node', '-e', code, sessionId, menteeId, startsAt], {
      encoding: 'utf8',
    }),
  ) as { started: number; resolved: number; failed: number; jobErrors: string[] }[];
}

test('worker retry after a mentor no-show leaves one 30-day rollover visible in the wallet and past sessions', async ({
  page,
}) => {
  const id = await user(1);
  const { slots } = await api('/mentors/' + mentor + '/slots?from=2090-01-01&to=2090-01-07', id);
  const { sessionId, startsAt } = await api(
    '/sessions',
    id,
    { mentorId: mentor, startsAt: slots[0].startsAt },
    randomUUID(),
  );
  await enter(page, id, '/wallet');
  await expect(page.getByTestId('spendable')).toHaveText('0');
  const reports = atBoundary(sessionId, id, startsAt);
  expect(reports.map((r) => [r.started, r.resolved, r.failed, r.jobErrors])).toEqual([
    [1, 0, 0, []],
    [0, 0, 0, []],
    [0, 1, 0, []],
    [0, 0, 0, []],
  ]);
  await page.getByRole('button', { name: 'Refresh wallet' }).click();
  await expect(page.getByTestId('spendable')).toHaveText('1');
  await expect(page.getByText('1 credit · Next to expire')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Mentor no-show award' })).toHaveCount(1);
  const wallet = await api('/wallet/me', id);
  expect(wallet.rolloverLots).toHaveLength(1);
  expect(Date.parse(wallet.rolloverLots[0].expiresAt)).toBe(
    Date.parse(startsAt) + (35 + 30 * 24 * 60) * 60000,
  );
  expect(
    sql(
      `SELECT count(*) FROM ledger_entries WHERE session_id='${sessionId}' AND kind='NO_SHOW_ROLLOVER' AND delta=1`,
    ),
  ).toBe('1');
  await page.goto('/sessions?status=past');
  await expect(page.getByText('Mentor no-show', { exact: true })).toBeVisible();
  await page.getByText('Attendance & credit details').click();
  await expect(page.getByText(/Mentor no-show award · \+1 credit/)).toBeVisible();
});
