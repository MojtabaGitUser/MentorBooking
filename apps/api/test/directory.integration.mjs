import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID as uuid } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createApp } from '../dist/create-app.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

const database = 'directory_test_' + uuid().replaceAll('-', '');
const owner = new pg.Client({ ...connectionOptions(), database: 'postgres' });
const MENTEE = '00000000-0000-4000-8000-000000000003';
const MENTOR = '00000000-0000-4000-8000-000000000001';
const ADMIN = '00000000-0000-4000-8000-000000000005';
const SEEDED = ['Amelia Reed', 'Hana Sato', 'Lucas Martins', 'Maya Okafor', 'Ravi Sen'];
let app, base, pool, created;

before(async () => {
  assert.ok(!process.env.DATABASE_URL, 'Use the bundled PostgreSQL server for directory tests');
  await owner.connect();
  await owner.query('CREATE DATABASE ' + database);
  created = true;
  process.env.PGDATABASE = database;
  execFileSync(process.execPath, ['infra/db/bootstrap.mjs', 'migrate']);
  process.env.PGUSER = 'mentor_app';
  process.env.DB_PASSWORD_FILE = process.env.RUNTIME_PASSWORD_FILE;
  process.env.DEMO_AUTH_ENABLED = 'true';
  execFileSync(process.execPath, ['infra/db/bootstrap.mjs', 'seed']);
  app = await createApp();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  pool = app.get(pg.Pool);
});
after(async () => {
  try {
    await app?.close();
    if (created) await owner.query('DROP DATABASE ' + database);
  } finally { await owner.end(); }
});

async function get(path, user = MENTEE) {
  const response = await fetch(base + path, { headers: user ? { 'X-User-Id': user } : {} });
  return { status: response.status, data: await response.json() };
}

test('seed is repeatable and the directory lists every mentor in a stable name order with public fields only', async () => {
  execFileSync(process.execPath, ['infra/db/bootstrap.mjs', 'seed']);
  const { status, data } = await get('/mentors');
  assert.equal(status, 200);
  assert.deepEqual(data.items.map(m => m.displayName), SEEDED);
  assert.equal(data.total, 5);
  for (const mentor of data.items) {
    assert.deepEqual(Object.keys(mentor).sort(), ['availableWeekdays', 'bio', 'displayName', 'id', 'timezone']);
  }
  const maya = data.items.find(m => m.displayName === 'Maya Okafor');
  assert.deepEqual([maya.timezone, maya.availableWeekdays], ['Africa/Lagos', [1, 3]]);
  assert.deepEqual(data.items.find(m => m.id === MENTOR).availableWeekdays, []);
  assert.deepEqual(data.facets.timezones.map(f => f.timezone), ['Africa/Lagos', 'America/Sao_Paulo', 'Asia/Kolkata', 'Asia/Tokyo', 'Europe/London']);
  assert.deepEqual(data.filters, { q: null, timezone: null });
  assert.deepEqual((await get('/mentors')).data, data, 'deterministic');
});

test('server-side search matches name or bio, case-insensitively, with LIKE characters taken literally', async () => {
  assert.deepEqual((await get('/mentors?q=maya')).data.items.map(m => m.displayName), ['Maya Okafor']);
  assert.deepEqual((await get('/mentors?q=SQL')).data.items.map(m => m.displayName), ['Ravi Sen']);
  assert.deepEqual((await get('/mentors?q=%20%20code%20%20')).data.items.map(m => m.displayName).sort(), ['Amelia Reed', 'Lucas Martins']);
  const none = await get('/mentors?q=%25');
  assert.deepEqual([none.status, none.data.total, none.data.facets.timezones.length], [200, 0, 5], 'facets still describe the whole directory');
  assert.equal((await get('/mentors?q=_')).data.total, 0);
});

test('timezone filter is exact and combines with search; invalid parameters are rejected', async () => {
  assert.deepEqual((await get('/mentors?timezone=Asia/Tokyo')).data.items.map(m => m.displayName), ['Hana Sato']);
  assert.equal((await get('/mentors?timezone=Asia/Tokyo&q=maya')).data.total, 0);
  assert.equal((await get('/mentors?timezone=Europe/Paris')).data.total, 0);
  for (const query of ['timezone=Mars/Base', 'timezone=%2B05:30', 'q=' + 'x'.repeat(101), 'sort=rating', 'q=a&q=b']) {
    const result = await get('/mentors?' + query);
    assert.deepEqual([result.status, result.data.code], [422, 'INVALID_DIRECTORY_QUERY'], query);
  }
});

test('profile returns public details and weekly availability; unknown and malformed IDs are 404', async () => {
  const lucas = (await get('/mentors?q=Lucas')).data.items[0];
  const { status, data } = await get('/mentors/' + lucas.id);
  assert.equal(status, 200);
  assert.deepEqual(data, { id: lucas.id, displayName: 'Lucas Martins', timezone: 'America/Sao_Paulo', bio: lucas.bio,
    availableWeekdays: [2, 4], weeklyAvailability: [{ weekday: 2, startLocal: '18:00', endLocal: '21:00' },
      { weekday: 4, startLocal: '18:00', endLocal: '21:00' }] });
  await pool.query("UPDATE weekly_availability SET is_active=false WHERE mentor_id=$1 AND weekday=4", [lucas.id]);
  assert.deepEqual((await get('/mentors/' + lucas.id)).data.availableWeekdays, [2]);
  for (const id of [uuid(), 'not-an-id', MENTEE]) {
    const result = await get('/mentors/' + id);
    assert.deepEqual([result.status, result.data.code], [404, 'MENTOR_NOT_FOUND'], id);
  }
});

test('the directory is for authenticated mentees; mentors, admins and anonymous callers are refused', async () => {
  for (const [user, status] of [[MENTOR, 403], [ADMIN, 403], [null, 401]]) {
    assert.equal((await get('/mentors', user)).status, status);
    assert.equal((await get('/mentors/' + MENTOR, user)).status, status);
  }
});

test('mentor content is returned as data, never interpreted', async () => {
  const id = uuid();
  await pool.query("INSERT INTO users (id,role,display_name,timezone) VALUES ($1,'mentor','<img src=x onerror=alert(1)>','UTC')", [id]);
  await pool.query("INSERT INTO mentor_profiles (mentor_id,bio) VALUES ($1,'<script>alert(1)</script>')", [id]);
  const { data } = await get('/mentors/' + id);
  assert.deepEqual([data.displayName, data.bio], ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>']);
});
