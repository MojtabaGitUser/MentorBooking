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
import { RolloverService } from '../dist/wallet/rollover.service.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

// Real PostgreSQL only: a disposable database on the bundled server, the restricted runtime login,
// and concurrent HTTP requests whose transactions are proven to overlap via pg_stat_activity.
const database = 'booking_test_' + uuid().replaceAll('-', '');
const owner = new pg.Client({ ...connectionOptions(), database: 'postgres' });
const seeded = { mentor: '00000000-0000-4000-8000-000000000001', mentee: '00000000-0000-4000-8000-000000000003',
  admin: '00000000-0000-4000-8000-000000000005' };
const UNAVAILABLE = 'This time slot is no longer available. Please select another slot.';
let app, base, pool, ledger, created;

before(async () => {
  assert.ok(!process.env.DATABASE_URL, 'Use the bundled PostgreSQL server for booking tests');
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
});
after(async () => {
  try {
    await app?.close();
    if (created) await owner.query('DROP DATABASE ' + database);
  } finally { await owner.end(); }
});

// ---------- fixtures ----------
const allWeek = [1, 2, 3, 4, 5, 6, 7].map(weekday => [weekday, '00:00', '23:30']);
async function mentor(timezone = 'UTC', rules = allWeek) {
  const id = uuid();
  await pool.query("INSERT INTO users (id,role,display_name,timezone) VALUES ($1,'mentor','Mentor',$2)", [id, timezone]);
  await pool.query('INSERT INTO mentor_profiles (mentor_id) VALUES ($1)', [id]);
  for (const [weekday, start, end] of rules) {
    await pool.query('INSERT INTO weekly_availability (mentor_id,weekday,start_local,end_local) VALUES ($1,$2,$3,$4)',
      [id, weekday, start, end]);
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
  return { paymentId, lotId: lot.id };
}
let historicSlot = 0;
async function rollover(menteeId, expiresAt, createdAt = null) {
  // A rollover lot originates from a (here: historic, cancelled) session of the same mentee.
  const sessionId = uuid();
  const start = new Date(Date.UTC(2001, 0, 1) + (historicSlot++) * 3_600_000).toISOString();
  await pool.query(`INSERT INTO sessions (id,mentor_id,mentee_id,starts_at,ends_at,status,cancellation_actor,cancelled_at)
    VALUES ($1,$2,$3,$4,$4::timestamptz+interval '30 minutes','cancelled',$2,$4)`, [sessionId, seeded.mentor, menteeId, start]);
  const { rows: [lot] } = await pool.query(`INSERT INTO credit_lots (mentee_id,credit_type,original_quantity,session_id,expires_at,created_at)
    VALUES ($1,'ROLLOVER',1,$2,$3,COALESCE($4::timestamptz,now())) RETURNING id`, [menteeId, sessionId, expiresAt, createdAt]);
  await tx(client => ledger.appendEntry(client, { menteeId, lotId: lot.id, sessionId, kind: 'NO_SHOW_ROLLOVER',
    delta: 1, idempotencyKey: 'no-show-rollover:' + sessionId }));
  return lot.id;
}
async function mentee(credits = 0, timezone = 'America/Vancouver') {
  const id = uuid();
  await pool.query("INSERT INTO users (id,role,display_name,timezone) VALUES ($1,'mentee','Mentee',$2)", [id, timezone]);
  if (credits) await purchase(id, credits);
  return id;
}

// ---------- helpers ----------
async function book(user, mentorId, startsAt, key, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...(user && { 'X-User-Id': user }), ...(key && { 'Idempotency-Key': key }) };
  const response = await fetch(base + '/sessions', { method: 'POST', headers, body: JSON.stringify({ mentorId, startsAt, ...extra }) });
  return { status: response.status, data: await response.json() };
}
async function wallet(menteeId) { return (await app.get(WalletService).getWallet(menteeId)).totalSpendable; }
async function effects(menteeId) {
  const { rows: [row] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM sessions WHERE mentee_id=$1 AND status<>'cancelled') AS sessions,
    (SELECT count(*)::int FROM session_credit_allocations WHERE mentee_id=$1) AS allocations,
    (SELECT count(*)::int FROM ledger_entries WHERE mentee_id=$1 AND kind='BOOKING_DEBIT') AS debits,
    (SELECT count(*)::int FROM booking_requests WHERE mentee_id=$1) AS keys`, [menteeId]);
  return row;
}
const none = { sessions: 0, allocations: 0, debits: 0, keys: 0 };
const conflict = (result, code, reason) => {
  assert.equal(result.status, code === 'INVALID_SLOT' || code === 'INVALID_BOOKING_REQUEST' ? 422 : 409, JSON.stringify(result));
  assert.equal(result.data.code, code);
  if (reason) assert.deepEqual(result.data.details, { reason });
};

// Holds a row lock on an independent connection until every request is blocked inside PostgreSQL.
async function barrier(lockSql, args, requests, extraWaiters = 0) {
  const holder = new pg.Client(connectionOptions());
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(lockSql, args);
    const pending = requests.map(request => request());
    const expected = requests.length + extraWaiters;
    for (let i = 0; ; i++) {
      const { rows: [{ waiting }] } = await owner.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname=$1 AND wait_event_type='Lock'`, [database]);
      if (waiting >= expected) break;
      if (i > 400) throw Error(`only ${waiting}/${expected} transactions reached the lock`);
      await delay(10);
    }
    await holder.query('COMMIT');
    return await Promise.all(pending);
  } finally { await holder.end(); }
}
// Counts transaction attempts: with the documented lock order no request deadlocks or needs a retry,
// so a missing or reordered lock is visible even when the database still protects the balance.
function attempts(t) {
  const service = app.get(BookingService);
  const original = service.attempt.bind(service);
  const spy = t.mock.method(service, 'attempt', (...args) => original(...args));
  return () => spy.mock.callCount();
}
const lockMentee = 'SELECT 1 FROM users WHERE id=$1 FOR UPDATE';
const lockMentor = 'SELECT 1 FROM mentor_profiles WHERE mentor_id=$1 FOR UPDATE';

