import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RolloverService } from '../dist/wallet/rollover.service.js';
import { randomUUID as uuid } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../dist/api.module.js';
import { LedgerService } from '../dist/wallet/ledger.service.js';
import { WalletService } from '../dist/wallet/wallet.service.js';
import { connectionOptions } from '../../../infra/db/config.cjs';

let app, pool, ledger, wallets, rollover, base, created;
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
  rollover = app.get(RolloverService);
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

const cutoff = new Date('2070-01-01T00:00:00Z');
const beforeExpiry = new Date(+cutoff-1);

async function rolloverLot(f, quantity, {id=uuid(), expires=cutoff, createdAt='2069-12-01T00:00:00Z'} = {}) {
  await pool.query(`INSERT INTO credit_lots (id,mentee_id,credit_type,original_quantity,session_id,created_at,expires_at)
    VALUES ($1,$2,'ROLLOVER',$3,$4,$5,$6)`, [id,f.menteeId,quantity,f.sessionId,createdAt,expires]);
  await append({menteeId:f.menteeId, lotId:id, sessionId:f.sessionId, kind:'NO_SHOW_ROLLOVER',
    delta:quantity, idempotencyKey:uuid()});
  return id;
}
const pick = (f, when) => transaction(tx=>rollover.selectSpendableLot(tx,f.menteeId,when));
async function debit(tx, f, lotId, sessionId=f.sessionId) {
  return ledger.appendEntry(tx,{menteeId:f.menteeId, lotId, sessionId, kind:'BOOKING_DEBIT',delta:-1,idempotencyKey:uuid()});
}
async function expiryEntries(lotId) {
  return (await pool.query("SELECT delta, reason, idempotency_key FROM ledger_entries WHERE lot_id=$1 AND kind='ROLLOVER_EXPIRE'",[lotId])).rows;
}
async function waitForBlockedSpenderOrWorker(blocker) {
  for (let i=0; i<100; i++) {
    const { rows } = await pool.query(`SELECT EXISTS (SELECT FROM pg_stat_activity
      WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))) AS blocked`,[blocker]);
    if (rows[0].blocked) return;
    await delay(25);
  }
  assert.fail('expected an independent PostgreSQL connection to wait on the mentee lock');
}

test('rollover selection orders by expiry, creation instant and UUID before normal credit', async () => {
  const f = await fixture();
  await append({...f.grant,delta:2});
  const later = await rolloverLot(f,1,{expires:new Date(+cutoff+1000)});
  const newer = await rolloverLot(f,1,{createdAt:'2069-12-02T00:00:00Z'});
  const tied = [uuid(),uuid()].sort();
  await rolloverLot(f,1,{id:tied[1]});
  await rolloverLot(f,1,{id:tied[0]});
  for (const expected of [...tied,newer,later]) {
    await transaction(async tx=>{
      const lot = await rollover.selectSpendableLot(tx,f.menteeId,beforeExpiry);
      assert.equal(lot.lotId,expected);
      await debit(tx,f,lot.lotId);
    });
    assert.equal((await wallets.getWallet(f.menteeId,cutoff)).normal,2);
  }
  assert.equal((await pick(f,beforeExpiry)).lotId,f.lotId);
});

test('exact expiry gates selection and wallet immediately; a sweep records only the unspent remainder', async () => {
  const f=await fixture();
  const id=await rolloverLot(f,3);
  await transaction(async tx=>{
    assert.equal((await rollover.selectSpendableLot(tx,f.menteeId,beforeExpiry)).lotId,id);
    await debit(tx,f,id);
  });
  for (const instant of [cutoff,new Date(+cutoff+1)]) {
    assert.equal(await pick(f,instant),null);
    assert.equal((await wallets.getWallet(f.menteeId,instant)).totalSpendable,0);
  }
  assert.deepEqual(await expiryEntries(id),[]);
  await rollover.expireRolloverLots(cutoff);
  await rollover.expireRolloverLots(cutoff);
  const rows = await expiryEntries(id);
  assert.equal(rows.length,1);
  assert.equal(rows[0].delta,-2);
  assert.equal((await wallets.getWallet(f.menteeId,beforeExpiry)).rollover,2);
  assert.equal(rows[0].idempotency_key,'rollover-expire:'+id);
  assert.match(rows[0].reason,/expired/i);
  await assert.rejects(pool.query('DELETE FROM ledger_entries WHERE lot_id=$1',[id]),{code:'42501'});
});

test('concurrent expiry runs recheck under lock and keep another mentee and normal credits isolated', async () => {
  const f=await fixture(), other=await fixture();
  const id=await rolloverLot(f,1);
  await append(f.grant);
  const otherLot=await rolloverLot(other,2,{expires:new Date(+cutoff+1)});
  const tx=await pool.connect();
  let workers=[];
  try {
    await tx.query('BEGIN');
    await ledger.lockMentee(tx,f.menteeId);
    workers=[rollover.expireRolloverLots(cutoff),rollover.expireRolloverLots(cutoff)];
    await waitForBlockedSpenderOrWorker(tx.processID);
    await tx.query('COMMIT');
    const results=await Promise.all(workers);
    assert.equal(results.reduce((n,r)=>n+r.expiredLots,0),1);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
    await Promise.allSettled(workers);
  }
  assert.equal((await expiryEntries(id)).length,1);
  assert.deepEqual(await expiryEntries(otherLot),[]);
  assert.deepEqual([(await wallets.getWallet(f.menteeId,cutoff)).normal,(await pick(other,cutoff)).remaining],[4,2]);
});

