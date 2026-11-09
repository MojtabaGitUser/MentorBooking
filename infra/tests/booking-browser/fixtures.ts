import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const db = process.env.E2E_BOOKING_DB!;
if (!/^booking_ui_[a-f0-9]{32}$/.test(db))
  throw Error('Run npm run test:e2e:booking for an isolated database');
const base = process.env.E2E_BOOKING_API!;
const mentor = '00000000-0000-4000-8000-000000000006';
const admin = '00000000-0000-4000-8000-000000000005';
const psql = [
  'compose',
  'exec',
  '-T',
  'db',
  'psql',
  '-U',
  'mentor',
  '-d',
  db,
  '-At',
  '-v',
  'ON_ERROR_STOP=1',
  '-c',
];
const sql = (query: string) => execFileSync('docker', [...psql, query], { encoding: 'utf8' }).trim();
const path = '/mentors/' + mentor + '/book?week=2090-01-01';
const api = async (url: string, user: string, body?: unknown, key?: string) => {
  const r = await fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-User-Id': user,
      'Content-Type': 'application/json',
      ...(key && { 'Idempotency-Key': key }),
    },
    body: JSON.stringify(body),
  });
  expect(r.ok, await r.clone().text()).toBeTruthy();
  return r.json();
};
async function user(credits: number) {
  const id = randomUUID();
  sql(
    `INSERT INTO users (id,role,display_name,timezone) VALUES ('${id}','mentee','Browser fixture','America/Los_Angeles')`,
  );
  if (credits) await adjust(id, credits);
  return id;
}
const adjust = (id: string, delta: number) =>
  api('/admin/users/' + id + '/credits/adjust', admin, {
    delta,
    reason: 'Isolated booking UI test',
    idempotencyKey: randomUUID(),
  });
async function enter(page: Page, id: string, url = path) {
  await page.context().addCookies([{ name: 'mb_demo_user', value: id, url: process.env.E2E_BASE_URL! }]);
  await page.goto(url);
}

export { db, base, mentor, admin, psql, sql, path, api, user, adjust, enter };