// ---------- happy path and ledger effects ----------
test('a booking creates one scheduled 30-minute session, one allocation and one BOOKING_DEBIT', async () => {
  const m = await mentor(), me = await mentee(1);
  const result = await book(me, m, '2030-06-03T10:00:00Z');
  assert.equal(result.status, 201);
  assert.deepEqual(result.data, { sessionId: result.data.sessionId, mentorId: m, status: 'scheduled',
    spentCreditType: 'NORMAL', startsAt: '2030-06-03T10:00:00Z', endsAt: '2030-06-03T10:30:00Z' });
  const { rows: [session] } = await pool.query('SELECT * FROM sessions WHERE id=$1', [result.data.sessionId]);
  assert.equal(session.mentee_id, me);
  assert.equal(session.mentor_id, m);
  assert.equal(session.status, 'scheduled');
  assert.equal(session.ends_at - session.starts_at, 1_800_000);
  const { rows: [allocation] } = await pool.query('SELECT * FROM session_credit_allocations WHERE session_id=$1', [session.id]);
  const { rows: debits } = await pool.query("SELECT * FROM ledger_entries WHERE session_id=$1", [session.id]);
  assert.equal(debits.length, 1);
  assert.equal(debits[0].kind, 'BOOKING_DEBIT');
  assert.equal(debits[0].delta, -1);
  assert.equal(debits[0].lot_id, allocation.lot_id);
  assert.equal(debits[0].idempotency_key, 'booking-debit:' + session.id);
  assert.equal(allocation.quantity, 1);
  assert.equal(await wallet(me), 0);
  assert.deepEqual(await effects(me), { sessions: 1, allocations: 1, debits: 1, keys: 0 });
});

test('rollover is spent before normal credit, earliest expiry first', async () => {
  const m = await mentor(), me = await mentee(2);
  const late = await rollover(me, '2031-02-01T00:00:00Z');
  const early = await rollover(me, '2031-01-01T00:00:00Z');
  const first = await book(me, m, '2030-06-03T10:00:00Z');
  const second = await book(me, m, '2030-06-03T11:00:00Z');
  const third = await book(me, m, '2030-06-03T12:00:00Z');
  assert.deepEqual([first, second, third].map(r => r.data.spentCreditType), ['ROLLOVER', 'ROLLOVER', 'NORMAL']);
  const lots = (await pool.query(`SELECT a.lot_id FROM session_credit_allocations a JOIN sessions s ON s.id=a.session_id
    WHERE a.mentee_id=$1 ORDER BY s.starts_at`, [me])).rows.map(r => r.lot_id);
  assert.deepEqual(lots.slice(0, 2), [early, late]);
  const summary = await app.get(WalletService).getWallet(me);
  assert.deepEqual([summary.normal, summary.rollover], [1, 0]);
});

