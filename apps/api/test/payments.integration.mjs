import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import pg from 'pg';
import { createApp } from '../dist/create-app.js';
import { PaymentsService } from '../dist/payments/payments.service.js';
import { LedgerService } from '../dist/wallet/ledger.service.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

const database = 'payment_test_' + randomUUID().replaceAll('-', '');
const owner = new pg.Client({ ...connectionOptions(), database:'postgres' });
const mentee = '00000000-0000-4000-8000-000000000003';
const secret = randomBytes(32).toString('hex');
let app, base, pool, created;
before(async () => {
  assert.ok(!process.env.DATABASE_URL, 'Use the bundled PostgreSQL server for payment tests');
  await owner.connect();
  await owner.query('CREATE DATABASE ' + database);
  created = true;
  process.env.PGDATABASE = database;
  execFileSync(process.execPath, ['infra/db/bootstrap.mjs','migrate']);
  process.env.PGUSER = 'mentor_app';
  process.env.DB_PASSWORD_FILE = process.env.RUNTIME_PASSWORD_FILE;
  process.env.DEMO_AUTH_ENABLED = 'true';
  process.env.WEBHOOK_SECRET = secret;
  execFileSync(process.execPath, ['infra/db/bootstrap.mjs','seed']);
  app = await createApp();
  await app.listen(0,'0.0.0.0');
  base = 'http://' + hostname() + ':' + app.getHttpServer().address().port;
  pool = app.get(pg.Pool);
});
after(async () => {
  try {
    await app?.close();
    if (created) await owner.query('DROP DATABASE ' + database);
  } finally { await owner.end(); }
});

const headers = { 'Content-Type':'application/json', 'X-User-Id':mentee };
const purchase = (body = {packCredits:4}, user = mentee) => fetch(base+'/payments/purchases',
  { method:'POST', headers:{'Content-Type':'application/json', ...(user && {'X-User-Id':user})}, body:JSON.stringify(body) });
async function order() {
  const response = await purchase();
  assert.equal(response.status,201);
  const payment = await response.json();
  assert.equal(payment.status,'PENDING');
  assert.equal(payment.packCredits,4);
  return payment;
}
async function balance() {
  return (await (await fetch(base+'/wallet/me',{headers})).json()).normal;
}
function event(payment, overrides={}) {
  return {eventId:randomUUID(),paymentId:payment.providerPaymentId,type:'payment.succeeded',
    occurredAt:new Date().toISOString(),...overrides};
}
const sign = body => 'sha256=' + createHmac('sha256',secret).update(body).digest('hex');
function deliver(body, signature=sign(body)) {
  return fetch(base+'/webhooks/fake-payments',{method:'POST',body,
    headers:{'Content-Type':'application/json', ...(signature && {'X-Webhook-Signature':signature})}});
}
async function state(paymentId) {
  const result = await pool.query(`SELECT status,
    (SELECT count(*)::int FROM credit_lots WHERE payment_id=p.id) AS lots,
    (SELECT count(*)::int FROM ledger_entries WHERE payment_id=p.id) AS entries
    FROM payments p WHERE p.id=$1`,[paymentId]);
  return result.rows[0];
}
const pending = {status:'PENDING',lots:0,entries:0};
const succeeded = {status:'SUCCEEDED',lots:1,entries:1};

