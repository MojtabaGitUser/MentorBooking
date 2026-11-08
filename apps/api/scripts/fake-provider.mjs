import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { payment: { type:'string' }, event: { type:'string' } } });
if (!values.payment || !['succeeded','refunded'].includes(values.event)) {
  throw Error('Usage: --payment <providerPaymentId> --event succeeded|refunded');
}
const secret = process.env.WEBHOOK_SECRET ||
  (process.env.WEBHOOK_SECRET_FILE && readFileSync(process.env.WEBHOOK_SECRET_FILE, 'utf8').trim());
if (!secret) throw Error('Configure the webhook signing secret.');
const body = JSON.stringify({ eventId: randomUUID(), paymentId: values.payment,
  type: 'payment.' + values.event, occurredAt: new Date().toISOString() });
const signature = createHmac('sha256', secret).update(body).digest('hex');
const endpoint = new URL('/webhooks/fake-payments', process.env.PAYMENT_API_URL ?? 'http://api:3001');
const response = await fetch(endpoint, { method:'POST', body, redirect:'error', signal: globalThis.AbortSignal.timeout(10000),
  headers: { 'Content-Type':'application/json', 'X-Webhook-Signature':'sha256=' + signature } });
console.log(response.status, await response.text());
if (!response.ok) process.exitCode = 1;
