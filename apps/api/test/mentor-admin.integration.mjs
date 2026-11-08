import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID as uuid } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/create-app.js';
import { LedgerService } from '../dist/wallet/ledger.service.js';
import { WalletService } from '../dist/wallet/wallet.service.js';
import { BookingService } from '../dist/sessions/booking.service.js';
import { MentorCancellationService } from '../dist/sessions/mentor-cancellation.service.js';
import { AdminService } from '../dist/admin/admin.service.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

const database = 'mentor_admin_test_' + uuid().replaceAll('-', '');
const owner = new pg.Client({ ...connectionOptions(), database: 'postgres' });
const ADMIN = '00000000-0000-4000-8000-000000000005';
const SEEDED_MENTOR = '00000000-0000-4000-8000-000000000001';
const H = 3_600_000;
const START = '2030-06-03T10:00:00Z';
const at = offset => new Date(Date.parse(START) + offset);
let app, base, pool, ledger, bookings, mentorCancels, admins, created;

before(async () => {
  assert.ok(!process.env.DATABASE_URL, 'Use the bundled PostgreSQL server for these tests');
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
  ledger = app.get(LedgerService);
  bookings = app.get(BookingService);
  mentorCancels = app.get(MentorCancellationService);
  admins = app.get(AdminService);
});
after(async () => {
  try {
    await app?.close();
    if (created) await owner.query('DROP DATABASE ' + database);
  } finally { await owner.end(); }
});

