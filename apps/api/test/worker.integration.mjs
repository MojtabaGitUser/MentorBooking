import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID as uuid } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/create-app.js';
import { LedgerService } from '../dist/wallet/ledger.service.js';
import { RolloverService } from '../dist/wallet/rollover.service.js';
import { BookingService } from '../dist/sessions/booking.service.js';
import { CancellationService } from '../dist/sessions/cancellation.service.js';
import { MentorCancellationService } from '../dist/sessions/mentor-cancellation.service.js';
import { LifecycleService } from '../dist/sessions/lifecycle.service.js';
import { WorkerService } from '../dist/worker/worker.service.js';
import { ReminderService } from '../dist/worker/reminder.service.js';
import { OutboxDispatcher } from '../dist/worker/outbox-dispatcher.service.js';
import { NotificationSink } from '../dist/worker/notification-sink.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

const database = 'worker_test_' + uuid().replaceAll('-', '');
const owner = new pg.Client({ ...connectionOptions(), database: 'postgres' });
const ADMIN = '00000000-0000-4000-8000-000000000005';
const SEEDED_MENTOR = '00000000-0000-4000-8000-000000000001';
const MIN = 60_000, H = 60 * MIN;
let app, base, pool, ledger, bookings, lifecycle, worker, reminders, outbox, created;