test('expired rollover credit is never spent; expiry is evaluated at the transaction clock', async () => {
  const m = await mentor();
  const onlyExpired = await mentee();
  await rollover(onlyExpired, '2001-02-01T00:00:00Z', '2001-01-01T00:00:00Z');
  conflict(await book(onlyExpired, m, '2030-06-03T10:00:00Z'), 'INSUFFICIENT_CREDITS');
  assert.deepEqual(await effects(onlyExpired), none);
  const mixed = await mentee(1);
  await rollover(mixed, '2001-02-01T00:00:00Z', '2001-01-01T00:00:00Z');
  assert.equal((await book(mixed, m, '2030-06-03T11:00:00Z')).data.spentCreditType, 'NORMAL');

  // Exact boundary with the trusted test clock: valid at expiry-1ms, excluded at expiry.
  const expiry = new Date('2029-06-01T00:00:00Z');
  const service = app.get(BookingService);
  const justBefore = await mentee(1); await rollover(justBefore, expiry.toISOString());
  const atExpiry = await mentee(1); await rollover(atExpiry, expiry.toISOString());
  const slot = { mentorId: m, startsAt: '2030-06-03T12:00:00Z' };
  const r1 = await service.book(justBefore, slot, undefined, new Date(expiry.getTime() - 1));
  assert.equal(r1.booking.spentCreditType, 'ROLLOVER');
  const r2 = await service.book(atExpiry, { ...slot, mentorId: await mentor() }, undefined, expiry);
  assert.equal(r2.booking.spentCreditType, 'NORMAL');
});

test('insufficient credit, including credit offset by outstanding debt, is rejected without side effects', async () => {
  const m = await mentor();
  const broke = await mentee();
  const result = await book(broke, m, '2030-06-03T10:00:00Z');
  conflict(result, 'INSUFFICIENT_CREDITS');
  assert.deepEqual(await effects(broke), none);

  const indebted = await mentee(1);
  const refunded = await purchase(indebted, 2);
  await tx(client => ledger.appendEntry(client, { menteeId: indebted, lotId: refunded.lotId, paymentId: refunded.paymentId,
    kind: 'DEBT', delta: -3, idempotencyKey: 'purchase-debt:' + refunded.paymentId }));
  assert.equal(await wallet(indebted), 0);
  conflict(await book(indebted, m, '2030-06-03T10:00:00Z'), 'INSUFFICIENT_CREDITS');
  assert.deepEqual(await effects(indebted), none);
});

// ---------- slot validation ----------
test('slots outside availability, blocked, misaligned or in the past are rejected without spending', async () => {
  const m = await mentor('UTC', [[1, '09:00', '12:00']]); // Mondays only
  const me = await mentee(3);
  conflict(await book(me, m, '2030-06-04T10:00:00Z'), 'SLOT_UNAVAILABLE', 'OUTSIDE_AVAILABILITY'); // Tuesday
  conflict(await book(me, m, '2030-06-03T12:00:00Z'), 'SLOT_UNAVAILABLE', 'OUTSIDE_AVAILABILITY'); // ends after rule
  conflict(await book(me, m, '2030-06-03T10:15:00Z'), 'INVALID_SLOT');
  conflict(await book(me, m, '2030-06-03T10:00:30Z'), 'INVALID_SLOT');
  // Partial blockout overlap blocks; a blockout ending exactly at the slot start does not ([start,end)).
  await pool.query(`INSERT INTO availability_blockouts (mentor_id,starts_at,ends_at) VALUES
    ($1,'2030-06-03T10:20:00Z','2030-06-03T10:25:00Z'), ($1,'2030-06-03T10:30:00Z','2030-06-03T11:00:00Z')`, [m]);
  const blocked = await book(me, m, '2030-06-03T10:00:00Z');
  conflict(blocked, 'SLOT_UNAVAILABLE', 'BLOCKED');
  assert.equal(blocked.data.message, UNAVAILABLE);
  conflict(await book(me, m, '2030-06-03T10:30:00Z'), 'SLOT_UNAVAILABLE', 'BLOCKED');
  assert.equal((await book(me, m, '2030-06-03T11:00:00Z')).status, 201);
  // Inactive rules do not offer slots.
  await pool.query('UPDATE weekly_availability SET is_active=false WHERE mentor_id=$1', [m]);
  conflict(await book(me, m, '2030-06-03T09:00:00Z'), 'SLOT_UNAVAILABLE', 'OUTSIDE_AVAILABILITY');
  assert.deepEqual(await effects(me), { sessions: 1, allocations: 1, debits: 1, keys: 0 });
  assert.equal(await wallet(me), 2);

  const always = await mentor();
  const past = new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000 - 1_800_000).toISOString();
  conflict(await book(me, always, past), 'SLOT_UNAVAILABLE', 'IN_PAST');
  const current = new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000).toISOString();
  conflict(await book(me, always, current), 'SLOT_UNAVAILABLE', 'IN_PAST');
  assert.equal(await wallet(me), 2);
});

test('a booked slot rejects a second booking; cancellation frees it; one mentee cannot double-book itself', async () => {
  const m = await mentor(), a = await mentee(2), b = await mentee(2);
  const first = await book(a, m, '2030-06-03T10:00:00Z');
  assert.equal(first.status, 201);
  conflict(await book(b, m, '2030-06-03T10:00:00Z'), 'SLOT_UNAVAILABLE', 'BOOKED');
  conflict(await book(a, m, '2030-06-03T10:00:00Z'), 'SLOT_UNAVAILABLE', 'BOOKED');
  assert.deepEqual([await wallet(a), await wallet(b)], [1, 2]);
  await pool.query(`UPDATE sessions SET status='cancelled',cancelled_at=now(),cancellation_actor=mentor_id WHERE id=$1`,
    [first.data.sessionId]);
  assert.equal((await book(b, m, '2030-06-03T10:00:00Z')).status, 201);
});

