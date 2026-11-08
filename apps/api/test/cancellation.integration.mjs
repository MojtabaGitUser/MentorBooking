import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID as uuid } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/create-app.js';
import { LedgerService } from '../dist/wallet/ledger.service.js';
import { RolloverService } from '../dist/wallet/rollover.service.js';
import { WalletService } from '../dist/wallet/wallet.service.js';
import { BookingService } from '../dist/sessions/booking.service.js';
import { CancellationService } from '../dist/sessions/cancellation.service.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

const database = 'cancel_test_' + uuid().replaceAll('-', '');
const owner = new pg.Client({ ...connectionOptions(), database: 'postgres' });
const seeded = { mentor: '00000000-0000-4000-8000-000000000001', admin: '00000000-0000-4000-8000-000000000005' };
const H = 3_600_000;
const START = '2030-06-03T10:00:00Z';
const start = new Date(START);
const at = offsetMs => new Date(start.getTime() + offsetMs);
let app, base, pool, ledger, bookings, cancellations, created;

before(async () => {
  assert.ok(!process.env.DATABASE_URL, 'Use the bundled PostgreSQL server for cancellation tests');
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
  cancellations = app.get(CancellationService);
});
after(async () => {
  try {
    await app?.close();
    if (created) await owner.query('DROP DATABASE ' + database);
  } finally { await owner.end(); }
});

// ---------- fixtures ----------
async function mentor() {
  const id = uuid();
  await pool.query("INSERT INTO users (id,role,display_name,timezone) VALUES ($1,'mentor','Mentor','UTC')", [id]);
  await pool.query('INSERT INTO mentor_profiles (mentor_id) VALUES ($1)', [id]);
  for (let weekday = 1; weekday <= 7; weekday++) {
    await pool.query("INSERT INTO weekly_availability (mentor_id,weekday,start_local,end_local) VALUES ($1,$2,'00:00','23:30')", [id, weekday]);
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
  return lot.id;
}
let historic = 0;
async function rollover(menteeId, expiresAt) {
  const sessionId = uuid();
  const old = new Date(Date.UTC(2001, 0, 1) + (historic++) * H).toISOString();
  await pool.query(`INSERT INTO sessions (id,mentor_id,mentee_id,starts_at,ends_at,status,cancellation_actor,cancelled_at)
    VALUES ($1,$2,$3,$4,$4::timestamptz+interval '30 minutes','cancelled',$2,$4)`, [sessionId, seeded.mentor, menteeId, old]);
  const { rows: [lot] } = await pool.query(`INSERT INTO credit_lots (mentee_id,credit_type,original_quantity,session_id,expires_at)
    VALUES ($1,'ROLLOVER',1,$2,$3) RETURNING id`, [menteeId, sessionId, expiresAt]);
  await tx(client => ledger.appendEntry(client, { menteeId, lotId: lot.id, sessionId, kind: 'NO_SHOW_ROLLOVER',
    delta: 1, idempotencyKey: 'no-show-rollover:' + sessionId }));
  return lot.id;
}
async function mentee(credits = 1) {
  const id = uuid();
  await pool.query("INSERT INTO users (id,role,display_name,timezone) VALUES ($1,'mentee','Mentee','America/Vancouver')", [id]);
  const lotId = credits ? await purchase(id, credits) : null;
  return { id, lotId };
}
// A booked session via the real US-11 service; `now` lets a session be booked before a past test clock.
async function booked(credits = 1, { startsAt = START, bookedAt } = {}) {
  const m = await mentor(), me = await mentee(credits);
  const { booking } = await bookings.book(me.id, { mentorId: m, startsAt }, undefined, bookedAt);
  return { mentorId: m, menteeId: me.id, lotId: me.lotId, sessionId: booking.sessionId };
}

// ---------- helpers ----------
async function http(method, path, user, body) {
  const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(user && { 'X-User-Id': user }) } });
  return { status: response.status, data: await response.json() };
}
const preview = (user, id) => http('GET', `/sessions/${id}/cancellation-preview`, user);
const cancel = (user, id, expectedRefundableCredits) => http('POST', `/sessions/${id}/cancel`, user, { expectedRefundableCredits });
const userOf = id => ({ id, role: 'mentee', displayName: 'Mentee', timezone: 'UTC' });
const serviceCancel = (s, expected, now) => cancellations.cancel(userOf(s.menteeId), s.sessionId, { expectedRefundableCredits: expected }, now);
const servicePreview = (s, now) => cancellations.preview(userOf(s.menteeId), s.sessionId, now);
async function rejects(promise, status, code) {
  await assert.rejects(promise, error => error.getStatus() === status && error.getResponse().code === code);
  try { await promise; } catch (error) { return error.getResponse(); }
}
async function session(id) {
  return (await pool.query('SELECT status, cancelled_at, cancellation_actor FROM sessions WHERE id=$1', [id])).rows[0];
}
async function ledgerRows(menteeId) {
  return (await pool.query(`SELECT id, kind, delta, lot_id, session_id, reason, idempotency_key, created_at
    FROM ledger_entries WHERE mentee_id=$1 ORDER BY created_at, id`, [menteeId])).rows;
}
async function refunds(sessionId) {
  return (await pool.query("SELECT * FROM ledger_entries WHERE session_id=$1 AND kind='CANCELLATION_REFUND'", [sessionId])).rows;
}
const wallet = id => app.get(WalletService).getWallet(id);
async function unchanged(s, ledgerBefore) {
  assert.equal((await session(s.sessionId)).status, 'scheduled');
  assert.deepEqual(await ledgerRows(s.menteeId), ledgerBefore);
}