test('purchase creates only a pending order; role, identity and pack checks protect creation', async () => {
  const initial = await balance();
  const p = await order();
  assert.deepEqual(await state(p.paymentId),pending);
  assert.equal(await balance(),initial);
  for (const user of [null,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000005']) {
    assert.equal((await purchase({packCredits:4},user)).status,user?403:401);
  }
  for (const body of [{packCredits:8},{packCredits:'4'},{packCredits:4,menteeId:'other'}]) {
    assert.equal((await purchase(body)).status,422);
  }
});

test('invalid signatures, payloads, quantity and references leave the purchase pending', async () => {
  const p = await order();
  const compact = JSON.stringify(event(p));
  const pretty = JSON.stringify(JSON.parse(compact),null,2);
  const cases = [
    [compact,null,401,'INVALID_SIGNATURE'], [compact,'sha256=bad',401,'INVALID_SIGNATURE'],
    [compact,'sha256='+'0'.repeat(64),401,'INVALID_SIGNATURE'],[pretty,sign(compact),401,'INVALID_SIGNATURE'],
    ['{',undefined,400,'INVALID_WEBHOOK_PAYLOAD'],
    [JSON.stringify(event(p,{packCredits:5})),undefined,422,'PACK_MISMATCH'],
    [JSON.stringify(event(p,{type:'other'})),undefined,422,'UNSUPPORTED_EVENT'],
    [JSON.stringify(event(p,{paymentId:p.paymentId})),undefined,404,'PAYMENT_NOT_FOUND'],
  ];
  for (const [body,signature,status,code] of cases) {
    const response = await deliver(body,signature);
    assert.equal(response.status,status);
    assert.equal((await response.json()).code,code);
  }
  assert.deepEqual(await state(p.paymentId),pending);
  assert.equal((await deliver(pretty)).status,200);
});

test('concurrent signed success and later replay create exactly one normal four-credit grant', async () => {
  const initial = await balance();
  const p = await order();
  const body = JSON.stringify(event(p,{packCredits:4}));
  const responses = await Promise.all([deliver(body),deliver(body)]);
  const acks = [];
  for (const response of responses) {
    assert.equal(response.status,200);
    acks.push((await response.json()).duplicate);
  }
  assert.deepEqual(acks.sort(),[false,true]);
  const anotherEvent = await deliver(JSON.stringify(event(p)));
  assert.deepEqual(await anotherEvent.json(),{status:'SUCCEEDED',duplicate:true});
  assert.deepEqual(await state(p.paymentId),succeeded);
  const { rows } = await pool.query(`SELECT l.credit_type,l.original_quantity,e.kind,e.delta,e.mentee_id
    FROM credit_lots l JOIN ledger_entries e ON e.lot_id=l.id WHERE l.payment_id=$1`,[p.paymentId]);
  assert.deepEqual(rows,[{credit_type:'NORMAL',original_quantity:4,kind:'PURCHASE_GRANT',delta:4,mentee_id:mentee}]);
  assert.equal(await balance(),initial+4);
});

test('failure after ledger append rolls back lot and grant; retry completes the pending order', async t => {
  const initial = await balance();
  const p = await order();
  const service = app.get(LedgerService);
  const append = service.appendEntry.bind(service);
  const fail = t.mock.method(service,'appendEntry',async (...args) => {
    await append(...args);
    throw Error('test-only failure');
  });
  const body = JSON.stringify(event(p));
  const failed = await deliver(body);
  assert.equal(failed.status,500);
  assert.equal((await failed.json()).code,'PAYMENT_PROCESSING_FAILED');
  assert.deepEqual(await state(p.paymentId),pending);
  assert.equal(await balance(),initial);
  fail.mock.restore();
  assert.equal((await deliver(body)).status,200);
  assert.equal(await balance(),initial+4);
});

test('Docker provider CLI refunds before success and preserves the terminal state', async () => {
  const p = await order();
  const simulate = type => promisify(execFile)(process.execPath,
    ['apps/api/scripts/fake-provider.mjs','--payment',p.providerPaymentId,'--event',type],
    {env:{...process.env,PAYMENT_API_URL:base}});
  assert.match((await simulate('refunded')).stdout,/200.*REFUNDED/);
  assert.match((await simulate('succeeded')).stdout,/200.*REFUNDED/);
  assert.deepEqual(await state(p.paymentId),{ status:'REFUNDED', lots:0, entries:0 });
});

async function acknowledge(body) {
  const response = await deliver(body);
  assert.equal(response.status,200);
  return response.json();
}

async function inbox(p) {
  return (await pool.query(`SELECT provider_event_id, raw_payload, processed_at, processing_attempts, processing_error
    FROM payment_events WHERE provider_payment_id=$1 ORDER BY received_at`,[p.providerPaymentId])).rows;
}

async function movements(p) {
  return (await pool.query(`SELECT e.* FROM ledger_entries e JOIN credit_lots l ON e.lot_id=l.id
    WHERE l.payment_id=$1 ORDER BY e.created_at,e.id`,[p.paymentId])).rows;
}

async function spend(p, quantity) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const ledger = app.get(LedgerService);
    await ledger.lockMentee(tx,mentee);
    const lotId = (await movements(p))[0].lot_id;
    for (let n=0; n<quantity; n++) {
      const session = await tx.query(`INSERT INTO sessions
        (mentor_id,mentee_id,starts_at,ends_at,status,cancellation_actor,cancelled_at)
        VALUES ($1,$2,now(),now()+interval '30 minutes','cancelled',$2,now()) RETURNING id`,
        ['00000000-0000-4000-8000-000000000001',mentee]);
      await ledger.appendEntry(tx,{menteeId:mentee,lotId,sessionId:session.rows[0].id,
        kind:'BOOKING_DEBIT',delta:-1,idempotencyKey:randomUUID()});
    }
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}