before(async () => {
  assert.ok(!process.env.DATABASE_URL, 'Use the bundled PostgreSQL server for worker tests');
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
  worker = app.get(WorkerService);
  reminders = app.get(ReminderService);
  outbox = app.get(OutboxDispatcher);
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
  return lot.id;
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
async function booked(startsAt, { credits = 1, timezone = 'UTC' } = {}) {
  const mentorId = await user('mentor', timezone), menteeId = await user('mentee', timezone);
  if (credits) await purchase(menteeId, credits);
  const { booking } = await bookings.book(menteeId, { mentorId, startsAt });
  return { mentorId, menteeId, sessionId: booking.sessionId, startsAt: Date.parse(booking.startsAt) };
}
const person = (id, role) => ({ id, role, displayName: role, timezone: 'UTC' });
const join = (s, role, now) => lifecycle.join(person(role === 'mentor' ? s.mentorId : s.menteeId, role), s.sessionId, now);
async function status(id) { return (await pool.query('SELECT status FROM sessions WHERE id=$1', [id])).rows[0].status; }
async function event(key) {
  return (await pool.query('SELECT * FROM outbox_events WHERE event_key=$1', [key])).rows[0];
}
async function deliveries(key) {
  return (await pool.query('SELECT * FROM notification_deliveries WHERE event_key=$1', [key])).rows;
}
async function insertEvent(type = 'MENTOR_CANCELLED', recipientId) {
  const key = 'test-event:' + uuid();
  await pool.query('INSERT INTO outbox_events (event_key,type,payload) VALUES ($1,$2,$3)',
    [key, type, { recipientId: recipientId ?? await user('mentee'), sessionId: uuid() }]);
  return key;
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
async function until(check, timeoutMs = 10_000) {
  for (const started = Date.now(); Date.now() - started < timeoutMs; await delay(50)) if (await check()) return;
  throw Error('condition not reached in time');
}

// ================= lifecycle through the worker tick =================
test('tick starts due sessions only at the official start, skips cancelled ones and resolves after the grace period', async () => {
  const at = '2029-01-10T10:00:00Z', start = Date.parse(at);
  const completed = await booked(at), menteeNoShow = await booked(at), mentorNoShow = await booked(at), cancelled = await booked(at);
  await join(completed, 'mentee', new Date(start - 2 * MIN));
  await join(completed, 'mentor', new Date(start - MIN));
  await join(menteeNoShow, 'mentor', new Date(start - MIN));
  await join(mentorNoShow, 'mentee', new Date(start - MIN));
  await app.get(MentorCancellationService).cancel(person(cancelled.mentorId, 'mentor'), cancelled.sessionId, undefined, new Date(start - H));
  const ids = [completed, menteeNoShow, mentorNoShow, cancelled].map(s => s.sessionId);
  const statuses = () => Promise.all(ids.map(status));
  await worker.tick({ now: new Date(start - 1) });
  assert.deepEqual(await statuses(), ['scheduled', 'scheduled', 'scheduled', 'cancelled'], 'early joins never start a session');
  await worker.tick({ now: new Date(start) });
  assert.deepEqual(await statuses(), ['in_progress', 'in_progress', 'in_progress', 'cancelled']);
  await worker.tick({ now: new Date(start + 35 * MIN - 1) });
  assert.deepEqual(await statuses(), ['in_progress', 'in_progress', 'in_progress', 'cancelled']);
  await worker.tick({ now: new Date(start + 35 * MIN) });
  assert.deepEqual(await statuses(), ['completed', 'no_show_mentee', 'no_show_mentor', 'cancelled']);
  await worker.tick({ now: new Date(start + 2 * H) });
  const { rows } = await pool.query(`SELECT s.id, count(l.id)::int AS lots,
      (SELECT count(*)::int FROM ledger_entries e WHERE e.session_id=s.id AND e.kind<>'BOOKING_DEBIT') AS credits
    FROM sessions s LEFT JOIN credit_lots l ON l.session_id=s.id AND l.credit_type='ROLLOVER'
    WHERE s.id = ANY($1) GROUP BY s.id`, [ids]);
  const by = Object.fromEntries(rows.map(r => [r.id, [r.lots, r.credits]]));
  assert.deepEqual(ids.map(id => by[id]), [[0, 0], [0, 0], [1, 1], [0, 1]], 'one rollover for the mentor no-show, one refund for the cancellation');
});

test('a session whose resolution fails does not block later sessions; it is retried next tick', async t => {
  const at = '2029-01-20T10:00:00Z', start = Date.parse(at);
  const poisoned = await booked(at), healthy = await booked('2029-01-20T10:30:00Z');
  const resolve = lifecycle.resolveSession.bind(lifecycle);
  const fail = t.mock.method(lifecycle, 'resolveSession', (id, now) => id === poisoned.sessionId
    ? Promise.reject(Error('test-only resolution failure')) : resolve(id, now));
  const report = await worker.tick({ now: new Date(start + 2 * H) });
  fail.mock.restore();
  assert.ok(report.failed >= 1);
  assert.deepEqual([await status(poisoned.sessionId), await status(healthy.sessionId)], ['in_progress', 'no_show_mentee']);
  await worker.tick({ now: new Date(start + 2 * H) });
  assert.equal(await status(poisoned.sessionId), 'no_show_mentee');
});

// ================= rollover expiry =================
test('tick expires rollover credit at its exact instant, once, and races safely with a booking', async () => {
  const me = await user('mentee');
  const expires = Date.parse('2029-02-15T12:00:00Z');
  const lot = await rollover(me, new Date(expires));
  const expiries = async () => (await pool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE lot_id=$1 AND kind='ROLLOVER_EXPIRE'", [lot])).rows[0].n;
  await worker.tick({ now: new Date(expires - 1) });
  assert.equal(await expiries(), 0);
  await worker.tick({ now: new Date(expires) });
  await worker.tick({ now: new Date(expires) });
  await worker.tick({ now: new Date(expires + H) });
  assert.equal(await expiries(), 1);

  for (let round = 0; round < 4; round++) {
    const mentee = await user('mentee');
    await purchase(mentee, 1);
    const rolloverLot = await rollover(mentee, new Date(expires));
    const mentorId = await user('mentor');
    const holder = new pg.Client(connectionOptions());
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [mentee]);
    const pending = [app.get(RolloverService).expireRolloverLots(new Date(expires)),
      bookings.book(mentee, { mentorId, startsAt: '2029-06-01T10:00:00Z' }, undefined, new Date(expires - 1))];
    await waitForLockWaiters(2);
    await holder.query('COMMIT');
    await holder.end();
    const [, { booking }] = await Promise.all(pending);
    const { rows: [lotSum] } = await pool.query('SELECT SUM(delta)::int AS remaining FROM ledger_entries WHERE lot_id=$1', [rolloverLot]);
    const { rows: [total] } = await pool.query('SELECT SUM(delta)::int AS total FROM ledger_entries WHERE mentee_id=$1', [mentee]);
    assert.equal(lotSum.remaining, 0, 'the rollover lot is either spent or expired, never both');
    assert.equal(total.total, booking.spentCreditType === 'ROLLOVER' ? 1 : 0);
    assert.equal(await status(booking.sessionId), 'scheduled', 'a booking paid by the lot stays valid');
  }
});

// ================= reminders =================
test('reminder is queued exactly at start - 1h, never earlier, once, and delivered to the mentee', async () => {
  const s = await booked('2029-03-05T10:00:00Z');
  const key = 'reminder:' + s.sessionId + ':T-1h';
  await worker.tick({ now: new Date(s.startsAt - H - 1) });
  assert.equal(await event(key), undefined);
  const report = await worker.tick({ now: new Date(s.startsAt - H) });
  assert.ok(report.remindersQueued >= 1);
  const row = await event(key);
  assert.deepEqual([row.type, row.outcome, row.attempts], ['SESSION_REMINDER', 'DELIVERED', 1]);
  assert.deepEqual(row.payload, { recipientId: s.menteeId, sessionId: s.sessionId, mentorId: s.mentorId,
    startsAt: '2029-03-05T10:00:00Z', endsAt: '2029-03-05T10:30:00Z', remindAt: '2029-03-05T09:00:00Z' });
  const [delivery] = await deliveries(key);
  assert.deepEqual([delivery.recipient_id, delivery.channel, delivery.type], [s.menteeId, 'log', 'SESSION_REMINDER']);
  for (let i = 0; i < 3; i++) await worker.tick({ now: new Date(s.startsAt - 30 * MIN) });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox_events WHERE event_key=$1', [key])).rows[0].n, 1);
  assert.equal((await deliveries(key)).length, 1);
});

test('late bookings and restarted workers catch up before the start; cancelled or started sessions get none', async () => {
  const late = await booked('2029-03-06T10:00:00Z');
  const report = await worker.tick({ now: new Date(late.startsAt - 20 * MIN) });
  assert.ok(report.remindersQueued >= 1);
  assert.equal((await deliveries('reminder:' + late.sessionId + ':T-1h')).length, 1, 'queued and delivered in the same tick');
  const missed = await booked('2029-03-07T10:00:00Z');
  await worker.tick({ now: new Date(missed.startsAt + MIN) });
  assert.equal(await event('reminder:' + missed.sessionId + ':T-1h'), undefined, 'no reminder once the session started');
  const cancelled = await booked('2029-03-08T10:00:00Z');
  await app.get(CancellationService).cancel(person(cancelled.menteeId, 'mentee'), cancelled.sessionId,
    { expectedRefundableCredits: 1 }, new Date(cancelled.startsAt - 3 * 24 * H));
  await worker.tick({ now: new Date(cancelled.startsAt - 30 * MIN) });
  assert.equal(await event('reminder:' + cancelled.sessionId + ':T-1h'), undefined);
});

test('a reminder queued before a cancellation is suppressed at dispatch, not delivered', async () => {
  const s = await booked('2029-03-09T10:00:00Z');
  const key = 'reminder:' + s.sessionId + ':T-1h';
  await reminders.queueDue({ now: new Date(s.startsAt - H) });
  await app.get(MentorCancellationService).cancel(person(s.mentorId, 'mentor'), s.sessionId, undefined, new Date(s.startsAt - 50 * MIN));
  await outbox.dispatch({ now: new Date(s.startsAt - 50 * MIN) });
  assert.deepEqual([(await event(key)).outcome, (await deliveries(key)).length], ['SUPPRESSED', 0]);
  assert.equal((await deliveries('mentor-cancelled:' + s.sessionId)).length, 1);
});

test('concurrent reminder ticks on independent connections queue exactly one event', async () => {
  const s = await booked('2029-03-10T10:00:00Z');
  const key = 'reminder:' + s.sessionId + ':T-1h';
  // An uncommitted row with the same key makes every concurrent INSERT wait on the unique index.
  const holder = new pg.Client(connectionOptions());
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query("INSERT INTO outbox_events (event_key,type,payload) VALUES ($1,'SESSION_REMINDER','{}')", [key]);
  const pending = Array.from({ length: 4 }, () => reminders.queueDue({ now: new Date(s.startsAt - H) }));
  await waitForLockWaiters(4);
  await holder.query('ROLLBACK');
  await holder.end();
  await Promise.all(pending);
  const { rows } = await pool.query('SELECT payload FROM outbox_events WHERE event_key=$1', [key]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.recipientId, s.menteeId);
});

test('reminder generation vs cancellation: a session held by a cancellation is skipped and never delivered', async () => {
  const s = await booked('2029-03-11T10:00:00Z');
  const key = 'reminder:' + s.sessionId + ':T-1h';
  const canceller = new pg.Client(connectionOptions());
  await canceller.connect();
  await canceller.query('BEGIN');
  await canceller.query('SELECT 1 FROM sessions WHERE id=$1 FOR UPDATE', [s.sessionId]);
  assert.equal((await reminders.queueDue({ now: new Date(s.startsAt - 30 * MIN) })).queued >= 0, true);
  assert.equal(await event(key), undefined, 'skipped while locked');
  await canceller.query("UPDATE sessions SET status='cancelled', cancelled_at=now(), cancellation_actor=mentee_id WHERE id=$1", [s.sessionId]);
  await canceller.query('COMMIT');
  await canceller.end();
  await worker.tick({ now: new Date(s.startsAt - 30 * MIN) });
  assert.equal(await event(key), undefined);
  // True race through the services: whatever the interleaving, no reminder is delivered for a cancelled session.
  for (let round = 0; round < 4; round++) {
    const r = await booked(`2029-03-1${2 + round}T10:00:00Z`);
    const now = new Date(r.startsAt - 30 * MIN);
    await Promise.all([reminders.queueDue({ now }),
      app.get(CancellationService).cancel(person(r.menteeId, 'mentee'), r.sessionId, { expectedRefundableCredits: 0 }, now)]);
    await outbox.dispatch({ now });
    assert.equal(await status(r.sessionId), 'cancelled');
    assert.equal((await deliveries('reminder:' + r.sessionId + ':T-1h')).length, 0);
  }
});

test('reminder timing is 60 elapsed minutes across both London clock changes', async () => {
  for (const [local, remindAt] of [['2029-03-25T02:30:00+01:00', '2029-03-25T00:30:00Z'], ['2029-10-28T01:30:00+01:00', '2029-10-27T23:30:00Z']]) {
    const s = await booked(local, { timezone: 'Europe/London' });
    const key = 'reminder:' + s.sessionId + ':T-1h';
    await reminders.queueDue({ now: new Date(Date.parse(remindAt) - 1) });
    assert.equal(await event(key), undefined, local);
    await reminders.queueDue({ now: new Date(remindAt) });
    assert.equal((await event(key)).payload.remindAt, remindAt, local);
    assert.equal(s.startsAt - Date.parse(remindAt), H);
  }
});

// ================= outbox delivery =================
test('a pending MENTOR_CANCELLED event is delivered once; repeated dispatch adds nothing', async () => {
  const s = await booked('2029-04-10T10:00:00Z');
  await app.get(MentorCancellationService).cancel(person(s.mentorId, 'mentor'), s.sessionId, undefined, new Date('2029-04-01T00:00:00Z'));
  const key = 'mentor-cancelled:' + s.sessionId;
  assert.deepEqual([(await event(key)).processed_at, (await deliveries(key)).length], [null, 0]);
  await outbox.dispatch({ now: new Date('2029-04-01T00:00:01Z') });
  for (let i = 0; i < 3; i++) await outbox.dispatch({ now: new Date('2029-04-01T00:00:02Z') });
  const row = await event(key);
  assert.deepEqual([row.outcome, row.attempts, row.last_error], ['DELIVERED', 1, null]);
  const rows = await deliveries(key);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].recipient_id, rows[0].type, rows[0].payload.sessionId], [s.menteeId, 'MENTOR_CANCELLED', s.sessionId]);
});