async function barrier(lockSql, args, requests) {
  const holder = new pg.Client(connectionOptions());
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(lockSql, args);
    const pending = requests.map(request => request());
    for (let i = 0; ; i++) {
      const { rows: [{ waiting }] } = await owner.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname=$1 AND wait_event_type='Lock'`, [database]);
      if (waiting >= requests.length) break;
      if (i > 400) throw Error(`only ${waiting}/${requests.length} transactions reached the lock`);
      await delay(10);
    }
    await holder.query('COMMIT');
    return await Promise.all(pending);
  } finally { await holder.end(); }
}
function attempts(t, service, method) {
  const original = service[method].bind(service);
  const spy = t.mock.method(service, method, (...args) => original(...args));
  return () => spy.mock.callCount();
}

// ---------- refund policy and attribution ----------
test('more than 24h before start: preview promises 1, cancellation refunds it to the original normal lot', async () => {
  const s = await booked(1);
  assert.equal((await wallet(s.menteeId)).totalSpendable, 0);
  const before = await ledgerRows(s.menteeId);
  const shown = await preview(s.menteeId, s.sessionId);
  assert.equal(shown.status, 200);
  assert.deepEqual({ ...shown.data, serverNow: undefined }, { sessionId: s.sessionId, status: 'scheduled', eligible: true,
    refundableCredits: 1, refundType: 'FULL', reason: 'MORE_THAN_24_HOURS_BEFORE_START', startsAt: START,
    cutoffAt: '2030-06-02T10:00:00Z', serverNow: undefined });
  const done = await cancel(s.menteeId, s.sessionId, 1);
  assert.equal(done.status, 200);
  assert.deepEqual({ ...done.data, cancelledAt: undefined }, { sessionId: s.sessionId, status: 'cancelled', cancelledAt: undefined,
    cancelledBy: 'mentee', alreadyCancelled: false, reason: 'MORE_THAN_24_HOURS_BEFORE_START',
    refund: { credits: 1, creditType: 'NORMAL', lotId: s.lotId } });
  const row = await session(s.sessionId);
  assert.deepEqual([row.status, row.cancellation_actor], ['cancelled', s.menteeId]);
  assert.equal(row.cancelled_at.toISOString(), done.data.cancelledAt);
  const [refund] = await refunds(s.sessionId);
  assert.deepEqual([refund.delta, refund.lot_id, refund.idempotency_key], [1, s.lotId, 'cancel-refund:' + s.sessionId]);
  assert.equal((await wallet(s.menteeId)).totalSpendable, 1);
  // Earlier ledger rows are untouched; exactly one compensating row was appended.
  const after = await ledgerRows(s.menteeId);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.slice(before.length).map(e => e.kind), ['CANCELLATION_REFUND']);
});

test('exactly 24h and less than 24h cancel with zero refund; 24h + 1ms refunds', async () => {
  for (const [offset, credits] of [[-24 * H, 0], [-(23 * H + 59 * 60_000), 0], [-1, 0], [-24 * H - 1, 1]]) {
    const s = await booked(1);
    const shown = await servicePreview(s, at(offset));
    assert.equal(shown.refundableCredits, credits, `preview at ${offset}`);
    const result = await serviceCancel(s, credits, at(offset));
    assert.deepEqual([result.status, result.refund.credits], ['cancelled', credits], `cancel at ${offset}`);
    assert.equal((await refunds(s.sessionId)).length, credits);
    assert.equal((await wallet(s.menteeId)).totalSpendable, credits);
  }
});

test('at or after the official start the mentee cannot cancel, even while status is still scheduled', async () => {
  for (const offset of [0, 1, 60_000]) {
    const s = await booked(1);
    const before = await ledgerRows(s.menteeId);
    const shown = await servicePreview(s, at(offset));
    assert.deepEqual([shown.eligible, shown.reason], [false, 'SESSION_STARTED']);
    for (const expected of [0, 1]) {
      const body = await rejects(serviceCancel(s, expected, at(offset)), 409, 'SESSION_NOT_CANCELLABLE');
      assert.equal(body.details.currentPreview.reason, 'SESSION_STARTED');
    }
    await unchanged(s, before);
  }
});

test('preview crossing the cutoff: 409 with the new outcome, nothing changes, then reconfirmation succeeds', async () => {
  const s = await booked(1);
  const before = await ledgerRows(s.menteeId);
  const shown = await servicePreview(s, at(-24 * H - 1));
  assert.equal(shown.refundableCredits, 1);
  const body = await rejects(serviceCancel(s, shown.refundableCredits, at(-24 * H)), 409, 'CANCELLATION_POLICY_CHANGED');
  assert.deepEqual([body.details.currentPreview.refundableCredits, body.details.currentPreview.reason,
    body.details.currentPreview.eligible], [0, 'WITHIN_24_HOURS_OF_START', true]);
  await unchanged(s, before);
  assert.equal((await wallet(s.menteeId)).totalSpendable, 0);
  const confirmed = await serviceCancel(s, body.details.currentPreview.refundableCredits, at(-24 * H + 1000));
  assert.deepEqual([confirmed.status, confirmed.refund.credits], ['cancelled', 0]);
  assert.equal((await refunds(s.sessionId)).length, 0);
  // The opposite direction is equally refused: a confirmed zero is never silently turned into a refund.
  const t = await booked(1);
  const ledgerT = await ledgerRows(t.menteeId);
  await rejects(serviceCancel(t, 0, at(-48 * H)), 409, 'CANCELLATION_POLICY_CHANGED');
  await unchanged(t, ledgerT);
});

test('a still-valid rollover credit returns to its original lot with its original expiry', async () => {
  const me = await mentee(1);
  const lot = await rollover(me.id, '2031-01-01T00:00:00Z');
  const m = await mentor();
  const { booking } = await bookings.book(me.id, { mentorId: m, startsAt: START });
  assert.equal(booking.spentCreditType, 'ROLLOVER');
  const before = (await pool.query('SELECT * FROM credit_lots WHERE id=$1', [lot])).rows[0];
  const result = await cancel(me.id, booking.sessionId, 1);
  assert.deepEqual(result.data.refund, { credits: 1, creditType: 'ROLLOVER', lotId: lot });
  assert.deepEqual((await pool.query('SELECT * FROM credit_lots WHERE id=$1', [lot])).rows[0], before);
  const w = await wallet(me.id);
  assert.deepEqual([w.normal, w.rollover, w.rolloverLots], [1, 1, [{ lotId: lot, remaining: 1, expiresAt: before.expires_at }]]);
});

test('an expired rollover credit is refunded as one new normal lot; the expired lot is never revived', async () => {
  const me = await mentee(0);
  const expiry = new Date('2029-06-01T00:00:00Z');
  const lot = await rollover(me.id, expiry);
  const m = await mentor();
  const { booking } = await bookings.book(me.id, { mentorId: m, startsAt: START }, undefined, new Date('2029-05-01T00:00:00Z'));
  assert.equal(booking.spentCreditType, 'ROLLOVER');
  const s = { menteeId: me.id, sessionId: booking.sessionId };
  const now = new Date('2029-06-02T00:00:00Z');
  const result = await serviceCancel(s, 1, now);
  assert.equal(result.refund.creditType, 'NORMAL');
  assert.notEqual(result.refund.lotId, lot);
  const { rows: [issued] } = await pool.query('SELECT * FROM credit_lots WHERE id=$1', [result.refund.lotId]);
  assert.deepEqual([issued.credit_type, issued.original_quantity, issued.session_id, issued.expires_at],
    ['NORMAL', 1, booking.sessionId, null]);
  const [refund] = await refunds(booking.sessionId);
  assert.equal(refund.lot_id, issued.id);
  assert.match(refund.reason, /expired; refunded as normal credit/);
  // The original lot stays fully spent and the allocation still names it.
  const { rows: [{ remaining }] } = await pool.query('SELECT SUM(delta)::int AS remaining FROM ledger_entries WHERE lot_id=$1', [lot]);
  assert.equal(remaining, 0);
  const { rows: [allocation] } = await pool.query('SELECT lot_id FROM session_credit_allocations WHERE session_id=$1', [booking.sessionId]);
  assert.equal(allocation.lot_id, lot);
  await app.get(RolloverService).expireRolloverLots(now);
  assert.equal((await pool.query("SELECT 1 FROM ledger_entries WHERE lot_id=$1 AND kind='ROLLOVER_EXPIRE'", [lot])).rowCount, 0);
  const w = await app.get(WalletService).getWallet(me.id, now);
  assert.deepEqual([w.normal, w.rollover, w.totalSpendable], [1, 0, 1]);
  // PostgreSQL refuses a second refund lot for the same session.
  await assert.rejects(pool.query("INSERT INTO credit_lots (mentee_id,credit_type,original_quantity,session_id) VALUES ($1,'NORMAL',1,$2)",
    [me.id, booking.sessionId]), error => error.code === '23505' && error.constraint === 'credit_lots_one_refund_lot_per_session');
});

// ---------- idempotency and concurrency ----------
test('repeated cancellation is a stable no-op reporting the recorded outcome', async () => {
  const s = await booked(1);
  const first = await cancel(s.menteeId, s.sessionId, 1);
  for (let i = 0; i < 10; i++) {
    const again = await cancel(s.menteeId, s.sessionId, i % 2);
    assert.equal(again.status, 200);
    assert.deepEqual(again.data, { ...first.data, alreadyCancelled: true, reason: 'ALREADY_CANCELLED' });
  }
  assert.equal((await refunds(s.sessionId)).length, 1);
  assert.equal((await wallet(s.menteeId)).totalSpendable, 1);
  const shown = await preview(s.menteeId, s.sessionId);
  assert.deepEqual([shown.data.eligible, shown.data.reason], [false, 'ALREADY_CANCELLED']);
});

test('concurrent cancellations on independent connections: one transition, one refund, no retries', async t => {
  const s = await booked(1);
  const tries = attempts(t, cancellations, 'attempt');
  const results = await barrier('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [s.menteeId],
    Array.from({ length: 5 }, () => () => cancel(s.menteeId, s.sessionId, 1)));
  assert.equal(tries(), 5);
  assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200, 200]);
  assert.deepEqual(results.map(r => r.data.alreadyCancelled).sort(), [false, true, true, true, true]);
  assert.equal(new Set(results.map(r => r.data.cancelledAt)).size, 1);
  assert.equal((await refunds(s.sessionId)).length, 1);
  assert.equal((await wallet(s.menteeId)).totalSpendable, 1);
});

test('cancellation and a competing booking of the freed slot follow one lock order without deadlock', async t => {
  for (let round = 0; round < 3; round++) {
    const s = await booked(1);
    const rival = await mentee(1);
    const bookTries = attempts(t, bookings, 'attempt');
    const cancelTries = attempts(t, cancellations, 'attempt');
    const [cancelled, rebooked] = await barrier('SELECT 1 FROM mentor_profiles WHERE mentor_id=$1 FOR UPDATE', [s.mentorId], [
      () => cancel(s.menteeId, s.sessionId, 1),
      () => http('POST', '/sessions', rival.id, { mentorId: s.mentorId, startsAt: START })]);
    assert.equal(cancelled.status, 200);
    assert.ok([201, 409].includes(rebooked.status));
    if (rebooked.status === 409) assert.equal(rebooked.data.details.reason, 'BOOKED');
    assert.deepEqual([bookTries(), cancelTries()], [1, 1], 'no deadlock or retry');
    t.mock.restoreAll();
    const { rows: [{ active }] } = await pool.query("SELECT count(*)::int AS active FROM sessions WHERE mentor_id=$1 AND status<>'cancelled'", [s.mentorId]);
    assert.equal(active, rebooked.status === 201 ? 1 : 0);
  }
});

test('a cancelled slot can be booked again and is offered by the slot preview', async () => {
  const s = await booked(1);
  const rival = await mentee(1);
  assert.equal((await http('POST', '/sessions', rival.id, { mentorId: s.mentorId, startsAt: START })).data.details.reason, 'BOOKED');
  await cancel(s.menteeId, s.sessionId, 1);
  const slots = await http('GET', `/mentors/${s.mentorId}/slots?from=2030-06-03&to=2030-06-03`, rival.id);
  assert.ok(slots.data.slots.some(slot => slot.startsAt === START));
  assert.equal((await http('POST', '/sessions', rival.id, { mentorId: s.mentorId, startsAt: START })).status, 201);
});

// ---------- atomicity ----------
test('a failure while refunding rolls back the status change and the ledger together', async t => {
  for (const mode of ['before-append', 'after-append']) {
    const s = await booked(1);
    const before = await ledgerRows(s.menteeId);
    const append = ledger.appendEntry.bind(ledger);
    const fail = t.mock.method(ledger, 'appendEntry', async (...args) => {
      if (mode === 'after-append') await append(...args);
      throw Error('test-only failure ' + mode);
    });
    const result = await cancel(s.menteeId, s.sessionId, 1);
    fail.mock.restore();
    assert.equal(result.status, 500);
    assert.deepEqual(result.data, { code: 'CANCELLATION_FAILED', message: 'Cancellation could not be completed. Nothing was changed; please retry.' });
    await unchanged(s, before);
    const retry = await cancel(s.menteeId, s.sessionId, 1);
    assert.deepEqual([retry.status, retry.data.alreadyCancelled, retry.data.refund.credits], [200, false, 1]);
    assert.equal((await refunds(s.sessionId)).length, 1);
  }
});

// ---------- lifecycle states ----------
test('an early join before the official start does not block mentee cancellation', async () => {
  const s = await booked(1);
  await pool.query('UPDATE sessions SET joined_mentor_at=$2, joined_mentee_at=$2 WHERE id=$1', [s.sessionId, at(-5 * 60_000)]);
  const result = await serviceCancel(s, 0, at(-4 * 60_000));
  assert.deepEqual([result.status, result.refund.credits], ['cancelled', 0]);
});

test('in-progress, terminal and mentor-cancelled sessions are not cancelled again by the mentee', async () => {
  for (const status of ['in_progress', 'completed', 'no_show_mentee', 'no_show_mentor']) {
    const s = await booked(1);
    await pool.query('UPDATE sessions SET status=$2 WHERE id=$1', [s.sessionId, status]);
    const result = await cancel(s.menteeId, s.sessionId, 1);
    assert.deepEqual([result.status, result.data.code, result.data.details.currentPreview.reason], [409, 'SESSION_NOT_CANCELLABLE', 'NOT_SCHEDULED']);
    assert.equal((await session(s.sessionId)).status, status);
  }
  const s = await booked(1);
  await pool.query("UPDATE sessions SET status='cancelled', cancelled_at=now(), cancellation_actor=mentor_id WHERE id=$1", [s.sessionId]);
  const result = await cancel(s.menteeId, s.sessionId, 1);
  assert.deepEqual([result.status, result.data.cancelledBy, result.data.alreadyCancelled, result.data.refund.credits], [200, 'mentor', true, 0]);
  assert.equal((await refunds(s.sessionId)).length, 0);
});

// ---------- authentication and authorization ----------
test('only the owning mentee can preview or cancel; others get 401/403/404 and nothing changes', async () => {
  const s = await booked(1);
  const other = await mentee(1);
  const before = await ledgerRows(s.menteeId);
  for (const [user, status, code] of [[null, 401, 'USER_NOT_FOUND'], [uuid(), 401, 'USER_NOT_FOUND'], [other.id, 403, 'FORBIDDEN'],
    [s.mentorId, 403, 'FORBIDDEN'], [seeded.admin, 403, 'FORBIDDEN']]) {
    for (const result of [await preview(user, s.sessionId), await cancel(user, s.sessionId, 1)]) {
      assert.deepEqual([result.status, result.data.code], [status, code]);
      assert.equal(result.data.sessionId, undefined);
    }
  }
  for (const id of [uuid(), 'not-a-session']) {
    assert.deepEqual((await cancel(s.menteeId, id, 1)).data.code, 'SESSION_NOT_FOUND');
    assert.deepEqual((await preview(s.menteeId, id)).status, 404);
  }
  for (const body of [{}, { expectedRefundableCredits: 2 }, { expectedRefundableCredits: 1, extra: true }]) {
    const result = await http('POST', `/sessions/${s.sessionId}/cancel`, s.menteeId, body);
    assert.deepEqual([result.status, result.data.code], [422, 'INVALID_CANCELLATION_REQUEST']);
  }
  await unchanged(s, before);
});

test('ledger, lots and allocations stay append-only for the runtime role', async () => {
  const { rows: [grants] } = await pool.query(`SELECT bool_or(has_table_privilege(t,'UPDATE') OR has_table_privilege(t,'DELETE')) AS mutable
    FROM unnest(ARRAY['ledger_entries','credit_lots','session_credit_allocations','booking_requests']) t`);
  assert.equal(grants.mutable, false);
  const { rows: [check] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM (SELECT session_id FROM ledger_entries WHERE kind='CANCELLATION_REFUND' GROUP BY session_id HAVING count(*)>1) d) AS duplicate_refunds,
    (SELECT count(*)::int FROM ledger_entries e JOIN sessions s ON s.id=e.session_id
      WHERE e.kind='CANCELLATION_REFUND' AND s.status<>'cancelled') AS refund_without_cancellation`);
  assert.deepEqual(check, { duplicate_refunds: 0, refund_without_cancellation: 0 });
});