// ---------- fixtures ----------
async function user(role, timezone = 'UTC') {
  const id = uuid();
  await pool.query('INSERT INTO users (id,role,display_name,timezone) VALUES ($1,$2,$3,$4)', [id, role, role, timezone]);
  if (role === 'mentor') {
    await pool.query('INSERT INTO mentor_profiles (mentor_id) VALUES ($1)', [id]);
    for (let weekday = 1; weekday <= 7; weekday++) {
      await pool.query("INSERT INTO weekly_availability (mentor_id,weekday,start_local,end_local) VALUES ($1,$2,'00:00','23:30')", [id, weekday]);
    }
  }
  return id;
}
async function tx(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function purchase(menteeId, credits) {
  const paymentId = uuid();
  await pool.query("INSERT INTO payments (id,mentee_id,provider_payment_id,credits_purchased,status) VALUES ($1,$2,$3,$4,'SUCCEEDED')",
    [paymentId, menteeId, 'fake_' + uuid(), credits]);
  const { rows: [lot] } = await pool.query(`INSERT INTO credit_lots (mentee_id,credit_type,original_quantity,payment_id)
    VALUES ($1,'NORMAL',$2,$3) RETURNING id`, [menteeId, credits, paymentId]);
  await tx(client => ledger.appendEntry(client, { menteeId, lotId: lot.id, paymentId, kind: 'PURCHASE_GRANT',
    delta: credits, idempotencyKey: 'purchase-grant:' + paymentId }));
  return { lotId: lot.id, paymentId };
}
let historic = 0;
async function rollover(menteeId, expiresAt) {
  const sessionId = uuid();
  const old = new Date(Date.UTC(2001, 0, 1) + (historic++) * H).toISOString();
  await pool.query(`INSERT INTO sessions (id,mentor_id,mentee_id,starts_at,ends_at,status,cancellation_actor,cancelled_at)
    VALUES ($1,$2,$3,$4,$4::timestamptz+interval '30 minutes','cancelled',$2,$4)`, [sessionId, SEEDED_MENTOR, menteeId, old]);
  const { rows: [lot] } = await pool.query(`INSERT INTO credit_lots (mentee_id,credit_type,original_quantity,session_id,expires_at)
    VALUES ($1,'ROLLOVER',1,$2,$3) RETURNING id`, [menteeId, sessionId, expiresAt]);
  await tx(client => ledger.appendEntry(client, { menteeId, lotId: lot.id, sessionId, kind: 'NO_SHOW_ROLLOVER',
    delta: 1, idempotencyKey: 'no-show-rollover:' + sessionId }));
  return lot.id;
}
async function mentee(credits = 1) {
  const id = await user('mentee', 'America/Vancouver');
  const lotId = credits ? (await purchase(id, credits)).lotId : null;
  return { id, lotId };
}
async function booked({ credits = 1, menteeId, bookedAt } = {}) {
  const mentorId = await user('mentor');
  let lotId = null;
  if (!menteeId) ({ id: menteeId, lotId } = await mentee(credits));
  const { booking } = await bookings.book(menteeId, { mentorId, startsAt: START }, undefined, bookedAt);
  return { mentorId, menteeId, lotId, sessionId: booking.sessionId };
}

// ---------- helpers ----------
async function http(method, path, userId, body) {
  const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(userId && { 'X-User-Id': userId }) } });
  return { status: response.status, data: await response.json() };
}
const mentorCancel = (s, by = s.mentorId, body) => http('POST', `/mentor/sessions/${s.sessionId}/cancel`, by, body);
const menteeCancel = (s, expected) => http('POST', `/sessions/${s.sessionId}/cancel`, s.menteeId, { expectedRefundableCredits: expected });
const adjust = (menteeId, body, by = ADMIN) => http('POST', `/admin/users/${menteeId}/credits/adjust`, by, body);
const mentorUser = id => ({ id, role: 'mentor', displayName: 'Mentor', timezone: 'UTC' });
const wallet = async id => (await app.get(WalletService).getWallet(id)).totalSpendable;
async function sessionRow(id) {
  return (await pool.query('SELECT status, cancelled_at, cancellation_actor FROM sessions WHERE id=$1', [id])).rows[0];
}
async function ledgerRows(menteeId) {
  return (await pool.query(`SELECT id, kind, delta, lot_id, session_id, adjustment_id, reason, idempotency_key, created_at
    FROM ledger_entries WHERE mentee_id=$1 ORDER BY created_at, id`, [menteeId])).rows;
}
async function effects(sessionId) {
  const { rows: [row] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM ledger_entries WHERE session_id=$1 AND kind='MENTOR_REFUND') AS "mentorRefunds",
    (SELECT count(*)::int FROM ledger_entries WHERE session_id=$1 AND kind='CANCELLATION_REFUND') AS "menteeRefunds",
    (SELECT count(*)::int FROM outbox_events WHERE event_key='mentor-cancelled:'||$1) AS outbox`, [sessionId]);
  return row;
}
async function waitForLockWaiters(count) {
  for (let i = 0; ; i++) {
    const { rows: [{ waiting }] } = await owner.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname=$1 AND wait_event_type='Lock'`, [database]);
    if (waiting >= count) return;
    if (i > 400) throw Error(`only ${waiting}/${count} transactions reached the lock`);
    await delay(10);
  }
}
async function barrier(lockSql, args, requests) {
  const holder = new pg.Client(connectionOptions());
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(lockSql, args);
    const pending = requests.map(request => request());
    await waitForLockWaiters(requests.length);
    await holder.query('COMMIT');
    return await Promise.all(pending);
  } finally { await holder.end(); }
}
function attempts(t, service) {
  const original = service.attempt.bind(service);
  const spy = t.mock.method(service, 'attempt', (...args) => original(...args));
  return () => spy.mock.callCount();
}
const lockMentee = 'SELECT 1 FROM users WHERE id=$1 FOR UPDATE';

