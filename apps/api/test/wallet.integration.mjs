import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID as uuid } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../dist/api.module.js';
import { LedgerService } from '../dist/wallet/ledger.service.js';
import { WalletService } from '../dist/wallet/wallet.service.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

let app, pool, ledger, wallets, base, created;
const database = 'wallet_test_' + uuid().replaceAll('-', '');
const admin = new pg.Client({ ...connectionOptions(), database: 'postgres' });
const mentor = '00000000-0000-4000-8000-000000000001';
const empty = '00000000-0000-4000-8000-000000000004';
const adminId = '00000000-0000-4000-8000-000000000005';

before(async () => {
  assert.ok(!process.env.DATABASE_URL, 'Use the bundled test database server');
  await admin.connect();
  await admin.query('CREATE DATABASE ' + database);
  created = true;
  process.env.PGDATABASE = database;
  execFileSync(process.execPath, ['infra/db/bootstrap.mjs','migrate']);
  process.env.PGUSER = 'mentor_app';
  process.env.DB_PASSWORD_FILE = process.env.RUNTIME_PASSWORD_FILE;
  process.env.DEMO_AUTH_ENABLED = 'true';
  execFileSync(process.execPath, ['infra/db/bootstrap.mjs','seed']);
  app = await NestFactory.create(ApiModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  pool = app.get(pg.Pool);
  ledger = app.get(LedgerService);
  wallets = app.get(WalletService);
});
after(async () => {
  try {
    await app?.close();
    if (created) await admin.query('DROP DATABASE ' + database);
  } finally { await admin.end(); }
});

async function transaction(work) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}
async function fixture() {
  const menteeId = uuid(), paymentId = uuid(), lotId = uuid(), sessionId = uuid();
  await pool.query("INSERT INTO users (id,role,display_name,timezone) VALUES ($1,'mentee','Test','UTC')", [menteeId]);
  await pool.query('INSERT INTO payments (id,mentee_id,provider_payment_id,credits_purchased) VALUES ($1,$2,$3,4)', [paymentId,menteeId,uuid()]);
  await pool.query("INSERT INTO credit_lots (id,mentee_id,credit_type,original_quantity,payment_id) VALUES ($1,$2,'NORMAL',4,$3)", [lotId,menteeId,paymentId]);
  // Released session fixtures can share a slot across independent tests.
  await pool.query(`INSERT INTO sessions (id,mentor_id,mentee_id,starts_at,ends_at,status,cancellation_actor,cancelled_at)
    VALUES ($1,$2,$3,now(),now()+interval '30 minutes','cancelled',$2,now())`, [sessionId,mentor,menteeId]);
  const grant = { menteeId, lotId, paymentId, kind:'PURCHASE_GRANT', delta:4, idempotencyKey:uuid() };
  return { menteeId, lotId, sessionId, grant };
}
const append = entry => transaction(tx => ledger.appendEntry(tx, entry));
const get = (path, user) => fetch(base + '/wallet/me' + path, { headers: user ? { 'X-User-Id': user } : {} });

test('grant, spend and cancellation refund produce 4 spendable credits and three ordered movements', async () => {
  const { menteeId, lotId, sessionId, grant } = await fixture();
  const purchase = await append(grant);
  const debit = await append({ menteeId,lotId,sessionId,kind:'BOOKING_DEBIT',delta:-1,idempotencyKey:uuid() });
  const refund = await append({ menteeId,lotId,sessionId,kind:'CANCELLATION_REFUND',delta:1,idempotencyKey:uuid() });
  const wallet = await (await get('',menteeId)).json();
  assert.equal(wallet.totalSpendable, 4);
  assert.equal(wallet.normal, 4);
  assert.deepEqual(wallet.history.items.map(e => [e.id,e.kind,e.delta]), [refund,debit,purchase].map(e=>[e.id,e.kind,e.delta]));
  assert.equal(wallet.history.items[0].sessionId,sessionId);
  assert.equal(wallet.history.items[2].paymentId,grant.paymentId);
  for (const sql of ['UPDATE ledger_entries SET delta=9 WHERE id=$1', 'DELETE FROM ledger_entries WHERE id=$1']) {
    await assert.rejects(pool.query(sql,[purchase.id]), { code:'42501' });
  }
});