for (const spent of [0,1,4]) {
  test(`refund after spending ${spent}/4: exact reversal, debt and preserved history`, async () => {
    const initialWallet = await (await fetch(base+'/wallet/me',{headers})).json();
    const p = await order();
    const success = JSON.stringify(event(p));
    await acknowledge(success);
    await spend(p,spent);
    const original = await movements(p);
    assert.equal((await acknowledge(success)).duplicate,true);
    assert.deepEqual(await movements(p),original);
    const refund = JSON.stringify(event(p,{type:'payment.refunded'}));
    const different = JSON.stringify(event(p,{type:'payment.refunded'}));
    const results = await Promise.all([acknowledge(refund),acknowledge(refund),acknowledge(different)]);
    assert.equal(results.filter(r=>!r.duplicate).length,1);
    assert.ok(results.every(r=>r.status==='REFUNDED'));
    assert.deepEqual(await acknowledge(success),{status:'REFUNDED',duplicate:true});
    const entries = await movements(p);
    assert.deepEqual(entries.slice(0,original.length),original);
    const compensations = entries.slice(original.length);
    assert.deepEqual(compensations.filter(e=>e.kind==='PAYMENT_REVERSAL').map(e=>e.delta), spent===4?[]:[spent-4]);
    assert.deepEqual(compensations.filter(e=>e.kind==='DEBT').map(e=>e.delta), spent===0?[]:[-spent]);
    assert.ok(compensations.every(e=>e.payment_id===p.paymentId && e.lot_id===original[0].lot_id));
    const wallet = await (await fetch(base+'/wallet/me',{headers})).json();
    assert.equal(wallet.normal,initialWallet.normal);
    assert.equal(wallet.rollover,initialWallet.rollover);
    assert.equal(wallet.debt,initialWallet.debt-spent);
    assert.equal(wallet.totalSpendable,Math.max(0,initialWallet.normal+initialWallet.rollover+initialWallet.debt-spent));
    const receipts = await inbox(p);
    assert.equal(receipts.length,3);
    assert.ok(receipts.every(r=>r.processed_at && r.processing_attempts===1));
  });
}

test('conflicting signed bytes or payment under an existing ID return 409; invalid signatures never enter inbox', async () => {
  const p = await order(), other = await order();
  const original = event(p);
  const body = JSON.stringify(original);
  assert.equal((await deliver(body,null)).status,401);
  assert.deepEqual(await inbox(p),[]);
  await acknowledge(body);
  for (const changed of [JSON.stringify(original,null,2),
    JSON.stringify({...original,paymentId:other.providerPaymentId}),JSON.stringify({...original,type:'payment.refunded'})]) {
    const response = await deliver(changed);
    assert.equal(response.status,409);
    assert.equal((await response.json()).code,'EVENT_ID_CONFLICT');
  }
  assert.deepEqual(await state(other.paymentId),pending);
  const stored = await inbox(p);
  assert.equal(stored.length,1);
  assert.equal(stored[0].raw_payload.toString(),body);
});

test('a fresh recovery process resumes a durable interrupted refund and is safe to rerun', async t => {
  const p = await order();
  await acknowledge(JSON.stringify(event(p)));
  await spend(p,1);
  const original = await movements(p);
  const service = app.get(LedgerService);
  const append = service.appendEntry.bind(service);
  const fail = t.mock.method(service,'appendEntry',async (tx,input) => {
    const result = await append(tx,input);
    if (input.kind==='DEBT') throw Error('test-only interruption after both compensations');
    return result;
  });
  const body = JSON.stringify(event(p,{type:'payment.refunded'}));
  assert.equal((await deliver(body)).status,500);
  fail.mock.restore();
  assert.deepEqual(await movements(p),original);
  const unfinished = (await inbox(p)).find(row=>!row.processed_at);
  assert.equal(unfinished.processing_error,'PAYMENT_PROCESSING_FAILED');
  assert.equal(unfinished.processing_attempts,1);
  const recover = () => JSON.parse(execFileSync(process.execPath,['apps/api/dist/payments/recover.js'],{encoding:'utf8'}));
  assert.deepEqual(recover(),{examined:1,failed:0});
  assert.deepEqual(recover(),{examined:0,failed:0});
  assert.deepEqual(await state(p.paymentId),{status:'REFUNDED',lots:1,entries:3});
  const recovered = await movements(p);
  assert.deepEqual(recovered.slice(0,original.length),original);
  assert.deepEqual(recovered.slice(original.length).map(e=>[e.kind,e.delta]).sort(),
    [['DEBT',-1],['PAYMENT_REVERSAL',-3]]);
  const restored = (await inbox(p)).find(row=>row.provider_event_id===unfinished.provider_event_id);
  assert.ok(restored.processed_at);
  assert.equal(restored.processing_error,null);
  assert.equal(restored.processing_attempts,2);
});