test('expiry waits for an in-flight booking debit and preserves the future session and allocation', async () => {
  const f=await fixture();
  const id=await rolloverLot(f,1);
  const tx=await pool.connect();
  let sweep;
  try {
    await tx.query('BEGIN');
    const chosen=await rollover.selectSpendableLot(tx,f.menteeId,beforeExpiry);
    const { rows }=await tx.query(`INSERT INTO sessions (mentor_id,mentee_id,starts_at,ends_at)
      VALUES ($1,$2,'2071-01-01T10:00Z','2071-01-01T10:30Z') RETURNING id`,[mentor,f.menteeId]);
    const sessionId=rows[0].id;
    await debit(tx,f,chosen.lotId,sessionId);
    await tx.query('INSERT INTO session_credit_allocations (session_id,lot_id,mentee_id) VALUES ($1,$2,$3)',[sessionId,id,f.menteeId]);
    sweep=rollover.expireRolloverLots(cutoff);
    await waitForBlockedSpenderOrWorker(tx.processID);
    await tx.query('COMMIT');
    await sweep;
    assert.deepEqual(await expiryEntries(id),[]);
    const allocation=await pool.query(`SELECT s.status,a.lot_id FROM sessions s
      JOIN session_credit_allocations a ON a.session_id=s.id WHERE s.id=$1`,[sessionId]);
    assert.deepEqual(allocation.rows,[{status:'scheduled',lot_id:id}]);
    assert.equal(await pick(f,cutoff),null);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
    if (sweep) await sweep;
  }
});

test('two spenders only debit the last rollover once; a liability can block a positive lot', async () => {
  const f=await fixture();
  await rolloverLot(f,1);
  const spend=()=>transaction(async tx=>{
    const chosen=await rollover.selectSpendableLot(tx,f.menteeId,beforeExpiry);
    if (chosen) await debit(tx,f,chosen.lotId);
    return Boolean(chosen);
  });
  assert.deepEqual((await Promise.all([spend(),spend()])).sort(),[false,true]);
  await rolloverLot(f,1);
  await append(f.grant);
  await append({...f.grant,kind:'PAYMENT_REVERSAL',delta:-4,idempotencyKey:uuid()});
  await append({...f.grant,kind:'DEBT',delta:-1,idempotencyKey:uuid()});
  assert.equal(await pick(f,beforeExpiry),null);
});

test('failure rolls back expiry entries for the current mentee; retry journals each lot once', async t => {
  const f=await fixture();
  const ids=[await rolloverLot(f,1),await rolloverLot(f,2)];
  const appendEntry=ledger.appendEntry.bind(ledger);
  let writes=0;
  const fail=t.mock.method(ledger,'appendEntry',async (tx,input)=>{
    const entry=await appendEntry(tx,input);
    if (input.menteeId===f.menteeId && ++writes===2) throw Error('test-only expiry failure');
    return entry;
  });
  await assert.rejects(rollover.expireRolloverLots(cutoff),/test-only expiry failure/);
  fail.mock.restore();
  for (const id of ids) assert.deepEqual(await expiryEntries(id),[]);
  await rollover.expireRolloverLots(cutoff);
  await rollover.expireRolloverLots(cutoff);
  for (const [i,id] of ids.entries()) assert.deepEqual((await expiryEntries(id)).map(e=>e.delta),[-(i+1)]);
});

test('a waiting selector uses the database clock after locking, not the transaction start time', async () => {
  const f = await fixture();
  const spender = await pool.connect();
  const owner = await pool.connect();
  let selection;
  try {
    await spender.query('BEGIN');
    await owner.query('BEGIN');
    await ledger.lockMentee(owner, f.menteeId);
    const { rows } = await owner.query(`INSERT INTO credit_lots
      (mentee_id,credit_type,original_quantity,session_id,created_at,expires_at)
      VALUES ($1,'ROLLOVER',1,$2,now()-interval '30 days',clock_timestamp()) RETURNING id`, [f.menteeId,f.sessionId]);
    await ledger.appendEntry(owner,{menteeId:f.menteeId,lotId:rows[0].id,sessionId:f.sessionId,
      kind:'NO_SHOW_ROLLOVER',delta:1,idempotencyKey:uuid()});
    selection = rollover.selectSpendableLot(spender,f.menteeId);
    await waitForBlockedSpenderOrWorker(owner.processID);
    await owner.query('COMMIT');
    assert.equal(await selection,null);
    const clock = await spender.query('SELECT now()<expires_at AS started_before_expiry FROM credit_lots WHERE id=$1',[rows[0].id]);
    assert.equal(clock.rows[0].started_before_expiry,true);
  } finally {
    await owner.query('ROLLBACK');
    owner.release();
    try { await selection; } finally {
      await spender.query('ROLLBACK');
      spender.release();
    }
  }
});