// ================= mentor cancellation =================
test('mentor cancels a scheduled session: full MENTOR_REFUND to the original lot and one pending outbox event', async () => {
  const s = await booked();
  const before = await ledgerRows(s.menteeId);
  const result = await mentorCancel(s, s.mentorId, { reason: 'Conference travel' });
  assert.equal(result.status, 200);
  assert.deepEqual({ ...result.data, cancelledAt: undefined }, { sessionId: s.sessionId, status: 'cancelled', cancelledAt: undefined,
    cancelledBy: 'mentor', previousStatus: 'scheduled', alreadyCancelled: false,
    refund: { credits: 1, creditType: 'NORMAL', lotId: s.lotId }, notification: { eventKey: 'mentor-cancelled:' + s.sessionId } });
  const row = await sessionRow(s.sessionId);
  assert.deepEqual([row.status, row.cancellation_actor, row.cancelled_at.toISOString()], ['cancelled', s.mentorId, result.data.cancelledAt]);
  const after = await ledgerRows(s.menteeId);
  assert.deepEqual(after.slice(0, before.length), before);
  const [refund] = after.slice(before.length);
  assert.deepEqual([refund.kind, refund.delta, refund.lot_id, refund.idempotency_key], ['MENTOR_REFUND', 1, s.lotId, 'mentor-refund:' + s.sessionId]);
  assert.match(refund.reason, /Mentor reason: Conference travel/);
  const { rows: [event] } = await pool.query('SELECT * FROM outbox_events WHERE event_key=$1', ['mentor-cancelled:' + s.sessionId]);
  assert.deepEqual([event.type, event.processed_at, event.attempts], ['MENTOR_CANCELLED', null, 0]);
  assert.deepEqual({ ...event.payload, cancelledAt: undefined }, { recipientId: s.menteeId, sessionId: s.sessionId, mentorId: s.mentorId,
    startsAt: START, cancelledAt: undefined, previousStatus: 'scheduled', reason: 'Conference travel',
    refund: { credits: 1, creditType: 'NORMAL', lotId: s.lotId } });
  assert.equal(await wallet(s.menteeId), 1);
});

test('no 24-hour rule: within 24h, after an early join, and while in progress after start all refund fully', async () => {
  const cases = [
    ['within 24h', -1 * H, async () => {}],
    ['5 minutes before start after early joins', -4 * 60_000, s => pool.query(
      'UPDATE sessions SET joined_mentee_at=$2, joined_mentor_at=$2 WHERE id=$1', [s.sessionId, at(-5 * 60_000)])],
    ['in progress after the official start', 10 * 60_000, s => pool.query("UPDATE sessions SET status='in_progress' WHERE id=$1", [s.sessionId])],
  ];
  for (const [label, offset, prepare] of cases) {
    const s = await booked();
    await prepare(s);
    const result = await mentorCancels.cancel(mentorUser(s.mentorId), s.sessionId, undefined, at(offset));
    assert.deepEqual([result.status, result.refund.credits], ['cancelled', 1], label);
    assert.deepEqual(await effects(s.sessionId), { mentorRefunds: 1, menteeRefunds: 0, outbox: 1 }, label);
    assert.equal(await wallet(s.menteeId), 1, label);
  }
});

test('refund attribution reuses the shared helper: valid rollover keeps expiry; expired rollover becomes a new normal lot', async () => {
  const valid = await mentee(0);
  const validLot = await rollover(valid.id, '2031-01-01T00:00:00Z');
  const s1 = await booked({ menteeId: valid.id });
  const lotBefore = (await pool.query('SELECT * FROM credit_lots WHERE id=$1', [validLot])).rows[0];
  const r1 = await mentorCancel(s1);
  assert.deepEqual(r1.data.refund, { credits: 1, creditType: 'ROLLOVER', lotId: validLot });
  assert.deepEqual((await pool.query('SELECT * FROM credit_lots WHERE id=$1', [validLot])).rows[0], lotBefore);

  const lapsed = await mentee(0);
  const lapsedLot = await rollover(lapsed.id, '2029-06-01T00:00:00Z');
  const s2 = await booked({ menteeId: lapsed.id, bookedAt: new Date('2029-05-01T00:00:00Z') });
  const r2 = await mentorCancels.cancel(mentorUser(s2.mentorId), s2.sessionId, undefined, new Date('2029-06-02T00:00:00Z'));
  assert.equal(r2.refund.creditType, 'NORMAL');
  assert.notEqual(r2.refund.lotId, lapsedLot);
  const { rows: [issued] } = await pool.query('SELECT credit_type, session_id FROM credit_lots WHERE id=$1', [r2.refund.lotId]);
  assert.deepEqual(issued, { credit_type: 'NORMAL', session_id: s2.sessionId });
  const { rows: [{ remaining }] } = await pool.query('SELECT SUM(delta)::int AS remaining FROM ledger_entries WHERE lot_id=$1', [lapsedLot]);
  assert.equal(remaining, 0);
});

