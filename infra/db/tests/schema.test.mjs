import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { connectionOptions } from '../config.cjs';

// Only the bundled Compose server is a test target. Always use a newly created database.
const database = 'schema_test_' + randomUUID().replaceAll('-', '');
const admin = new pg.Client({ ...connectionOptions(), database: 'postgres' });
let created = false;
let app;
let runtimeOptions;
const id = () => randomUUID();
const [mentor, secondMentor, mentee, other, administrator] = Array.from({ length: 5 }, id);
const payment = id();
const lot = id();
const migrate = () => execFileSync(process.execPath, ['infra/db/bootstrap.mjs', 'migrate'], {
  env: { ...process.env, PGDATABASE: database }, stdio: 'pipe',
});

before(async () => {
  assert.ok(!process.env.DATABASE_URL, 'Run schema tests against the bundled Compose server');
  await admin.connect();
  await admin.query('CREATE DATABASE ' + database);
  created = true;
  migrate();
  runtimeOptions = { database, user: 'mentor_app',
    password: (await readFile(process.env.RUNTIME_PASSWORD_FILE, 'utf8')).trim() };
  app = new pg.Client(runtimeOptions);
  await app.connect();
  for (const [user, role] of [[mentor,'mentor'], [secondMentor,'mentor'], [mentee,'mentee'],
                              [other,'mentee'], [administrator,'admin']]) {
    await app.query("INSERT INTO users (id, role, display_name, timezone) VALUES ($1,$2,$3,'UTC')", [user, role, role]);
  }
  await app.query('INSERT INTO mentor_profiles (mentor_id) VALUES ($1), ($2)', [mentor, secondMentor]);
  await app.query("INSERT INTO payments (id, mentee_id, provider_payment_id, credits_purchased) VALUES ($1,$2,'order',4)", [payment, mentee]);
  await app.query("INSERT INTO credit_lots (id, mentee_id, payment_id, credit_type, original_quantity) VALUES ($1,$2,$3,'NORMAL',4)", [lot, mentee, payment]);
});

after(async () => {
  try {
    if (app) await app.end();
    if (created) await admin.query('DROP DATABASE ' + database);
  } finally {
    await admin.end();
  }
});

function book(db, mentorId, menteeId, time) {
  return db.query(`INSERT INTO sessions (mentor_id, mentee_id, starts_at, ends_at)
    VALUES ($1,$2,$3::timestamptz,$3::timestamptz + interval '30 minutes') RETURNING id`,
    [mentorId, menteeId, '2030-01-01T' + time + 'Z']);
}

function rejected(query, code, constraint) {
  return assert.rejects(query, error => {
    assert.equal(error.code, code);
    if (constraint) assert.equal(error.constraint, constraint);
    return true;
  });
}

test('clean migration creates domain objects; reapplying preserves migration history', async () => {
  const history = 'SELECT * FROM schema_migrations ORDER BY name';
  const original = (await app.query(history)).rows;
  assert.deepEqual(original.map(row => row.name), ['0001_baseline.sql', '0002_domain_schema.sql', '0003_payment_inbox_recovery.sql',
    '0004_booking_requests.sql']);
  migrate();
  assert.deepEqual((await app.query(history)).rows, original);
  const names = ['users','mentor_profiles','weekly_availability','availability_blockouts','sessions',
    'payments','payment_events','credit_adjustments','credit_lots','ledger_entries','session_credit_allocations',
    'outbox_events','booking_requests','sessions_mentor_overlap','sessions_mentee_overlap','lots_owner_expiry','outbox_pending'];
  const { rows } = await app.query('SELECT name FROM unnest($1::text[]) name WHERE to_regclass(name) IS NULL', [names]);
  assert.deepEqual(rows, []);
  assert.equal((await app.query("SELECT 1 FROM pg_extension WHERE extname='btree_gist'")).rowCount, 1);
});

test('mentor conflicts fail; adjacent sessions are accepted', async () => {
  await book(app, mentor, mentee, '10:00');
  await rejected(book(app, mentor, other, '10:15'), '23P01', 'sessions_mentor_overlap');
  await book(app, mentor, other, '10:30');
});

test('mentee conflicts across different mentors fail', async () => {
  await book(app, mentor, mentee, '11:00');
  await rejected(book(app, secondMentor, mentee, '11:15'), '23P01', 'sessions_mentee_overlap');
});

test('cancellation releases both exclusion constraints and preserves the old row', async () => {
  const session = (await book(app, mentor, mentee, '12:00')).rows[0].id;
  await app.query("UPDATE sessions SET status='cancelled', cancellation_actor=mentee_id, cancelled_at=now() WHERE id=$1", [session]);
  await book(app, mentor, mentee, '12:00');
  const result = await app.query("SELECT status FROM sessions WHERE starts_at='2030-01-01T12:00Z' ORDER BY status");
  assert.deepEqual(result.rows.map(row => row.status), ['scheduled','cancelled']);
});

