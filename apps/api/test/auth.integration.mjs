import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { Controller, Get, Module, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { ApiModule } from '../dist/api.module.js';
import { requireResourceAccess, Roles } from '../dist/auth/access.js';

const accounts = [
  ['01', 'mentor', 'Amelia Reed', 'Europe/London'],
  ['02', 'mentor', 'Ravi Sen', 'Asia/Kolkata'],
  ['03', 'mentee', 'Alex Chen', 'America/Vancouver'],
  ['04', 'mentee', 'Sam Rivera', 'America/New_York'],
  ['05', 'admin', 'Demo Admin', 'UTC'],
].map(([suffix, role, displayName, timezone]) =>
  ({ id: '00000000-0000-4000-8000-0000000000' + suffix, role, displayName, timezone }));
const [mentor, otherMentor, mentee, otherMentee, admin] = accounts;

// Only registered in this test application. Resource owners are server-side fixtures.
class Probe {
  mentor() { return { allowed: true }; }
  mentee() { return { allowed: true }; }
  admin() { return { allowed: true }; }
  resource(req) {
    const { action } = req.params;
    const owner = ['editAvailability', 'editBlockout'].includes(action) ? mentor : mentee;
    requireResourceAccess(req.user, action, owner.id);
    return { allowed: true };
  }
}
Controller('probe')(Probe);
for (const role of ['mentor', 'mentee', 'admin']) {
  const method = Object.getOwnPropertyDescriptor(Probe.prototype, role);
  Roles(role)(Probe.prototype, role, method);
  Get(role)(Probe.prototype, role, method);
}
Get('resource/:action')(Probe.prototype, 'resource', Object.getOwnPropertyDescriptor(Probe.prototype, 'resource'));
Req()(Probe.prototype, 'resource', 0);
class Harness {}
Module({ imports: [ApiModule], controllers: [Probe] })(Harness);

let app;
let base;
let pool;

before(async () => {
  assert.equal(process.env.DEMO_AUTH_ENABLED, 'true', 'Enable demo auth for the documented local test stack');
  app = await NestFactory.create(Harness, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  pool = app.get(pg.Pool);
});
after(async () => { await app?.close(); });

function request(path, user, extraHeaders = {}) {
  return fetch(base + path, { headers: { ...(user && { 'X-User-Id': user.id }), ...extraHeaders } });
}
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.ok(body.message);
}

test('root seed entrypoint can run twice and preserves accounts, profiles and creation timestamps', async () => {
  const ids = accounts.map(user => user.id);
  async function snapshot() {
    const users = await pool.query('SELECT id, role, display_name AS "displayName", timezone, created_at FROM users WHERE id=ANY($1) ORDER BY id', [ids]);
    const profiles = await pool.query('SELECT * FROM mentor_profiles WHERE mentor_id=ANY($1) ORDER BY mentor_id', [ids]);
    return { users: users.rows, profiles: profiles.rows };
  }
  const seed = () => execFileSync(process.execPath, ['infra/db/bootstrap.mjs', 'seed']);
  seed();
  const first = await snapshot();
  seed();
  assert.deepEqual(await snapshot(), first);
  assert.deepEqual(first.users.map(row => ({ id: row.id, role: row.role, displayName: row.displayName, timezone: row.timezone })), accounts);
  assert.deepEqual(first.profiles.map(row => row.mentor_id), [mentor.id, otherMentor.id]);
});

test('GET /me exposes only the database identity for all five accounts', async () => {
  for (const account of accounts) {
    const response = await request('/me', account, { 'X-Role': 'admin' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), account);
  }
});
test('missing, unknown, malformed and ambiguous identifiers are unauthorized', async () => {
  for (const id of [null, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'invalid', mentor.id + ',' + admin.id]) {
    await expectError(await request('/me', id && { id }), 401, 'USER_NOT_FOUND');
  }
});
test('all role-only routes enforce the stored role despite a forged role header', async () => {
  for (const role of ['mentor', 'mentee', 'admin']) {
    for (const user of [mentor, mentee, admin]) {
      const response = await request('/probe/' + role, user, { 'X-Role': role });
      if (role === user.role) assert.equal(response.status, 200);
      else await expectError(response, 403, 'FORBIDDEN');
    }
  }
});
test('only the owner can read private wallet/sessions or edit mentor scheduling resources', async () => {
  for (const [actions, owner, stranger] of [
    [['readWallet','readSessions'], mentee, otherMentee],
    [['editAvailability','editBlockout'], mentor, otherMentor],
  ]) {
    for (const action of actions) {
      const path = '/probe/resource/' + action;
      assert.equal((await request(path, owner)).status, 200);
      await expectError(await request(path + '?ownerId=' + stranger.id, stranger), 403, 'FORBIDDEN');
      await expectError(await request(path, admin), 403, 'FORBIDDEN');
    }
  }
});
test('admin may inspect another ledger; other mentees and mentors cannot', async () => {
  const path = '/probe/resource/readLedger';
  for (const user of [admin, mentee]) assert.equal((await request(path, user)).status, 200);
  for (const user of [otherMentee, mentor]) await expectError(await request(path, user), 403, 'FORBIDDEN');
});
test('disabled or unset demo authentication fails closed and health remains public', async () => {
  const original = process.env.DEMO_AUTH_ENABLED;
  try {
    for (const value of ['false', undefined]) {
      if (value === undefined) delete process.env.DEMO_AUTH_ENABLED;
      else process.env.DEMO_AUTH_ENABLED = value;
      await expectError(await request('/me', admin), 401, 'USER_NOT_FOUND');
      assert.equal((await request('/health')).status, 200);
    }
  } finally { process.env.DEMO_AUTH_ENABLED = original; }
});