test('repeated mentor cancellation is a stable no-op: one refund, one outbox event', async () => {
  const s = await booked();
  const first = await mentorCancel(s);
  for (let i = 0; i < 5; i++) {
    const again = await mentorCancel(s);
    assert.deepEqual(again, { status: 200, data: { ...first.data, alreadyCancelled: true } });
  }
  assert.deepEqual(await effects(s.sessionId), { mentorRefunds: 1, menteeRefunds: 0, outbox: 1 });
});

test('concurrent mentor cancellations: one transition, one refund, one outbox event, no retries', async t => {
  const s = await booked();
  const tries = attempts(t, mentorCancels);
  const results = await barrier(lockMentee, [s.menteeId], Array.from({ length: 5 }, () => () => mentorCancel(s)));
  assert.equal(tries(), 5);
  assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200, 200]);
  assert.deepEqual(results.map(r => r.data.alreadyCancelled).sort(), [false, true, true, true, true]);
  assert.deepEqual(await effects(s.sessionId), { mentorRefunds: 1, menteeRefunds: 0, outbox: 1 });
  assert.equal(await wallet(s.menteeId), 1);
});

test('mentor vs mentee cancellation race: one policy wins, one terminal state, never a double refund', async t => {
  const outcomes = new Set();
  for (let round = 0; round < 6; round++) {
    const s = await booked();
    const mentorTries = attempts(t, mentorCancels);
    const [byMentor, byMentee] = await barrier(lockMentee, [s.menteeId], [() => mentorCancel(s), () => menteeCancel(s, 1)]);
    t.mock.restoreAll();
    assert.equal(mentorTries(), 1);
    const row = await sessionRow(s.sessionId);
    assert.equal(row.status, 'cancelled');
    const e = await effects(s.sessionId);
    assert.equal(e.mentorRefunds + e.menteeRefunds, 1);
    assert.equal(await wallet(s.menteeId), 1);
    if (row.cancellation_actor === s.mentorId) {
      outcomes.add('mentor');
      assert.deepEqual([byMentor.status, byMentor.data.alreadyCancelled], [200, false]);
      assert.deepEqual([byMentee.status, byMentee.data.cancelledBy, byMentee.data.alreadyCancelled], [200, 'mentor', true]);
      assert.deepEqual(e, { mentorRefunds: 1, menteeRefunds: 0, outbox: 1 });
    } else {
      outcomes.add('mentee');
      assert.deepEqual([byMentee.status, byMentee.data.alreadyCancelled], [200, false]);
      assert.deepEqual([byMentor.status, byMentor.data.code, byMentor.data.details], [409, 'SESSION_NOT_CANCELLABLE',
        { status: 'cancelled', cancelledBy: 'mentee' }]);
      assert.deepEqual(e, { mentorRefunds: 0, menteeRefunds: 1, outbox: 0 });
    }
  }
  assert.ok(outcomes.size >= 1);
});

test('mentor cancellation vs a lifecycle transition: in_progress stays cancellable, a terminal outcome rejects', async () => {
  for (const [target, expected] of [['in_progress', 200], ['completed', 409], ['no_show_mentor', 409]]) {
    const s = await booked();
    const worker = new pg.Client(connectionOptions());
    await worker.connect();
    await worker.query('BEGIN');
    await worker.query('SELECT 1 FROM sessions WHERE id=$1 FOR UPDATE', [s.sessionId]);
    await worker.query('UPDATE sessions SET status=$2 WHERE id=$1', [s.sessionId, target]);
    const pending = mentorCancel(s);
    await waitForLockWaiters(1);
    await worker.query('COMMIT');
    await worker.end();
    const result = await pending;
    assert.equal(result.status, expected, target);
    if (expected === 200) {
      assert.deepEqual([result.data.previousStatus, result.data.refund.credits], ['in_progress', 1]);
      assert.deepEqual(await effects(s.sessionId), { mentorRefunds: 1, menteeRefunds: 0, outbox: 1 });
    } else {
      assert.deepEqual([result.data.code, result.data.details], ['SESSION_NOT_CANCELLABLE', { status: target, cancelledBy: null }]);
      assert.equal((await sessionRow(s.sessionId)).status, target);
      assert.deepEqual(await effects(s.sessionId), { mentorRefunds: 0, menteeRefunds: 0, outbox: 0 });
    }
  }
});

