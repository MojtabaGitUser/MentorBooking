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
import { CancellationService } from '../dist/sessions/cancellation.service.js';
import { MentorCancellationService } from '../dist/sessions/mentor-cancellation.service.js';
import { LifecycleService } from '../dist/sessions/lifecycle.service.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

const database = 'lifecycle_test_' + uuid().replaceAll('-', '');
const owner = new pg.Client({ ...connectionOptions(), database: 'postgres' });
const ADMIN = '00000000-0000-4000-8000-000000000005';
const MIN = 60_000, H = 60 * MIN;
const START = '2030-06-03T14:00:00Z';
const start = Date.parse(START);
const at = ms => new Date(start + ms);
const END = 30 * MIN, DUE = END + 5 * MIN;
let app, base, pool, ledger, bookings, lifecycle, created;

before(async () => {
  assert.ok(!process.env.DATABASE_URL, 'Use the bundled PostgreSQL server for lifecycle tests');
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
  lifecycle = app.get(LifecycleService);
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
  await pool.query('INSERT INTO users (id,role,display_name,timezone) VALUES ($1,$2,$3,$4)', [id, role, role + ' ' + id.slice(0, 4), timezone]);
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
  return lot.id;
}
// A real US-11 booking (credit debited), at START unless told otherwise.
async function booked({ credits = 1, startsAt = START } = {}) {
  const mentorId = await user('mentor'), menteeId = await user('mentee', 'America/Vancouver');
  const lotId = await purchase(menteeId, credits);
  const { booking } = await bookings.book(menteeId, { mentorId, startsAt });
  return { mentorId, menteeId, lotId, sessionId: booking.sessionId, startsAt: Date.parse(startsAt) };
}
// A raw session around the real clock, for HTTP join tests (join needs no credit).
async function live(offsetMs = -MIN) {
  const mentorId = await user('mentor'), menteeId = await user('mentee');
  const startsAt = new Date(Date.now() + offsetMs);
  const { rows: [s] } = await pool.query(`INSERT INTO sessions (mentor_id,mentee_id,starts_at,ends_at)
    VALUES ($1,$2,$3,$3::timestamptz+interval '30 minutes') RETURNING id`, [mentorId, menteeId, startsAt]);
  return { mentorId, menteeId, sessionId: s.id };
}

// ---------- helpers ----------
async function http(method, path, userId, body) {
  const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(userId && { 'X-User-Id': userId }) } });
  return { status: response.status, data: await response.json() };
}
const participant = (id, role) => ({ id, role, displayName: role, timezone: 'UTC' });
const joinAs = (s, role, now) => lifecycle.join(participant(role === 'mentor' ? s.mentorId : s.menteeId, role), s.sessionId, now);
async function failure(promise) {
  try { await promise; } catch (error) { return [error.getStatus(), error.getResponse().code]; }
  return null;
}
async function row(id) {
  return (await pool.query(`SELECT status, joined_mentor_at, joined_mentee_at, completed_at FROM sessions WHERE id=$1`, [id])).rows[0];
}
async function credits(s) {
  const { rows: [r] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM credit_lots WHERE session_id=$1 AND credit_type='ROLLOVER') AS "rolloverLots",
    (SELECT count(*)::int FROM ledger_entries WHERE session_id=$1 AND kind='NO_SHOW_ROLLOVER') AS "noShowGrants",
    (SELECT count(*)::int FROM ledger_entries WHERE session_id=$1 AND kind IN ('MENTOR_REFUND','CANCELLATION_REFUND')) AS refunds,
    (SELECT count(*)::int FROM ledger_entries WHERE session_id=$1 AND kind='BOOKING_DEBIT') AS debits`, [s.sessionId]);
  return r;
}
const wallet = id => app.get(WalletService).getWallet(id);
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
    const pending = requests.map(request => request().then(value => ({ value }), error => ({ error })));
    await waitForLockWaiters(requests.length);
    await holder.query('COMMIT');
    return await Promise.all(pending);
  } finally { await holder.end(); }
}

// ================= join and attendance =================
test('mentee and mentor join over HTTP; the role comes from the session, the body is ignored', async () => {
  const s = await live(-MIN);
  const mentee = await http('POST', `/sessions/${s.sessionId}/join`, s.menteeId, { role: 'mentor', userId: s.mentorId });
  assert.equal(mentee.status, 200);
  assert.deepEqual([mentee.data.role, mentee.data.status, mentee.data.alreadyJoined], ['mentee', 'in_progress', false]);
  const mentor = await http('POST', `/sessions/${s.sessionId}/join`, s.mentorId);
  assert.deepEqual([mentor.status, mentor.data.role, mentor.data.alreadyJoined], [200, 'mentor', false]);
  const r = await row(s.sessionId);
  assert.ok(r.joined_mentee_at && r.joined_mentor_at);
  assert.equal(r.joined_mentee_at.toISOString(), mentee.data.joinedAt);
  assert.ok(Math.abs(r.joined_mentee_at - Date.now()) < 60_000, 'server clock, not client input');
});

test('join window: opens exactly 5 minutes early, an instant earlier is rejected, closes at the end', async () => {
  const s = await booked();
  assert.deepEqual(await failure(joinAs(s, 'mentee', at(-5 * MIN - 1))), [409, 'JOIN_WINDOW_NOT_OPEN']);
  assert.equal((await row(s.sessionId)).joined_mentee_at, null);
  const early = await joinAs(s, 'mentee', at(-5 * MIN));
  assert.deepEqual([early.status, early.joinedAt], ['scheduled', at(-5 * MIN).toISOString()]);
  assert.equal((await row(s.sessionId)).status, 'scheduled', 'an early join never starts the session');
  const mentor = await joinAs(s, 'mentor', at(0));
  assert.deepEqual([mentor.status, mentor.joinedAt], ['in_progress', at(0).toISOString()]);
  const t = await booked({ startsAt: '2030-06-03T16:00:00Z' });
  assert.deepEqual(await failure(lifecycle.join(participant(t.menteeId, 'mentee'), t.sessionId, new Date(t.startsAt + END))), [409, 'JOIN_WINDOW_CLOSED']);
});

test('repeated joins keep the first timestamp; an early join does not block mentee cancellation', async () => {
  const s = await booked();
  const first = await joinAs(s, 'mentor', at(-4 * MIN));
  const again = await joinAs(s, 'mentor', at(-2 * MIN));
  assert.deepEqual([again.joinedAt, again.alreadyJoined, first.alreadyJoined], [first.joinedAt, true, false]);
  assert.equal((await row(s.sessionId)).joined_mentor_at.toISOString(), first.joinedAt);
  // A retry after the official start also keeps the first timestamp (and performs the due start).
  const t = await booked({ startsAt: '2030-06-03T18:00:00Z' });
  const early = await lifecycle.join(participant(t.mentorId, 'mentor'), t.sessionId, new Date(t.startsAt - 4 * MIN));
  const later = await lifecycle.join(participant(t.mentorId, 'mentor'), t.sessionId, new Date(t.startsAt + 10 * MIN));
  assert.deepEqual([later.joinedAt, later.alreadyJoined, later.status], [early.joinedAt, true, 'in_progress']);
  const cancelled = await app.get(CancellationService).cancel(participant(s.menteeId, 'mentee'), s.sessionId,
    { expectedRefundableCredits: 0 }, at(-MIN));
  assert.equal(cancelled.status, 'cancelled');
});

test('both participants joining concurrently on independent connections record both timestamps', async () => {
  const s = await live(-MIN);
  const results = await barrier('SELECT 1 FROM sessions WHERE id=$1 FOR UPDATE', [s.sessionId], [
    () => http('POST', `/sessions/${s.sessionId}/join`, s.menteeId), () => http('POST', `/sessions/${s.sessionId}/join`, s.mentorId)]);
  assert.deepEqual(results.map(r => r.value.status), [200, 200]);
  const r = await row(s.sessionId);
  assert.ok(r.joined_mentee_at && r.joined_mentor_at);
  assert.equal(r.status, 'in_progress');
});

test('only the two participants may join; unknown, cancelled and finished sessions are rejected', async () => {
  const s = await live(-MIN);
  const [otherMentee, otherMentor] = [await user('mentee'), await user('mentor')];
  for (const [by, status, code] of [[otherMentee, 403, 'FORBIDDEN'], [otherMentor, 403, 'FORBIDDEN'], [ADMIN, 403, 'FORBIDDEN'], [null, 401, 'USER_NOT_FOUND']]) {
    const result = await http('POST', `/sessions/${s.sessionId}/join`, by);
    assert.deepEqual([result.status, result.data.code], [status, code]);
  }
  for (const id of [uuid(), 'nope']) assert.equal((await http('POST', `/sessions/${id}/join`, s.menteeId)).data.code, 'SESSION_NOT_FOUND');
  const r = await row(s.sessionId);
  assert.deepEqual([r.status, r.joined_mentee_at, r.joined_mentor_at], ['scheduled', null, null]);
  for (const status of ['cancelled', 'completed', 'no_show_mentee', 'no_show_mentor']) {
    const t = await live(-MIN);
    await pool.query(`UPDATE sessions SET status=$2::text::session_status, cancelled_at=CASE WHEN $2::text='cancelled' THEN now() END,
      cancellation_actor=CASE WHEN $2::text='cancelled' THEN mentor_id END WHERE id=$1`, [t.sessionId, status]);
    const result = await http('POST', `/sessions/${t.sessionId}/join`, t.menteeId);
    assert.deepEqual([result.status, result.data.code, result.data.details], [409, 'SESSION_NOT_JOINABLE', { status }]);
  }
});

// ================= start and resolution =================
test('worker start tick: nothing before the official start, scheduled -> in_progress at it, once', async () => {
  const a = await booked({ startsAt: '2028-01-10T10:00:00Z' });
  const b = await booked({ startsAt: '2028-01-10T10:30:00Z' });
  await joinAs(a, 'mentee', new Date(a.startsAt - 3 * MIN));
  // Other tests create sessions around the real clock; only this test's sessions are asserted.
  const mine = result => result.started.filter(id => [a.sessionId, b.sessionId].includes(id));
  assert.deepEqual(mine(await lifecycle.startDue({ now: new Date(a.startsAt - 1) })), []);
  assert.deepEqual(mine(await lifecycle.startDue({ now: new Date(a.startsAt) })), [a.sessionId]);
  assert.deepEqual(mine(await lifecycle.startDue({ now: new Date(a.startsAt) })), []);
  const ra = await row(a.sessionId);
  assert.deepEqual([ra.status, ra.joined_mentee_at.toISOString()], ['in_progress', new Date(a.startsAt - 3 * MIN).toISOString()]);
  assert.equal((await row(b.sessionId)).status, 'scheduled');
});

test('resolution: both joined -> completed with no credit change; nothing resolves before end + 5 min', async () => {
  const s = await booked();
  await joinAs(s, 'mentee', at(-MIN));
  await joinAs(s, 'mentor', at(MIN));
  assert.equal(await lifecycle.resolveSession(s.sessionId, at(DUE - 1)), null);
  assert.deepEqual(await lifecycle.resolveSession(s.sessionId, at(DUE)), { sessionId: s.sessionId, outcome: 'completed' });
  const r = await row(s.sessionId);
  assert.deepEqual([r.status, r.completed_at.toISOString()], ['completed', at(DUE).toISOString()]);
  assert.deepEqual(await credits(s), { rolloverLots: 0, noShowGrants: 0, refunds: 0, debits: 1 });
  assert.equal((await wallet(s.menteeId)).totalSpendable, 0);
});

test('mentee no-show (mentor only, or nobody) keeps the consumed credit and grants nothing', async () => {
  for (const joined of [['mentor'], []]) {
    const s = await booked();
    for (const role of joined) await joinAs(s, role, at(0));
    assert.equal((await lifecycle.resolveSession(s.sessionId, at(DUE))).outcome, 'no_show_mentee');
    assert.deepEqual(await credits(s), { rolloverLots: 0, noShowGrants: 0, refunds: 0, debits: 1 });
    assert.equal((await wallet(s.menteeId)).totalSpendable, 0);
  }
});

test('mentor no-show grants exactly one 30-day rollover lot and one NO_SHOW_ROLLOVER, spent before normal credit', async () => {
  const s = await booked({ credits: 2 });
  await joinAs(s, 'mentee', at(2 * MIN));
  const awardedAt = at(DUE + 7 * MIN);
  assert.deepEqual(await lifecycle.resolveSession(s.sessionId, awardedAt), { sessionId: s.sessionId, outcome: 'no_show_mentor' });
  assert.deepEqual(await credits(s), { rolloverLots: 1, noShowGrants: 1, refunds: 0, debits: 1 });
  const { rows: [lot] } = await pool.query(`SELECT id, original_quantity, expires_at, session_id FROM credit_lots
    WHERE session_id=$1 AND credit_type='ROLLOVER'`, [s.sessionId]);
  assert.deepEqual([lot.original_quantity, lot.session_id], [1, s.sessionId]);
  assert.equal(lot.expires_at - awardedAt, 30 * 24 * H);
  const { rows: [grant] } = await pool.query("SELECT * FROM ledger_entries WHERE session_id=$1 AND kind='NO_SHOW_ROLLOVER'", [s.sessionId]);
  assert.deepEqual([grant.delta, grant.lot_id, grant.idempotency_key], [1, lot.id, 'mentor-no-show:' + s.sessionId]);
  // The booking debit is untouched; the new rollover is spendable now and spent first.
  const { rows: [debit] } = await pool.query("SELECT lot_id, delta FROM ledger_entries WHERE session_id=$1 AND kind='BOOKING_DEBIT'", [s.sessionId]);
  assert.deepEqual([debit.lot_id, debit.delta], [s.lotId, -1]);
  const w = await wallet(s.menteeId);
  assert.deepEqual([w.normal, w.rollover], [1, 1]);
  const { booking } = await bookings.book(s.menteeId, { mentorId: await user('mentor'), startsAt: '2030-06-05T10:00:00Z' });
  assert.equal(booking.spentCreditType, 'ROLLOVER');
  // Expiry: spendable 1 ms before, not at, exactly 30 days.
  const t = await booked();
  await joinAs(t, 'mentee', at(0));
  await lifecycle.resolveSession(t.sessionId, at(DUE));
  const expires = new Date(at(DUE).getTime() + 30 * 24 * H);
  assert.equal((await app.get(WalletService).getWallet(t.menteeId, new Date(expires - 1))).rollover, 1);
  assert.equal((await app.get(WalletService).getWallet(t.menteeId, expires)).rollover, 0);
});

test('repeated and concurrent no-show resolution grant at most once', async () => {
  const s = await booked();
  await joinAs(s, 'mentee', at(0));
  await lifecycle.resolveSession(s.sessionId, at(DUE));
  assert.equal(await lifecycle.resolveSession(s.sessionId, at(DUE + H)), null);
  assert.deepEqual(await credits(s), { rolloverLots: 1, noShowGrants: 1, refunds: 0, debits: 1 });

  const c = await booked();
  await joinAs(c, 'mentee', at(0));
  const results = await barrier('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [c.menteeId],
    Array.from({ length: 4 }, () => () => lifecycle.resolveSession(c.sessionId, at(DUE))));
  assert.deepEqual(results.filter(r => r.error), [], 'no resolver may fail');
  assert.deepEqual(results.map(r => r.value?.outcome ?? 'none').sort(), ['no_show_mentor', 'none', 'none', 'none']);
  assert.deepEqual(await credits(c), { rolloverLots: 1, noShowGrants: 1, refunds: 0, debits: 1 });
});

test('mentor cancellation vs no-show resolution: one outcome, never both MENTOR_REFUND and NO_SHOW_ROLLOVER', async () => {
  const outcomes = new Set();
  for (let round = 0; round < 6; round++) {
    const s = await booked();
    await joinAs(s, 'mentee', at(0));
    const requests = [() => app.get(MentorCancellationService).cancel(participant(s.mentorId, 'mentor'), s.sessionId, undefined, at(DUE)),
      () => lifecycle.resolveSession(s.sessionId, at(DUE))];
    if (round % 2) requests.reverse();
    const results = await barrier('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [s.menteeId], requests);
    // The only acceptable failure is the mentor losing to a committed no-show.
    for (const r of results.filter(r => r.error)) assert.equal(r.error.getResponse?.().code, 'SESSION_NOT_CANCELLABLE', String(r.error));
    const status = (await row(s.sessionId)).status;
    const c = await credits(s);
    outcomes.add(status);
    if (status === 'cancelled') assert.deepEqual(c, { rolloverLots: 0, noShowGrants: 0, refunds: 1, debits: 1 });
    else assert.deepEqual([status, c], ['no_show_mentor', { rolloverLots: 1, noShowGrants: 1, refunds: 0, debits: 1 }]);
    assert.equal((await wallet(s.menteeId)).totalSpendable, 1);
  }
  // Lock-queue order is not deterministic, so both orders are also pinned explicitly.
  const cancelFirst = await booked();
  await joinAs(cancelFirst, 'mentee', at(0));
  await app.get(MentorCancellationService).cancel(participant(cancelFirst.mentorId, 'mentor'), cancelFirst.sessionId, undefined, at(DUE));
  assert.equal(await lifecycle.resolveSession(cancelFirst.sessionId, at(DUE)), null);
  assert.deepEqual(await credits(cancelFirst), { rolloverLots: 0, noShowGrants: 0, refunds: 1, debits: 1 });
  const resolveFirst = await booked();
  await joinAs(resolveFirst, 'mentee', at(0));
  await lifecycle.resolveSession(resolveFirst.sessionId, at(DUE));
  assert.deepEqual(await failure(app.get(MentorCancellationService).cancel(participant(resolveFirst.mentorId, 'mentor'),
    resolveFirst.sessionId, undefined, at(DUE))), [409, 'SESSION_NOT_CANCELLABLE']);
  assert.deepEqual(await credits(resolveFirst), { rolloverLots: 1, noShowGrants: 1, refunds: 0, debits: 1 });
});

test('mentee cancellation vs the start tick: a locked session is skipped, a cancellation is never overwritten', async () => {
  const s = await booked({ startsAt: '2028-02-10T10:00:00Z' });
  const canceller = new pg.Client(connectionOptions());
  await canceller.connect();
  await canceller.query('BEGIN');
  await canceller.query('SELECT 1 FROM sessions WHERE id=$1 FOR UPDATE', [s.sessionId]);
  // The start tick does not wait for, or overwrite, a session held by a cancellation in flight.
  assert.equal((await lifecycle.startDue({ now: new Date(s.startsAt) })).started.includes(s.sessionId), false);
  await canceller.query(`UPDATE sessions SET status='cancelled', cancelled_at=now(), cancellation_actor=mentee_id WHERE id=$1`, [s.sessionId]);
  await canceller.query('COMMIT');
  await canceller.end();
  assert.equal((await lifecycle.startDue({ now: new Date(s.startsAt) })).started.includes(s.sessionId), false);
  assert.equal(await lifecycle.resolveSession(s.sessionId, new Date(s.startsAt + DUE)), null);
  assert.equal((await row(s.sessionId)).status, 'cancelled');
  // A real race between the service paths always ends in exactly one consistent state.
  for (let round = 0; round < 4; round++) {
    const t = await booked({ startsAt: `2028-03-1${round}T10:00:00Z` });
    const [cancel, tick] = await Promise.all([
      app.get(CancellationService).cancel(participant(t.menteeId, 'mentee'), t.sessionId, { expectedRefundableCredits: 0 }, new Date(t.startsAt - 1))
        .then(v => v, e => e.getResponse()),
      lifecycle.startDue({ now: new Date(t.startsAt) })]);
    const status = (await row(t.sessionId)).status;
    if (status === 'cancelled') assert.equal(cancel.status, 'cancelled');
    else assert.deepEqual([status, cancel.code, tick.started.includes(t.sessionId)], ['in_progress', 'SESSION_NOT_CANCELLABLE', true]);
  }
});

test('terminal sessions never transition again through any path', async () => {
  for (const terminal of ['completed', 'no_show_mentee', 'no_show_mentor', 'cancelled']) {
    const s = await booked({ startsAt: '2028-04-10T10:00:00Z' });
    await pool.query(`UPDATE sessions SET status=$2::text::session_status, cancelled_at=CASE WHEN $2::text='cancelled' THEN now() END,
      cancellation_actor=CASE WHEN $2::text='cancelled' THEN mentor_id END WHERE id=$1`, [s.sessionId, terminal]);
    await lifecycle.startDue({ now: new Date(s.startsAt) });
    assert.equal(await lifecycle.resolveSession(s.sessionId, new Date(s.startsAt + DUE)), null);
    assert.deepEqual(await failure(joinAs(s, 'mentee', new Date(s.startsAt))), [409, 'SESSION_NOT_JOINABLE']);
    assert.equal((await row(s.sessionId)).status, terminal);
    assert.deepEqual(await credits(s), { rolloverLots: 0, noShowGrants: 0, refunds: 0, debits: 1 });
    await pool.query("UPDATE sessions SET status='cancelled', cancelled_at=now(), cancellation_actor=mentor_id WHERE id=$1", [s.sessionId]);
  }
});

test('resolveDue resolves every due session once, including ones the start tick missed', async () => {
  const a = await booked({ startsAt: '2028-05-10T10:00:00Z' });
  const b = await booked({ startsAt: '2028-05-10T10:30:00Z' });
  await joinAs(a, 'mentee', new Date(a.startsAt));
  const now = new Date(b.startsAt + DUE);
  const first = await lifecycle.resolveDue({ now });
  assert.deepEqual(first.resolved.filter(r => [a.sessionId, b.sessionId].includes(r.sessionId)),
    [{ sessionId: a.sessionId, outcome: 'no_show_mentor' }, { sessionId: b.sessionId, outcome: 'no_show_mentee' }]);
  assert.deepEqual((await lifecycle.resolveDue({ now })).resolved.filter(r => [a.sessionId, b.sessionId].includes(r.sessionId)), []);
});

test('a failure after the rollover lot or after the ledger grant rolls everything back', async t => {
  for (const mode of ['after-lot', 'after-ledger']) {
    const s = await booked();
    await joinAs(s, 'mentee', at(0));
    const append = ledger.appendEntry.bind(ledger);
    const fail = t.mock.method(ledger, 'appendEntry', async (...args) => {
      if (mode === 'after-ledger') await append(...args);
      throw Error('test-only failure ' + mode);
    });
    assert.deepEqual(await failure(lifecycle.resolveSession(s.sessionId, at(DUE))), [500, 'SESSION_UPDATE_FAILED']);
    fail.mock.restore();
    assert.equal((await row(s.sessionId)).status, 'in_progress');
    assert.deepEqual(await credits(s), { rolloverLots: 0, noShowGrants: 0, refunds: 0, debits: 1 });
    assert.equal((await lifecycle.resolveSession(s.sessionId, at(DUE))).outcome, 'no_show_mentor');
    assert.deepEqual(await credits(s), { rolloverLots: 1, noShowGrants: 1, refunds: 0, debits: 1 });
  }
});

test('elapsed timing uses UTC instants across the London autumn clock change', async () => {
  // 01:30 BST on 27 Oct 2030 is 00:30Z; the session still lasts 30 elapsed minutes.
  const mentorId = await user('mentor', 'Europe/London'), menteeId = await user('mentee', 'Europe/London');
  await purchase(menteeId, 1);
  const { booking } = await bookings.book(menteeId, { mentorId, startsAt: '2030-10-27T01:30:00+01:00' });
  const s = { mentorId, menteeId, sessionId: booking.sessionId };
  assert.equal(booking.endsAt, '2030-10-27T01:00:00Z');
  assert.deepEqual(await failure(joinAs(s, 'mentee', new Date('2030-10-27T00:24:59.999Z'))), [409, 'JOIN_WINDOW_NOT_OPEN']);
  await joinAs(s, 'mentee', new Date('2030-10-27T00:25:00Z'));
  assert.equal(await lifecycle.resolveSession(s.sessionId, new Date('2030-10-27T01:04:59.999Z')), null);
  assert.equal((await lifecycle.resolveSession(s.sessionId, new Date('2030-10-27T01:05:00Z'))).outcome, 'no_show_mentor');
  const { rows: [lot] } = await pool.query("SELECT expires_at FROM credit_lots WHERE session_id=$1 AND credit_type='ROLLOVER'", [s.sessionId]);
  assert.equal(lot.expires_at.toISOString(), '2030-11-26T01:05:00.000Z');
});

test('session lists show only the caller\'s own sessions, split into upcoming and past', async () => {
  const s = await booked({ startsAt: '2030-07-01T10:00:00Z' });
  const done = await bookings.book(s.menteeId, { mentorId: s.mentorId, startsAt: '2030-07-01T11:00:00Z' }).catch(() => null);
  assert.equal(done, null, 'mentee has no credit left');
  await purchase(s.menteeId, 1);
  const { booking: second } = await bookings.book(s.menteeId, { mentorId: s.mentorId, startsAt: '2030-07-01T11:00:00Z' });
  await pool.query("UPDATE sessions SET status='completed' WHERE id=$1", [second.sessionId]);
  const upcoming = await http('GET', '/sessions/me?status=upcoming', s.menteeId);
  assert.deepEqual(upcoming.data.items.map(i => [i.sessionId, i.status, i.mentor.id]), [[s.sessionId, 'scheduled', s.mentorId]]);
  const past = await http('GET', '/sessions/me?status=past', s.menteeId);
  assert.deepEqual(past.data.items.map(i => i.sessionId), [second.sessionId]);
  const mentorView = await http('GET', '/mentor/sessions?status=upcoming', s.mentorId);
  assert.deepEqual(mentorView.data.items.map(i => [i.sessionId, i.mentee.id]), [[s.sessionId, s.menteeId]]);
  assert.deepEqual((await http('GET', '/sessions/me', await user('mentee'))).data.items, []);
  assert.equal((await http('GET', '/sessions/me?status=soon', s.menteeId)).data.code, 'INVALID_SESSION_QUERY');
  assert.equal((await http('GET', '/sessions/me', s.mentorId)).status, 403);
  assert.equal((await http('GET', '/mentor/sessions', s.menteeId)).status, 403);
  assert.equal((await http('GET', '/sessions/me', null)).status, 401);
});