test('timezone and DST: booking accepts exactly the instants the slot preview offers', async () => {
  const london = await mentor('Europe/London', [[7, '00:00', '04:00']]);
  const me = await mentee(10);
  const preview = async date => (await (await fetch(`${base}/mentors/${london}/slots?from=${date}&to=${date}`,
    { headers: { 'X-User-Id': me } })).json()).slots.map(s => s.startsAt);
  // Spring forward 2030-03-31: local 01:00-01:59 does not exist. 01:00Z is 02:00 BST.
  assert.deepEqual(await preview('2030-03-31'), ['2030-03-31T00:00:00Z', '2030-03-31T00:30:00Z', '2030-03-31T01:00:00Z',
    '2030-03-31T01:30:00Z', '2030-03-31T02:00:00Z', '2030-03-31T02:30:00Z']);
  assert.equal((await book(me, london, '2030-03-31T02:00:00+01:00')).data.startsAt, '2030-03-31T01:00:00Z');
  conflict(await book(me, london, '2030-03-31T03:00:00Z'), 'SLOT_UNAVAILABLE', 'OUTSIDE_AVAILABILITY');
  // Fall back 2030-10-27: 01:00/01:30 repeat; the policy offers the earlier (BST) occurrence only.
  const fall = await preview('2030-10-27');
  assert.ok(fall.includes('2030-10-27T00:30:00Z') && !fall.includes('2030-10-27T01:30:00Z'));
  assert.equal((await book(me, london, '2030-10-27T01:30:00+01:00')).status, 201);
  conflict(await book(me, london, '2030-10-27T01:30:00+00:00'), 'SLOT_UNAVAILABLE', 'OUTSIDE_AVAILABILITY');
  conflict(await book(me, london, '2030-10-27T01:00:00Z'), 'SLOT_UNAVAILABLE', 'OUTSIDE_AVAILABILITY');
  assert.equal((await book(me, london, '2030-10-27T02:00:00Z')).status, 201);
});

test('a slot on a different calendar day in UTC than on the mentor clock is validated by the mentor date', async () => {
  const kolkata = await mentor('Asia/Kolkata', [[1, '00:00', '02:00']]); // Mondays, local
  const me = await mentee(2, 'America/Los_Angeles');
  // Monday 2030-01-07 01:00 IST = Sunday 2030-01-06 19:30 UTC = Sunday 11:30 PST.
  const result = await book(me, kolkata, '2030-01-06T19:30:00Z');
  assert.equal(result.status, 201);
  assert.equal(result.data.startsAt, '2030-01-06T19:30:00Z');
  conflict(await book(me, kolkata, '2030-01-07T19:30:00Z'), 'SLOT_UNAVAILABLE', 'OUTSIDE_AVAILABILITY');
  const kathmandu = await mentor('Asia/Kathmandu');
  conflict(await book(me, kathmandu, '2030-01-07T04:00:00Z'), 'INVALID_SLOT'); // 09:45 local
});

// ---------- authentication and authorization ----------
test('missing identity is 401, non-mentees are 403, unknown mentors are 404; no effects', async () => {
  const m = await mentor();
  assert.equal((await book(null, m, '2030-06-03T10:00:00Z')).status, 401);
  assert.equal((await book(uuid(), m, '2030-06-03T10:00:00Z')).status, 401);
  for (const user of [seeded.mentor, seeded.admin]) {
    const result = await book(user, m, '2030-06-03T10:00:00Z');
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'FORBIDDEN');
  }
  const me = await mentee(1);
  for (const id of [uuid(), seeded.mentee, 'nope']) assert.equal((await book(me, id, '2030-06-03T10:00:00Z')).data.code, 'MENTOR_NOT_FOUND');
  conflict(await book(me, m, '2030-06-03T10:00:00Z', undefined, { menteeId: seeded.mentee }), 'INVALID_BOOKING_REQUEST');
  assert.deepEqual(await effects(me), none);
  assert.deepEqual(await effects(seeded.mentee), none);
});