test('a failure at the refund or the outbox step rolls back session, ledger and outbox together', async t => {
  // (a) refund append fails after writing
  const s = await booked();
  const before = await ledgerRows(s.menteeId);
  const append = ledger.appendEntry.bind(ledger);
  const fail = t.mock.method(ledger, 'appendEntry', async (...args) => { await append(...args); throw Error('test-only failure'); });
  const failed = await mentorCancel(s);
  fail.mock.restore();
  assert.deepEqual([failed.status, failed.data.code], [500, 'CANCELLATION_FAILED']);
  assert.equal((await sessionRow(s.sessionId)).status, 'scheduled');
  assert.deepEqual(await ledgerRows(s.menteeId), before);
  assert.deepEqual(await effects(s.sessionId), { mentorRefunds: 0, menteeRefunds: 0, outbox: 0 });
  // (b) the outbox insert fails (a conflicting stray row): the already-appended refund is rolled back too
  const u = await booked();
  const ledgerU = await ledgerRows(u.menteeId);
  await pool.query("INSERT INTO outbox_events (event_key,type,payload) VALUES ($1,'STRAY','{}')", ['mentor-cancelled:' + u.sessionId]);
  const blocked = await mentorCancel(u);
  assert.deepEqual([blocked.status, blocked.data.code], [500, 'CANCELLATION_FAILED']);
  assert.equal((await sessionRow(u.sessionId)).status, 'scheduled');
  assert.deepEqual(await ledgerRows(u.menteeId), ledgerU);
  assert.equal((await pool.query("SELECT type FROM outbox_events WHERE event_key=$1", ['mentor-cancelled:' + u.sessionId])).rows[0].type, 'STRAY');
  // A clean retry of (a) succeeds exactly once.
  assert.equal((await mentorCancel(s)).data.alreadyCancelled, false);
  assert.deepEqual(await effects(s.sessionId), { mentorRefunds: 1, menteeRefunds: 0, outbox: 1 });
});

test('only the owning mentor may cancel; mentees, admins and anonymous callers are refused', async () => {
  const s = await booked();
  const otherMentor = await user('mentor');
  for (const [by, status, code] of [[otherMentor, 403, 'FORBIDDEN'], [s.menteeId, 403, 'FORBIDDEN'], [ADMIN, 403, 'FORBIDDEN'],
    [null, 401, 'USER_NOT_FOUND']]) {
    const result = await mentorCancel(s, by);
    assert.deepEqual([result.status, result.data.code], [status, code]);
    assert.equal(result.data.sessionId, undefined);
  }
  for (const id of [uuid(), 'nope']) {
    assert.deepEqual((await http('POST', `/mentor/sessions/${id}/cancel`, s.mentorId)).data.code, 'SESSION_NOT_FOUND');
  }
  for (const body of [{ reason: '' }, { actor: 'admin' }]) {
    assert.deepEqual((await mentorCancel(s, s.mentorId, body)).data.code, 'INVALID_CANCELLATION_REQUEST');
  }
  assert.equal((await sessionRow(s.sessionId)).status, 'scheduled');
  assert.deepEqual(await effects(s.sessionId), { mentorRefunds: 0, menteeRefunds: 0, outbox: 0 });
});

test('a mentee-cancelled session is a terminal conflict for the mentor; the US-12 outcome is untouched', async () => {
  const s = await booked();
  assert.equal((await menteeCancel(s, 1)).data.refund.credits, 1);
  const result = await mentorCancel(s);
  assert.deepEqual([result.status, result.data.details], [409, { status: 'cancelled', cancelledBy: 'mentee' }]);
  assert.deepEqual(await effects(s.sessionId), { mentorRefunds: 0, menteeRefunds: 1, outbox: 0 });
});

