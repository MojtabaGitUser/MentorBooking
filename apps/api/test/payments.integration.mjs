import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import pg from 'pg';
import { createApp } from '../dist/create-app.js';
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

test('Docker provider CLI delivers success and reports unprocessed refunds explicitly', async () => {
  const p = await order();
  const simulate = type => promisify(execFile)(process.execPath,
    ['apps/api/scripts/fake-provider.mjs','--payment',p.providerPaymentId,'--event',type],
    {env:{...process.env,PAYMENT_API_URL:base}});
  await assert.rejects(simulate('refunded'), error => error.code===1 && error.stdout.includes('501') && error.stdout.includes('REFUND_NOT_PROCESSED'));
  assert.deepEqual(await state(p.paymentId),pending);
  assert.match((await simulate('succeeded')).stdout,/200.*SUCCEEDED/);
  assert.deepEqual(await state(p.paymentId),succeeded);
});