// ---------- concurrency (real overlapping transactions) ----------
test('two mentees racing for the same slot: exactly one 201, one 409, one session, one debit', async t => {
  const m = await mentor(), a = await mentee(1), b = await mentee(1);
  const tries = attempts(t);
  const results = await barrier(lockMentor, [m], [a, b].map(user => () => book(user, m, '2030-06-03T10:00:00Z')));
  assert.equal(tries(), 2, 'no retries');
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const loser = results.find(r => r.status === 409);
  conflict(loser, 'SLOT_UNAVAILABLE', 'BOOKED');
  assert.equal(loser.data.message, UNAVAILABLE);
  const { rows: [{ count }] } = await pool.query("SELECT count(*)::int FROM sessions WHERE mentor_id=$1 AND status<>'cancelled'", [m]);
  assert.equal(count, 1);
  const totals = [await effects(a), await effects(b)];
  assert.equal(totals.reduce((n, e) => n + e.debits, 0), 1);
  assert.equal(totals.reduce((n, e) => n + e.allocations, 0), 1);
  assert.deepEqual(await Promise.all([wallet(a), wallet(b)]), results.map(r => r.status === 201 ? 0 : 1));
  assert.deepEqual(totals, results.map(r => r.status === 201 ? { ...none, sessions: 1, allocations: 1, debits: 1 } : none));
});

test('ten mentees racing for one slot still produce exactly one booking', async t => {
  const m = await mentor();
  const users = await Promise.all(Array.from({ length: 10 }, () => mentee(1)));
  const tries = attempts(t);
  const results = await barrier(lockMentor, [m], users.map(user => () => book(user, m, '2030-06-03T10:00:00Z')));
  assert.equal(tries(), 10, 'no retries');
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 409 && r.data.code === 'SLOT_UNAVAILABLE').length, 9);
  const { rows: [{ debits }] } = await pool.query(`SELECT count(*)::int AS debits FROM ledger_entries e
    JOIN sessions s ON s.id=e.session_id WHERE s.mentor_id=$1 AND e.kind='BOOKING_DEBIT'`, [m]);
  assert.equal(debits, 1);
});

test('last credit: two concurrent bookings of different mentors and times, exactly one succeeds', async t => {
  const [m1, m2] = [await mentor(), await mentor()];
  const me = await mentee(1);
  const tries = attempts(t);
  const results = await barrier(lockMentee, [me], [
    () => book(me, m1, '2030-06-03T10:00:00Z'), () => book(me, m2, '2030-06-03T14:00:00Z')]);
  assert.equal(tries(), 2, 'no deadlock or retry');
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  conflict(results.find(r => r.status === 409), 'INSUFFICIENT_CREDITS');
  assert.deepEqual(await effects(me), { sessions: 1, allocations: 1, debits: 1, keys: 0 });
  assert.equal(await wallet(me), 0);
  const { rows: [{ remaining }] } = await pool.query('SELECT SUM(delta)::int AS remaining FROM ledger_entries WHERE mentee_id=$1', [me]);
  assert.equal(remaining, 0);
});