// ================= admin ledger and adjustments =================
test('admin grant: 201 receipt, NORMAL lot from the adjustment, ADMIN_GRANT attributed to the admin', async () => {
  const m = await mentee(0);
  const result = await adjust(m.id, { delta: 3, reason: 'Goodwill for outage', idempotencyKey: 'grant-' + m.id });
  assert.equal(result.status, 201);
  const { adjustmentId, entries } = result.data;
  assert.deepEqual({ ...result.data, createdAt: undefined, entries: undefined }, { adjustmentId, menteeId: m.id, adjustedBy: ADMIN,
    delta: 3, reason: 'Goodwill for outage', idempotencyKey: 'grant-' + m.id, createdAt: undefined, entries: undefined });
  assert.deepEqual(entries.map(e => [e.kind, e.delta]), [['ADMIN_GRANT', 3]]);
  const { rows: [lot] } = await pool.query('SELECT credit_type, original_quantity, adjustment_id FROM credit_lots WHERE id=$1', [entries[0].lotId]);
  assert.deepEqual(lot, { credit_type: 'NORMAL', original_quantity: 3, adjustment_id: adjustmentId });
  assert.equal(await wallet(m.id), 3);
  const view = await http('GET', `/admin/users/${m.id}/ledger`, ADMIN);
  assert.equal(view.status, 200);
  assert.deepEqual(view.data.balance, { normal: 3, rollover: 0, debt: 0, totalSpendable: 3 });
  const [item] = view.data.items;
  assert.deepEqual([item.kind, item.delta, item.reason, item.adjustmentId, item.adjustedBy, item.lotId, item.creditType],
    ['ADMIN_GRANT', 3, 'Goodwill for outage', adjustmentId, ADMIN, entries[0].lotId, 'NORMAL']);
});

test('admin revoke follows the spend order, never drives a lot negative and respects debt', async () => {
  const m = await mentee(4);
  const rolloverLot = await rollover(m.id, '2031-01-01T00:00:00Z');
  const result = await adjust(m.id, { delta: -2, reason: 'Duplicate purchase correction', idempotencyKey: 'revoke-' + m.id });
  assert.equal(result.status, 201);
  // Entries of one adjustment share a timestamp, so compare as a set; one credit from each lot.
  const byLot = e => e.lotId === rolloverLot ? 0 : 1;
  assert.deepEqual(result.data.entries.sort((x, y) => byLot(x) - byLot(y)).map(e => [e.kind, e.delta, e.lotId]),
    [['ADMIN_REVOKE', -1, rolloverLot], ['ADMIN_REVOKE', -1, m.lotId]]);
  assert.equal(await wallet(m.id), 3);
  // Spend order: a single-credit revoke takes the earliest-expiring rollover credit before normal credit.
  const order = await mentee(4);
  const early = await rollover(order.id, '2031-01-01T00:00:00Z');
  await rollover(order.id, '2031-06-01T00:00:00Z');
  const one = await adjust(order.id, { delta: -1, reason: 'Order check', idempotencyKey: 'order-' + order.id });
  assert.deepEqual(one.data.entries.map(e => e.lotId), [early]);
  const before = await ledgerRows(m.id);
  const tooMuch = await adjust(m.id, { delta: -4, reason: 'x', idempotencyKey: 'too-much-' + m.id });
  assert.deepEqual([tooMuch.status, tooMuch.data.code, tooMuch.data.details], [409, 'INSUFFICIENT_CREDITS', { available: 3, requested: 4 }]);
  assert.deepEqual(await ledgerRows(m.id), before);
  assert.equal((await pool.query('SELECT 1 FROM credit_adjustments WHERE idempotency_key=$1', ['too-much-' + m.id])).rowCount, 0);

  // Debt: 2 normal + a refunded pack whose spent credit became debt (-1) leaves 1 spendable.
  const d = await mentee(2);
  const refunded = await purchase(d.id, 1);
  await tx(client => ledger.appendEntry(client, { menteeId: d.id, lotId: refunded.lotId, paymentId: refunded.paymentId,
    kind: 'DEBT', delta: -2, idempotencyKey: 'purchase-debt:' + refunded.paymentId }));
  assert.equal(await wallet(d.id), 1);
  assert.equal((await adjust(d.id, { delta: -2, reason: 'x', idempotencyKey: 'debt-2-' + d.id })).status, 409);
  assert.equal((await adjust(d.id, { delta: -1, reason: 'x', idempotencyKey: 'debt-1-' + d.id })).status, 201);
  const { rows } = await pool.query('SELECT lot_id, SUM(delta)::int AS remaining FROM ledger_entries WHERE mentee_id=$1 GROUP BY lot_id', [d.id]);
  assert.deepEqual(rows.map(r => r.remaining).sort((a, b) => a - b), [-1, 1]);
  assert.equal(await wallet(d.id), 0);
});