test('concurrent identical retries return the persisted entry; conflicting content is rejected', async () => {
  const { grant } = await fixture();
  const [a,b] = await Promise.all([append(grant),append(grant)]);
  assert.deepEqual(a,b);
  await assert.rejects(append({ ...grant, delta:5 }), error=>error.getResponse().code==='IDEMPOTENCY_CONFLICT');
  assert.equal((await wallets.getWallet(grant.menteeId)).history.items.length,1);
});

test('writes require a transaction; failed operations roll back with the caller', async () => {
  const { grant } = await fixture();
  const client = await pool.connect();
  try { await assert.rejects(ledger.appendEntry(client,grant), /active PostgreSQL transaction/); }
  finally { client.release(); }
  await assert.rejects(transaction(async tx => {
    await ledger.appendEntry(tx,grant);
    throw Error('abort business operation');
  }), /abort business operation/);
  await assert.rejects(append({ ...grant, menteeId:empty }), error=>error.getStatus()===422);
  await assert.rejects(append({ ...grant, kind:'ADMIN_GRANT' }), error=>error.getStatus()===422);
  assert.equal((await wallets.getWallet(grant.menteeId)).normal,0);
});

test('mixed balances, exact expiry boundary, past asOf and immutable expiry history', async () => {
  const { grant, menteeId, sessionId } = await fixture();
  await append(grant);
  const expires = new Date('2090-05-01T12:00:00Z');
  const lotId = uuid();
  await pool.query(`INSERT INTO credit_lots (id,mentee_id,credit_type,original_quantity,session_id,expires_at)
    VALUES ($1,$2,'ROLLOVER',1,$3,$4)`, [lotId,menteeId,sessionId,expires]);
  await append({ menteeId,lotId,sessionId,kind:'NO_SHOW_ROLLOVER',delta:1,idempotencyKey:uuid() });
  const before = await wallets.getWallet(menteeId,new Date(+expires-1));
  assert.deepEqual([before.normal,before.rollover,before.totalSpendable],[4,1,5]);
  assert.deepEqual(before.rolloverLots,[{ lotId, remaining:1, expiresAt:expires }]);
  const at = await wallets.getWallet(menteeId,expires);
  assert.deepEqual([at.rollover,at.totalSpendable,at.rolloverLots],[0,4,[]]);
  assert.equal(at.history.items.find(e=>e.lotId===lotId).sessionId,sessionId);
  const past = await wallets.getWallet(menteeId,new Date('2000-01-01Z'));
  assert.equal(past.totalSpendable,0);
  assert.deepEqual(past.history.items,[]);
});

test('negative purchased lot offsets a separate positive lot exactly once', async () => {
  const { grant, menteeId, lotId, sessionId } = await fixture();
  await append(grant);
  await append({ menteeId,lotId,sessionId,kind:'BOOKING_DEBIT',delta:-1,idempotencyKey:uuid() });
  await append({ ...grant,kind:'PAYMENT_REVERSAL',delta:-3,idempotencyKey:uuid() });
  await append({ ...grant,kind:'DEBT',delta:-1,idempotencyKey:uuid() });
  const adjustmentId = uuid(), adminLot = uuid();
  await pool.query("INSERT INTO credit_adjustments (id,idempotency_key,mentee_id,admin_id,reason,delta) VALUES ($1,$2,$3,$4,'Support',2)",[adjustmentId,uuid(),menteeId,adminId]);
  await pool.query("INSERT INTO credit_lots (id,mentee_id,credit_type,original_quantity,adjustment_id) VALUES ($1,$2,'NORMAL',2,$3)",[adminLot,menteeId,adjustmentId]);
  await append({ menteeId,lotId:adminLot,adjustmentId,reason:'Support',kind:'ADMIN_GRANT',delta:2,idempotencyKey:uuid() });
  const wallet = await wallets.getWallet(menteeId);
  assert.deepEqual([wallet.normal,wallet.debt,wallet.totalSpendable],[2,-1,1]);
  assert.equal(wallet.history.items[0].reason,'Support');
});