test('a mentee cannot hold overlapping sessions with different mentors, sequentially or concurrently', async t => {
  const [m1, m2] = [await mentor(), await mentor()];
  const me = await mentee(4);
  assert.equal((await book(me, m1, '2030-06-03T10:00:00Z')).status, 201);
  conflict(await book(me, m2, '2030-06-03T10:00:00Z'), 'SESSION_OVERLAP');
  // Partial overlap: a +05:45 mentor's 09:30 local slot is 03:45-04:15Z and overlaps 03:30-04:00Z.
  const nepal = await mentor('Asia/Kathmandu');
  assert.equal((await book(me, m1, '2030-06-03T03:30:00Z')).status, 201);
  conflict(await book(me, nepal, '2030-06-03T03:45:00Z'), 'SESSION_OVERLAP');
  assert.equal(await wallet(me), 2);

  const other = await mentee(2);
  const tries = attempts(t);
  const results = await barrier(lockMentee, [other], [
    () => book(other, m1, '2030-06-05T10:00:00Z'), () => book(other, m2, '2030-06-05T10:00:00Z')]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(tries(), 2, 'no deadlock or retry');
  conflict(results.find(r => r.status === 409), 'SESSION_OVERLAP');
  assert.deepEqual(await effects(other), { sessions: 1, allocations: 1, debits: 1, keys: 0 });
  assert.equal(await wallet(other), 1);
});

test('blockout vs booking race: a committed blockout is honoured; a committed booking rejects the blockout', async () => {
  // (a) A mentor edit holds the mentor lock with an uncommitted blockout; the booking waits, then rechecks.
  const m = await mentor(), me = await mentee(2);
  const editor = new pg.Client(connectionOptions());
  await editor.connect();
  await editor.query('BEGIN');
  await editor.query(lockMentor, [m]);
  await editor.query(`INSERT INTO availability_blockouts (mentor_id,starts_at,ends_at) VALUES ($1,'2030-06-03T10:00:00Z','2030-06-03T11:00:00Z')`, [m]);
  const pending = book(me, m, '2030-06-03T10:00:00Z');
  for (let i = 0; ; i++) {
    const { rows: [{ waiting }] } = await owner.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname=$1 AND wait_event_type='Lock'`, [database]);
    if (waiting >= 1) break;
    if (i > 400) throw Error('booking never waited for the mentor lock');
    await delay(10);
  }
  await editor.query('COMMIT');
  await editor.end();
  conflict(await pending, 'SLOT_UNAVAILABLE', 'BLOCKED');
  assert.deepEqual(await effects(me), none);
  assert.equal(await wallet(me), 2);

  // (b) A committed booking makes the US-05 blockout endpoint reject an overlapping blockout.
  const booked = await book(me, m, '2030-06-03T12:00:00Z');
  assert.equal(booked.status, 201);
  const block = await fetch(base + '/mentor/blockouts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': m },
    body: JSON.stringify({ startsAt: '2030-06-03T12:15:00Z', endsAt: '2030-06-03T13:00:00Z' }) });
  assert.equal(block.status, 409);
  assert.deepEqual((await block.json()).sessionIds, [booked.data.sessionId]);

  // (c) Truly concurrent booking and blockout API calls: exactly one wins, never both.
  for (let round = 0; round < 5; round++) {
    const mentorId = await mentor(), user = await mentee(1);
    const [booking, blockout] = await barrier(lockMentor, [mentorId], [
      () => book(user, mentorId, '2030-06-03T10:00:00Z'),
      () => fetch(base + '/mentor/blockouts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': mentorId },
        body: JSON.stringify({ startsAt: '2030-06-03T10:00:00Z', endsAt: '2030-06-03T10:30:00Z' }) }).then(r => ({ status: r.status }))]);
    assert.deepEqual([booking.status, blockout.status].sort(), [201, 409], `round ${round}`);
    if (booking.status === 409) {
      conflict(booking, 'SLOT_UNAVAILABLE', 'BLOCKED');
      assert.deepEqual(await effects(user), none);
    }
    const { rows: [{ violations }] } = await pool.query(`SELECT count(*)::int AS violations FROM sessions s
      JOIN availability_blockouts b ON b.mentor_id=s.mentor_id AND b.starts_at < s.ends_at AND b.ends_at > s.starts_at
      WHERE s.mentor_id=$1 AND s.status<>'cancelled'`, [mentorId]);
    assert.equal(violations, 0);
  }
});

test('a concurrent uncommitted session insert blocks the booking via FK key-share locks; it then rejects', async () => {
  const m = await mentor(), me = await mentee(1), rogue = await mentee();
  const writer = new pg.Client(connectionOptions());
  await writer.connect();
  await writer.query('BEGIN');
  // The writer takes no explicit lock, but its FK check holds KEY SHARE on the mentor profile row,
  // which conflicts with the booking's FOR UPDATE: the booking waits, then sees the committed row.
  await writer.query(`INSERT INTO sessions (mentor_id,mentee_id,starts_at,ends_at) VALUES ($1,$2,'2030-06-03T10:00:00Z','2030-06-03T10:30:00Z')`, [m, rogue]);
  const pending = book(me, m, '2030-06-03T10:00:00Z');
  for (let i = 0; ; i++) {
    const { rows: [{ waiting }] } = await owner.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname=$1 AND wait_event_type='Lock'`, [database]);
    if (waiting >= 1) break;
    if (i > 400) throw Error('booking never waited for the concurrent writer');
    await delay(10);
  }
  await writer.query('COMMIT');
  await writer.end();
  const result = await pending;
  conflict(result, 'SLOT_UNAVAILABLE', 'BOOKED');
  assert.deepEqual(await effects(me), none);
  assert.equal(await wallet(me), 1);
  const { rows } = await pool.query("SELECT conname FROM pg_constraint WHERE conname IN ('sessions_mentor_overlap','sessions_mentee_overlap') ORDER BY 1");
  assert.deepEqual(rows.map(r => r.conname), ['sessions_mentee_overlap', 'sessions_mentor_overlap']);
});

test('if the application checks were ever bypassed, the exclusion constraint rejects and everything rolls back', async t => {
  // Simulate a check-then-insert gap: after all checks pass, a conflicting row appears in the same
  // transaction. PostgreSQL raises 23P01 on the booking's own INSERT; it is mapped and rolled back.
  for (const [constraint, expected] of [['mentor', 'SLOT_UNAVAILABLE'], ['mentee', 'SESSION_OVERLAP']]) {
    const m = await mentor(), other = await mentor(), me = await mentee(1), rogue = await mentee();
    const service = app.get(RolloverService);
    const select = service.selectSpendableLot.bind(service);
    const gap = t.mock.method(service, 'selectSpendableLot', async (client, ...args) => {
      const [mentorId, menteeId] = constraint === 'mentor' ? [m, rogue] : [other, me];
      await client.query(`INSERT INTO sessions (mentor_id,mentee_id,starts_at,ends_at)
        VALUES ($1,$2,'2030-06-03T10:00:00Z','2030-06-03T10:30:00Z')`, [mentorId, menteeId]);
      return select(client, ...args);
    });
    const result = await book(me, m, '2030-06-03T10:00:00Z', 'gap-' + constraint);
    gap.mock.restore();
    conflict(result, expected);
    assert.deepEqual(await effects(me), none);
    assert.deepEqual(await effects(rogue), none);
    assert.equal(await wallet(me), 1);
  }
});