test('runtime can append and compensate; permissions and database triggers protect history', async () => {
  const insert = `INSERT INTO ledger_entries (mentee_id,lot_id,payment_id,kind,delta,idempotency_key)
    VALUES ($1,$2,$3,$4,$5,$6)`;
  const grant = [mentee,lot,payment,'PURCHASE_GRANT',4,'purchase:order'];
  await app.query(insert, grant);
  await rejected(app.query(insert, grant), '23505');
  await app.query(insert, [mentee,lot,payment,'PAYMENT_REVERSAL',-4,'reverse:order']);
  for (const sql of ['UPDATE ledger_entries SET delta=1','DELETE FROM ledger_entries','TRUNCATE ledger_entries']) {
    await rejected(app.query(sql), '42501');
  }
  await rejected(app.query('ALTER TABLE ledger_entries DISABLE TRIGGER immutable_ledger'), '42501');
  const owner = new pg.Client({ ...connectionOptions(), database });
  await owner.connect();
  try {
    for (const sql of ['UPDATE ledger_entries SET delta=1','DELETE FROM ledger_entries','TRUNCATE ledger_entries']) {
      await rejected(owner.query(sql), '55000');
    }
  } finally { await owner.end(); }
  const { rows } = await app.query('SELECT count(*)::int AS entries, sum(delta)::int AS balance FROM ledger_entries WHERE lot_id=$1', [lot]);
  assert.deepEqual(rows, [{ entries: 2, balance: 0 }]);
});

test('foreign keys, role, range, quantity, rollover and wallet ownership checks reject invalid writes', async () => {
  await rejected(book(app, id(), mentee, '13:00'), '23503');
  await rejected(book(app, mentor, administrator, '13:00'), '23503');
  await rejected(app.query("INSERT INTO availability_blockouts (mentor_id,starts_at,ends_at) VALUES ($1,now(),now())", [mentor]), '23514');
  await rejected(app.query("INSERT INTO sessions (mentor_id,mentee_id,starts_at,ends_at) VALUES ($1,$2,now(),now())", [mentor,mentee]), '23514');
  const insert = 'INSERT INTO credit_lots (mentee_id,payment_id,credit_type,original_quantity) VALUES ($1,$2,$3,$4)';
  for (const quantity of [-1,0]) await rejected(app.query(insert, [mentee,payment,'NORMAL',quantity]), '23514');
  await rejected(app.query(insert, [mentee,payment,'ROLLOVER',1]), '23514');
  await rejected(app.query(insert, [other,payment,'NORMAL',1]), '23503');
  const session = (await book(app, secondMentor, other, '13:00')).rows[0].id;
  await rejected(app.query('INSERT INTO session_credit_allocations (session_id,mentee_id,lot_id) VALUES ($1,$2,$3)', [session,other,lot]), '23503');
});

test('provider, inbox, outbox and adjustment keys reject duplicate delivery or requests', async () => {
  await rejected(app.query("INSERT INTO payments (mentee_id,provider_payment_id,credits_purchased) VALUES ($1,'order',4)", [mentee]), '23505');
  const queries = [
    ["INSERT INTO payment_events (provider_event_id,provider_payment_id,event_type,raw_payload) VALUES ('event','order','payment.succeeded','{}')", []],
    ["INSERT INTO outbox_events (event_key,type,payload) VALUES ('reminder','reminder','{}')", []],
    ["INSERT INTO credit_adjustments (mentee_id,admin_id,reason,delta,idempotency_key) VALUES ($1,$2,'support grant',1,'request')", [mentee,administrator]],
  ];
  for (const [sql, params] of queries) {
    await app.query(sql, params);
    await rejected(app.query(sql, params), '23505');
  }
});

test('two live transactions competing for a slot commit exactly one booking', async () => {
  const contender = new pg.Client(runtimeOptions);
  await contender.connect();
  let pending;
  try {
    await app.query('BEGIN');
    await book(app, mentor, mentee, '15:00');
    pending = book(contender, mentor, other, '15:00').then(() => null, error => error);
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const result = await app.query('SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS blocked', [contender.processID]);
      blocked = result.rows[0].blocked;
      if (!blocked) await delay(25);
    }
    assert.ok(blocked, 'second connection must wait on the uncommitted booking');
    await app.query('COMMIT');
    const error = await pending;
    assert.equal(error?.code, '23P01');
    assert.equal(error.constraint, 'sessions_mentor_overlap');
    assert.equal((await app.query("SELECT id FROM sessions WHERE starts_at='2030-01-01T15:00Z'")).rowCount, 1);
  } finally {
    await app.query('ROLLBACK');
    await pending;
    await contender.end();
  }
});