test('lost HTTP acknowledgment after commit can be retried without another grant', async t => {
  const p = await order();
  const service = app.get(PaymentsService);
  const receive = service.receive.bind(service);
  const fail = t.mock.method(service,'receive',async (...args) => {
    await receive(...args);
    throw Error('test-only acknowledgment failure');
  });
  const body = JSON.stringify(event(p));
  assert.equal((await deliver(body)).status,500);
  fail.mock.restore();
  assert.ok((await inbox(p))[0].processed_at);
  assert.deepEqual(await acknowledge(body),{status:'SUCCEEDED',duplicate:true});
  assert.deepEqual(await state(p.paymentId),succeeded);
});

test('abrupt API process exit after receipt leaves no grant and a durable recovery target', async () => {
  const p = await order();
  const body = JSON.stringify(event(p));
  // Start a separate API process against the disposable DB. Hold the real mentee
  // lock so the child is interrupted deterministically inside its transaction.
  const child = spawn(process.execPath,['--input-type=module','-e',`
    import { createApp } from './apps/api/dist/create-app.js';
    const api = await createApp();
    await api.listen(0,'127.0.0.1');
    process.send(api.getHttpServer().address().port);
  `],{stdio:['ignore','ignore','inherit','ipc']});
  const exited = once(child,'exit');
  const lock = await pool.connect();
  let request;
  try {
    const [port] = await once(child,'message',{signal:globalThis.AbortSignal.timeout(10000)});
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[mentee]);
    request = fetch('http://127.0.0.1:'+port+'/webhooks/fake-payments',{method:'POST',body,
      headers:{'Content-Type':'application/json','X-Webhook-Signature':sign(body)}}).catch(()=>null);
    let blocked = false;
    for (let i=0; i<100 && !blocked; i++) {
      const observed = await pool.query(`SELECT EXISTS (
        SELECT FROM pg_stat_activity WHERE datname=current_database()
        AND $1::int=ANY(pg_blocking_pids(pid))) AS blocked`,[lock.processID]);
      blocked = observed.rows[0].blocked;
      if (!blocked) await delay(25);
    }
    assert.ok(blocked,'child reached the financial transaction after storing its receipt');
  } finally {
    child.kill('SIGKILL');
    await exited;
    await lock.query('ROLLBACK');
    lock.release();
    await request;
  }
  assert.equal((await inbox(p))[0].processed_at,null);
  assert.deepEqual(await state(p.paymentId),pending);
  const result = JSON.parse(execFileSync(process.execPath,['apps/api/dist/payments/recover.js'],{encoding:'utf8'}));
  assert.deepEqual(result,{examined:1,failed:0});
  assert.deepEqual(await state(p.paymentId),succeeded);
  assert.deepEqual(await acknowledge(body),{status:'SUCCEEDED',duplicate:true});
});

test('a pending verified refund takes precedence when success arrives during recovery', async t => {
  const p = await order();
  const body = JSON.stringify(event(p,{type:'payment.refunded'}));
  const fail = t.mock.method(app.get(PaymentsService),'reconcile',async () => {
    throw Error('test-only interruption before reconciliation');
  });
  assert.equal((await deliver(body)).status,500);
  fail.mock.restore();
  assert.equal((await inbox(p))[0].processed_at,null);
  assert.equal((await acknowledge(JSON.stringify(event(p)))).status,'REFUNDED');
  assert.equal((await acknowledge(body)).status,'REFUNDED');
  assert.deepEqual(await state(p.paymentId),{status:'REFUNDED',lots:0,entries:0});
});

test('concurrent success and refund converge to zero entitlement and two processed receipts', async () => {
  const p = await order();
  const first = JSON.stringify(event(p));
  const second = JSON.stringify(event(p,{type:'payment.refunded'}));
  await Promise.all([acknowledge(first),acknowledge(second)]);
  const final = await state(p.paymentId);
  assert.equal(final.status,'REFUNDED');
  const entries = await movements(p);
  assert.equal(entries.reduce((total,e)=>total+e.delta,0),0);
  assert.ok(entries.length===0 || entries.length===2);
  const receipts = await inbox(p);
  assert.equal(receipts.length,2);
  assert.ok(receipts.every(e=>e.processed_at));
  await assert.rejects(pool.query("UPDATE payment_events SET raw_payload='invalid' WHERE provider_payment_id=$1",
    [p.providerPaymentId]),{code:'42501'});
});