// ---------- idempotency ----------
test('identical replay returns the original booking with 200 and no second debit', async () => {
  const m = await mentor(), me = await mentee(3);
  const first = await book(me, m, '2030-06-03T10:00:00Z', 'attempt-1');
  assert.equal(first.status, 201);
  const again = await book(me, m, '2030-06-03T12:00:00+02:00', 'attempt-1'); // same instant, other spelling
  assert.deepEqual(again, { status: 200, data: first.data });
  assert.deepEqual(await effects(me), { sessions: 1, allocations: 1, debits: 1, keys: 1 });
  assert.equal(await wallet(me), 2);
  // Replay still answers after cancellation, reporting the current status, and never re-books.
  await pool.query(`UPDATE sessions SET status='cancelled',cancelled_at=now(),cancellation_actor=mentee_id WHERE id=$1`, [first.data.sessionId]);
  assert.deepEqual(await book(me, m, '2030-06-03T10:00:00Z', 'attempt-1'), { status: 200, data: { ...first.data, status: 'cancelled' } });
  assert.equal((await effects(me)).debits, 1);
});

test('reusing a key for a different booking is 409; keys are scoped per mentee', async () => {
  const [m1, m2] = [await mentor(), await mentor()];
  const me = await mentee(3);
  assert.equal((await book(me, m1, '2030-06-03T10:00:00Z', 'k')).status, 201);
  for (const [mentorId, startsAt] of [[m1, '2030-06-03T11:00:00Z'], [m2, '2030-06-03T10:00:00Z']]) {
    const result = await book(me, mentorId, startsAt, 'k');
    assert.equal(result.status, 409);
    assert.equal(result.data.code, 'IDEMPOTENCY_CONFLICT');
  }
  assert.deepEqual(await effects(me), { sessions: 1, allocations: 1, debits: 1, keys: 1 });
  const other = await mentee(1);
  assert.equal((await book(other, m2, '2030-06-03T10:00:00Z', 'k')).status, 201);
});

test('concurrent retries with one key create one session and one debit', async t => {
  const m = await mentor(), me = await mentee(5);
  const tries = attempts(t);
  const results = await barrier(lockMentee, [me], Array.from({ length: 5 }, () => () => book(me, m, '2030-06-03T10:00:00Z', 'double-click')));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map(r => r.data.sessionId)).size, 1);
  assert.equal(tries(), 5, 'no deadlock or retry');
  assert.deepEqual(await effects(me), { sessions: 1, allocations: 1, debits: 1, keys: 1 });
  assert.equal(await wallet(me), 4);
});

test('a failed attempt stores no key, so the same key can be retried once the cause is fixed', async () => {
  const m = await mentor(), me = await mentee();
  conflict(await book(me, m, '2030-06-03T10:00:00Z', 'after-top-up'), 'INSUFFICIENT_CREDITS');
  assert.deepEqual(await effects(me), none);
  await purchase(me, 1);
  assert.equal((await book(me, m, '2030-06-03T10:00:00Z', 'after-top-up')).status, 201);
});

// ---------- atomicity under injected failures ----------
test('a failure after the session insert rolls back everything', async t => {
  const m = await mentor(), me = await mentee(1);
  const fail = t.mock.method(ledger, 'appendEntry', async () => { throw Error('test-only failure before debit'); });
  const result = await book(me, m, '2030-06-03T10:00:00Z', 'crash-1');
  fail.mock.restore();
  assert.equal(result.status, 500);
  assert.deepEqual(result.data, { code: 'BOOKING_FAILED', message: 'Booking could not be completed. Please retry.' });
  assert.deepEqual(await effects(me), none);
  const { rows: [{ count }] } = await pool.query('SELECT count(*)::int FROM sessions WHERE mentor_id=$1', [m]);
  assert.equal(count, 0);
  assert.equal((await book(me, m, '2030-06-03T10:00:00Z', 'crash-1')).status, 201);
});

