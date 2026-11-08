import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
import { verifiedEvent } from '../dist/payments/webhook.js';

const secret = randomBytes(32).toString('hex');
const event = { eventId:'evt-1', paymentId:'fake_1', type:'payment.succeeded', occurredAt:'2026-11-08T12:00:00.000Z' };
const sign = bytes => 'sha256=' + createHmac('sha256',secret).update(bytes).digest('hex');

test('HMAC authenticates exact bytes before parsing the payload', () => {
  const bytes = Buffer.from(JSON.stringify(event, null, 2));
  assert.deepEqual(verifiedEvent(bytes,sign(bytes),secret),event);
  assert.throws(() => verifiedEvent(Buffer.from(JSON.stringify(event)),sign(bytes),secret), e => e.getStatus()===401);
  for (const signature of [undefined, 'sha256=no', 'sha256='+'0'.repeat(64)]) {
    assert.throws(() => verifiedEvent(bytes,signature,secret), e => e.getStatus()===401);
  }
  const broken = Buffer.from('{');
  assert.throws(() => verifiedEvent(broken,sign(broken),secret), e=>e.getResponse().code==='INVALID_WEBHOOK_PAYLOAD');
});

test('validates event identity, UTC date, optional pack and supported event type', () => {
  for (const change of [{ eventId:'' },{ paymentId:null },{ occurredAt:'2026-02-30T12:00:00Z' },
    {packCredits:'4'},{menteeId:'spoof'},{type:'unknown'}]) {
    const bytes = Buffer.from(JSON.stringify({...event,...change}));
    assert.throws(()=>verifiedEvent(bytes,sign(bytes),secret));
  }
  const refund = {...event,type:'payment.refunded',occurredAt:'2026-11-08T12:00:00Z'};
  const bytes = Buffer.from(JSON.stringify(refund));
  assert.deepEqual(verifiedEvent(bytes,sign(bytes),secret),refund);
});