test('concurrent dispatchers claim disjoint events (SKIP LOCKED) and never duplicate a delivery', async () => {
  const keys = [];
  for (let i = 0; i < 12; i++) keys.push(await insertEvent());
  // A held row is skipped, not waited for.
  const holder = new pg.Client(connectionOptions());
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM outbox_events WHERE event_key=$1 FOR UPDATE', [keys[0]]);
  const results = await Promise.all(Array.from({ length: 4 }, () => outbox.dispatch({ limit: 50 })));
  assert.equal((await deliveries(keys[0])).length, 0, 'the locked event was skipped');
  await holder.query('COMMIT');
  await holder.end();
  await outbox.dispatch({ limit: 50 });
  const { rows } = await pool.query('SELECT event_key, count(*)::int AS n FROM notification_deliveries WHERE event_key = ANY($1) GROUP BY event_key', [keys]);
  assert.equal(rows.length, 12);
  assert.ok(rows.every(r => r.n === 1));
  assert.ok(results.reduce((n, r) => n + r.delivered, 0) >= 11);
});

test('a failed delivery is rolled back, backs off, stays retryable and is parked as FAILED after the limit', async t => {
  const key = await insertEvent();
  const sink = app.get(NotificationSink);
  const deliver = sink.deliver.bind(sink);
  // Crash after the delivery row was written but before the event was marked processed.
  let fail = t.mock.method(sink, 'deliver', async (client, e) => {
    await deliver(client, e);
    if (e.eventKey === key) throw Error('test-only crash after recording delivery');
  });
  const now = Date.parse('2029-05-01T00:00:00Z');
  await outbox.dispatch({ now: new Date(now) });
  let row = await event(key);
  assert.deepEqual([row.processed_at, row.attempts, row.last_error, (await deliveries(key)).length],
    [null, 1, 'test-only crash after recording delivery', 0]);
  assert.equal(row.available_at.getTime(), now + 5000);
  await outbox.dispatch({ now: new Date(now + 4999) });
  assert.equal((await event(key)).attempts, 1, 'not retried before the backoff');
  fail.mock.restore();
  await outbox.dispatch({ now: new Date(now + 5000) });
  row = await event(key);
  assert.deepEqual([row.outcome, row.attempts, (await deliveries(key)).length], ['DELIVERED', 2, 1]);

  const doomed = await insertEvent();
  fail = t.mock.method(sink, 'deliver', async (client, e) => {
    if (e.eventKey === doomed) throw Error('provider down');
    return deliver(client, e);
  });
  for (let i = 0; i < 10; i++) await outbox.dispatch({ now: new Date(now + i * H) });
  fail.mock.restore();
  row = await event(doomed);
  assert.deepEqual([row.outcome, row.attempts, row.last_error, (await deliveries(doomed)).length], ['FAILED', 8, 'provider down', 0]);
});