test('adjustment validation: missing or blank reason, zero delta, non-mentee or unknown targets have no effect', async () => {
  const m = await mentee(1);
  const before = await ledgerRows(m.id);
  for (const body of [{ delta: 1, idempotencyKey: 'a' }, { delta: 1, reason: '   ', idempotencyKey: 'b' },
    { delta: 0, reason: 'r', idempotencyKey: 'c' }, { delta: 1, reason: 'r', idempotencyKey: 'd', adminId: m.id }]) {
    const result = await adjust(m.id, body);
    assert.deepEqual([result.status, result.data.code], [422, 'INVALID_ADJUSTMENT'], JSON.stringify(body));
  }
  assert.deepEqual(await ledgerRows(m.id), before);
  const mentor = await user('mentor');
  assert.deepEqual((await adjust(mentor, { delta: 1, reason: 'r', idempotencyKey: 'e' })).data.code, 'TARGET_NOT_MENTEE');
  assert.deepEqual((await adjust(uuid(), { delta: 1, reason: 'r', idempotencyKey: 'f' })).data.code, 'TARGET_USER_NOT_FOUND');
  assert.equal((await pool.query("SELECT 1 FROM credit_adjustments WHERE idempotency_key IN ('a','b','c','d','e','f')")).rowCount, 0);
});

test('adjustment idempotency: identical retry replays with 200; any different content reusing the key is 409', async () => {
  const m = await mentee(5), other = await mentee(5);
  const admin2 = await user('admin');
  const body = { delta: -1, reason: 'Chargeback', idempotencyKey: 'idem-' + m.id };
  const first = await adjust(m.id, body);
  assert.equal(first.status, 201);
  assert.deepEqual(await adjust(m.id, body), { status: 200, data: first.data });
  for (const [target, variant, by] of [[m.id, { ...body, delta: -2 }, ADMIN], [m.id, { ...body, reason: 'Other' }, ADMIN],
    [other.id, body, ADMIN], [m.id, body, admin2]]) {
    const result = await adjust(target, variant, by);
    assert.deepEqual([result.status, result.data.code], [409, 'IDEMPOTENCY_CONFLICT']);
  }
  assert.equal(await wallet(m.id), 4);
  assert.equal(await wallet(other.id), 5);
});

test('concurrent adjustments on independent connections: one per key, distinct keys all audited, no retries', async t => {
  const m = await mentee(2);
  const tries = attempts(t, admins);
  const same = { delta: 2, reason: 'Same request', idempotencyKey: 'same-' + m.id };
  const results = await barrier(lockMentee, [m.id], [
    () => adjust(m.id, same), () => adjust(m.id, same), () => adjust(m.id, same),
    () => adjust(m.id, { delta: 1, reason: 'Second', idempotencyKey: 'second-' + m.id }),
    () => adjust(m.id, { delta: -3, reason: 'Third', idempotencyKey: 'third-' + m.id })]);
  assert.equal(tries(), 5);
  assert.deepEqual(results.slice(0, 3).map(r => r.status).sort(), [200, 200, 201]);
  assert.equal(new Set(results.slice(0, 3).map(r => r.data.adjustmentId)).size, 1);
  assert.deepEqual(results.slice(3).map(r => r.status), [201, 201]);
  const { rows } = await pool.query('SELECT count(*)::int AS n, SUM(delta)::int AS total FROM credit_adjustments WHERE mentee_id=$1', [m.id]);
  assert.deepEqual(rows[0], { n: 3, total: 0 });
  assert.equal(await wallet(m.id), 2);
  const { rows: [neg] } = await pool.query(`SELECT count(*)::int AS n FROM (SELECT lot_id FROM ledger_entries WHERE mentee_id=$1
    GROUP BY lot_id HAVING SUM(delta) < 0) x`, [m.id]);
  assert.equal(neg.n, 0);
});