test('mentor refund, expiry and admin revoke retain their sources in history', async () => {
  const { grant, menteeId, lotId, sessionId } = await fixture();
  await append(grant);
  await append({ menteeId, lotId, sessionId, kind:'BOOKING_DEBIT', delta:-1, idempotencyKey:uuid() });
  await append({ menteeId, lotId, sessionId, kind:'MENTOR_REFUND', delta:1, idempotencyKey:uuid() });
  const adjustmentId = uuid();
  await pool.query("INSERT INTO credit_adjustments (id,idempotency_key,mentee_id,admin_id,reason,delta) VALUES ($1,$2,$3,$4,'Correction',-1)", [adjustmentId,uuid(),menteeId,adminId]);
  await append({ menteeId, lotId, adjustmentId, kind:'ADMIN_REVOKE', delta:-1, reason:'Correction', idempotencyKey:uuid() });
  const expiredLot = uuid();
  await pool.query(`INSERT INTO credit_lots (id,mentee_id,credit_type,original_quantity,session_id,created_at,expires_at)
    VALUES ($1,$2,'ROLLOVER',1,$3,now()-interval '31 days',now()-interval '1 day')`, [expiredLot,menteeId,sessionId]);
  await append({ menteeId, lotId:expiredLot, sessionId, kind:'NO_SHOW_ROLLOVER', delta:1, idempotencyKey:uuid() });
  await append({ menteeId, lotId:expiredLot, kind:'ROLLOVER_EXPIRE', delta:-1, idempotencyKey:uuid() });
  const wallet = await wallets.getWallet(menteeId);
  assert.equal(wallet.totalSpendable,3);
  const entries = wallet.history.items;
  assert.equal(entries.find(e=>e.kind==='ROLLOVER_EXPIRE').lotId,expiredLot);
  assert.equal(entries.find(e=>e.kind==='MENTOR_REFUND').sessionId,sessionId);
  assert.equal(entries.find(e=>e.kind==='ADMIN_REVOKE').adjustmentId,adjustmentId);
});

test('cursor pages retain full PostgreSQL timestamp precision, including tied instants', async () => {
  const { menteeId,lotId,grant } = await fixture();
  for (const fraction of ['123450','123451','123451','123452']) {
    await pool.query(`INSERT INTO ledger_entries (mentee_id,lot_id,payment_id,kind,delta,idempotency_key,created_at)
      VALUES ($1,$2,$3,'PURCHASE_GRANT',1,$4,$5)`,
      [menteeId,lotId,grant.paymentId,uuid(),'2020-01-01T00:00:00.'+fraction+'Z']);
  }
  const expected = (await pool.query('SELECT id FROM ledger_entries WHERE mentee_id=$1 ORDER BY created_at DESC,id DESC',[menteeId])).rows;
  const ids = [];
  let cursor;
  do {
    const page = await (await get('/transactions?limit=2'+(cursor?'&cursor='+cursor:''),menteeId)).json();
    ids.push(...page.items.map(row=>row.id));
    cursor = page.nextCursor;
  } while (cursor && ids.length<=expected.length);
  assert.deepEqual(ids,expected.map(row=>row.id));
  for (const invalid of ['bad',uuid(),expected[0].id]) {
    const response = await get('/transactions?cursor='+invalid,empty);
    assert.equal(response.status,400);
    assert.equal((await response.json()).code,'INVALID_PAGE');
  }
});

test('both endpoints require a mentee and ignore attempts to select another wallet', async () => {
  const { grant } = await fixture();
  await append(grant);
  for (const path of ['', '/transactions']) {
    for (const [user,status] of [[null,401],[mentor,403],[adminId,403]]) {
      assert.equal((await get(path,user)).status,status);
    }
  }
  const page = { items:[], nextCursor:null };
  const response = await get('?menteeId='+grant.menteeId,empty);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ normal:0,rollover:0,debt:0,totalSpendable:0,rolloverLots:[],history:page });
  assert.deepEqual(await (await get('/transactions?menteeId='+grant.menteeId,empty)).json(),page);
});