test('a worker that dies holding a claimed event leaves it pending for the next worker', async () => {
  const key = await insertEvent();
  const crashed = new pg.Client(connectionOptions());
  await crashed.connect();
  await crashed.query('BEGIN');
  await crashed.query('SELECT 1 FROM outbox_events WHERE event_key=$1 FOR UPDATE', [key]);
  const { rows: [{ pid }] } = await crashed.query('SELECT pg_backend_pid() AS pid');
  crashed.on('error', () => {});
  await owner.query('SELECT pg_terminate_backend($1)', [pid]);
  await outbox.dispatch({});
  assert.deepEqual([(await event(key)).outcome, (await deliveries(key)).length], ['DELIVERED', 1]);
});

test('batch limits bound each job per tick; a failing job does not stop the others', async t => {
  const keys = [];
  for (let i = 0; i < 5; i++) keys.push(await insertEvent());
  const first = await outbox.dispatch({ limit: 2 });
  assert.equal(first.delivered + first.suppressed + first.failed, 2);
  const due = await Promise.all(['2029-06-10T10:00:00Z', '2029-06-10T10:30:00Z', '2029-06-10T11:00:00Z'].map(at => booked(at)));
  // Older due sessions from earlier tests are ahead in the queue; every call must respect the limit.
  for (let calls = 0; ; calls++) {
    const { started } = await lifecycle.startDue({ now: new Date('2029-06-10T11:00:00Z'), limit: 2 });
    assert.ok(started.length <= 2);
    if (started.length === 0) break;
    assert.ok(calls < 50);
  }
  assert.deepEqual(await Promise.all(due.map(s => status(s.sessionId))), ['in_progress', 'in_progress', 'in_progress']);
  const broken = t.mock.method(lifecycle, 'startDue', async () => { throw Error('test-only job failure'); });
  const report = await worker.tick({ batchSize: 100 });
  broken.mock.restore();
  assert.deepEqual(report.jobErrors, ['start']);
  assert.ok(keys.every(Boolean));
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox_events WHERE event_key = ANY($1) AND outcome IS NULL', [keys]);
  assert.equal(rows[0].n, 0, 'dispatch still ran after the start job failed');
});