test('a failure after the ledger debit rolls back session, allocation, debit and key', async t => {
  const m = await mentor(), me = await mentee(1);
  const append = ledger.appendEntry.bind(ledger);
  const fail = t.mock.method(ledger, 'appendEntry', async (...args) => {
    const entry = await append(...args);
    if (args[1].kind === 'BOOKING_DEBIT') throw Error('test-only failure after debit');
    return entry;
  });
  const result = await book(me, m, '2030-06-03T10:00:00Z', 'crash-2');
  fail.mock.restore();
  assert.equal(result.status, 500);
  assert.equal(result.data.code, 'BOOKING_FAILED');
  assert.doesNotMatch(JSON.stringify(result.data), /test-only|sql|constraint|stack/i);
  assert.deepEqual(await effects(me), none);
  assert.equal(await wallet(me), 1);
  const retry = await book(me, m, '2030-06-03T10:00:00Z', 'crash-2');
  assert.equal(retry.status, 201);
  assert.deepEqual(await effects(me), { sessions: 1, allocations: 1, debits: 1, keys: 1 });
});

test('competing payloads for one key persist only the winning UTC slot and replay its receipt', async () => {
  const m = await mentor(), me = await mentee(2), key = uuid();
  const starts = ['2090-01-09T10:00:00Z', '2090-01-09T11:00:00Z'];
  const results = await barrier(lockMentee, [me], starts.map(start => () => book(me, m, start, key)));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const winner = results.findIndex(r => r.status === 201);
  assert.equal(results[1-winner].data.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(results[winner].data.startsAt, starts[winner]);
  assert.deepEqual(await book(me, m, starts[winner], key), { status: 200, data: results[winner].data });
  assert.deepEqual(await effects(me), { sessions: 1, allocations: 1, debits: 1, keys: 1 });
  assert.equal(await wallet(me), 1);
});

test('mentor timezone change invalidates a stale UTC preview while viewer timezone only changes labels', async () => {
  const m = await mentor('Asia/Kolkata', allWeek.map(([weekday]) => [weekday, '09:00', '09:30']));
  const me = await mentee(1, 'America/Los_Angeles');
  async function preview() {
    const response = await fetch(base+'/mentors/'+m+'/slots?from=2090-01-15&to=2090-01-15', { headers: { 'X-User-Id': me } });
    assert.equal(response.status, 200);
    const { slots } = await response.json();
    assert.equal(slots.length, 1);
    return slots[0];
  }
  const old = await preview();
  assert.equal(old.localStartsAt, '2090-01-14T19:30:00-08:00');
  await pool.query("UPDATE users SET timezone='Europe/London' WHERE id=$1", [m]);
  conflict(await book(me, m, old.startsAt), 'SLOT_UNAVAILABLE', 'OUTSIDE_AVAILABILITY');
  assert.deepEqual(await effects(me), none);
  const fresh = await preview();
  await pool.query("UPDATE users SET timezone='Asia/Kolkata' WHERE id=$1", [me]);
  const relabelled = await preview();
  assert.equal(relabelled.startsAt, fresh.startsAt);
  assert.equal(relabelled.localStartsAt, '2090-01-15T14:30:00+05:30');
  const result = await book(me, m, fresh.startsAt);
  assert.equal(result.status, 201);
  assert.equal(result.data.startsAt, '2090-01-15T09:00:00Z');
  assert.equal(await wallet(me), 0);
});

// ---------- global invariants (run last) ----------
test('ledger invariants hold across every booking in this suite; no mutable balance exists', async () => {
  const { rows: [check] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM ledger_entries e WHERE e.kind='BOOKING_DEBIT' AND NOT EXISTS (
      SELECT FROM session_credit_allocations a WHERE a.session_id=e.session_id AND a.lot_id=e.lot_id)) AS debit_without_allocation,
    (SELECT count(*)::int FROM session_credit_allocations a WHERE (SELECT count(*) FROM ledger_entries e
      WHERE e.session_id=a.session_id AND e.kind='BOOKING_DEBIT') <> 1) AS allocation_without_single_debit,
    (SELECT count(*)::int FROM booking_requests r WHERE NOT EXISTS (
      SELECT FROM session_credit_allocations a WHERE a.session_id=r.session_id)) AS key_without_booking,
    (SELECT count(*)::int FROM (SELECT lot_id FROM ledger_entries GROUP BY lot_id
      HAVING SUM(delta) < 0 AND bool_and(kind NOT IN ('DEBT'))) negative) AS overspent_lots`);
  assert.deepEqual(check, { debit_without_allocation: 0, allocation_without_single_debit: 0, key_without_booking: 0, overspent_lots: 0 });
  const { rows: balances } = await pool.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name ILIKE '%balance%'`);
  assert.deepEqual(balances, []);
  const { rows: [grants] } = await pool.query(`SELECT
    bool_or(has_table_privilege(t, 'UPDATE') OR has_table_privilege(t, 'DELETE')) AS mutable
    FROM unnest(ARRAY['ledger_entries','credit_lots','session_credit_allocations','booking_requests']) AS t`);
  assert.equal(grants.mutable, false);
});