test('admin revoke and a booking racing for the last credit: exactly one wins', async () => {
  const m = await mentee(1);
  const mentorId = await user('mentor');
  const [revoke, booking] = await barrier(lockMentee, [m.id], [
    () => adjust(m.id, { delta: -1, reason: 'Fraud review', idempotencyKey: 'race-' + m.id }),
    () => http('POST', '/sessions', m.id, { mentorId, startsAt: START })]);
  assert.deepEqual([revoke.status, booking.status].sort(), [201, 409]);
  assert.equal(await wallet(m.id), 0);
  const { rows: [{ remaining }] } = await pool.query('SELECT SUM(delta)::int AS remaining FROM ledger_entries WHERE mentee_id=$1', [m.id]);
  assert.equal(remaining, 0);
});

test('admin ledger inspection: any user, cursor pagination, empty ledgers, unknown users; admins only', async () => {
  const m = await mentee(1);
  await adjust(m.id, { delta: 1, reason: 'One', idempotencyKey: 'page-1-' + m.id });
  await adjust(m.id, { delta: 1, reason: 'Two', idempotencyKey: 'page-2-' + m.id });
  const first = await http('GET', `/admin/users/${m.id}/ledger?limit=2`, ADMIN);
  assert.deepEqual([first.status, first.data.items.length, first.data.user.role], [200, 2, 'mentee']);
  const second = await http('GET', `/admin/users/${m.id}/ledger?limit=2&cursor=${first.data.nextCursor}`, ADMIN);
  assert.deepEqual(second.data.items.map(e => e.kind), ['PURCHASE_GRANT']);
  assert.equal(second.data.nextCursor, null);
  assert.deepEqual([...first.data.items, ...second.data.items].map(e => e.reason), ['Two', 'One', null]);
  const mentorView = await http('GET', `/admin/users/${SEEDED_MENTOR}/ledger`, ADMIN);
  assert.deepEqual([mentorView.status, mentorView.data.items, mentorView.data.balance, mentorView.data.nextCursor], [200, [], null, null]);
  assert.deepEqual((await http('GET', `/admin/users/${uuid()}/ledger`, ADMIN)).data.code, 'TARGET_USER_NOT_FOUND');
  assert.deepEqual((await http('GET', `/admin/users/${m.id}/ledger?limit=0`, ADMIN)).data.code, 'INVALID_PAGE');
  for (const [by, status] of [[m.id, 403], [SEEDED_MENTOR, 403], [null, 401]]) {
    const ledgerView = await http('GET', `/admin/users/${m.id}/ledger`, by);
    const grant = await adjust(m.id, { delta: 5, reason: 'r', idempotencyKey: 'nope-' + status + by }, by);
    assert.deepEqual([ledgerView.status, grant.status], [status, status]);
    assert.equal(ledgerView.data.items, undefined);
  }
  assert.equal(await wallet(m.id), 3);
});

test('ledger rows stay immutable for the runtime role', async () => {
  const m = await mentee(1);
  await assert.rejects(pool.query('UPDATE ledger_entries SET delta=99 WHERE mentee_id=$1', [m.id]), e => e.code === '42501');
  await assert.rejects(pool.query('DELETE FROM ledger_entries WHERE mentee_id=$1', [m.id]), e => e.code === '42501');
  await assert.rejects(pool.query('UPDATE credit_adjustments SET delta=1'), e => e.code === '42501');
  const { rows: [grants] } = await pool.query(`SELECT bool_or(has_table_privilege(t,'UPDATE') OR has_table_privilege(t,'DELETE')) AS mutable
    FROM unnest(ARRAY['ledger_entries','credit_lots','session_credit_allocations','booking_requests','credit_adjustments']) t`);
  assert.equal(grants.mutable, false);
});