test('no HTTP route can trigger worker jobs', async () => {
  for (const [method, path] of [['POST', '/worker/tick'], ['POST', '/worker'], ['GET', '/worker'], ['POST', '/jobs/run'],
    ['POST', '/admin/jobs/run'], ['GET', '/admin/jobs/health'], ['POST', '/outbox/dispatch'], ['POST', '/internal/tick']]) {
    const response = await fetch(base + path, { method, headers: { 'X-User-Id': ADMIN } });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

// ================= the worker process =================
function startWorker(extraEnv = {}) {
  const child = spawn(process.execPath, ['apps/api/dist/worker/main.js'], {
    env: { ...process.env, WORKER_POLL_INTERVAL_MS: '250', WORKER_BATCH_SIZE: '50', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, output: () => output };
}

test('worker process: delivers pending work, stops gracefully on SIGTERM and resumes after restart', async () => {
  const before = await insertEvent();
  const first = startWorker();
  await until(async () => (await event(before)).outcome === 'DELIVERED');
  assert.match(first.output(), /Worker started: pollIntervalMs=250 batchSize=50/);
  first.child.kill('SIGTERM');
  const [code] = await once(first.child, 'exit');
  assert.equal(code, 0);
  assert.match(first.output(), /Received SIGTERM; finishing the current tick[\s\S]*Worker stopped/);
  // Work queued while no worker runs is picked up by the next one.
  const whileDown = await insertEvent();
  await delay(300);
  assert.equal((await event(whileDown)).processed_at, null);
  const second = startWorker();
  await until(async () => (await event(whileDown)).outcome === 'DELIVERED');
  second.child.kill('SIGINT');
  assert.equal((await once(second.child, 'exit'))[0], 0);
  assert.equal((await deliveries(whileDown)).length, 1);
});

test('worker process refuses invalid configuration without touching the database', async () => {
  const key = await insertEvent();
  for (const env of [{ WORKER_BATCH_SIZE: '0' }, { WORKER_POLL_INTERVAL_MS: 'fast' }]) {
    const run = startWorker(env);
    const [code] = await once(run.child, 'exit');
    assert.equal(code, 2, JSON.stringify(env));
    assert.match(run.output(), /Invalid worker configuration: WORKER_/);
  }
  assert.equal((await event(key)).processed_at, null);
});
