import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BadRequestException, ServiceUnavailableException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';

export interface PaymentEvent {
  eventId: string;
  paymentId: string;
  occurredAt: string;
  type: 'payment.succeeded' | 'payment.refunded';
  packCredits?: number;
}

export function webhookSecret() {
  if (process.env.WEBHOOK_SECRET) return process.env.WEBHOOK_SECRET;
  if (process.env.WEBHOOK_SECRET_FILE) {
    const key = readFileSync(process.env.WEBHOOK_SECRET_FILE, 'utf8').trim();
    if (key) return key;
  }
  throw new ServiceUnavailableException({ code: 'WEBHOOK_UNCONFIGURED', message: 'Webhook signing is unavailable.' });
}

function invalidPayload(): never {
  throw new BadRequestException({ code: 'INVALID_WEBHOOK_PAYLOAD', message: 'Invalid payment event payload.' });
}

export function verifiedEvent(raw: unknown, signature: unknown, secret: string): PaymentEvent {
  if (!Buffer.isBuffer(raw) || typeof signature !== 'string' || !/^sha256=[0-9a-fA-F]{64}$/.test(signature) ||
      !timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), Buffer.from(signature.slice(7), 'hex'))) {
    throw new UnauthorizedException({ code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature.' });
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { invalidPayload(); }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !['eventId','paymentId','occurredAt','type','packCredits'].includes(k))) invalidPayload();
  for (const id of [body.eventId, body.paymentId]) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_:-]{1,128}$/.test(id)) invalidPayload();
  }
  if (typeof body.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(body.occurredAt)) invalidPayload();
  const instant = new Date(body.occurredAt);
  const canonical = body.occurredAt.includes('.') ? body.occurredAt : body.occurredAt.slice(0, -1) + '.000Z';
  if (!Number.isFinite(+instant) || instant.toISOString() !== canonical) invalidPayload();
  if (body.packCredits !== undefined && (!Number.isSafeInteger(body.packCredits) || body.packCredits <= 0)) invalidPayload();
  if (typeof body.type !== 'string' || !body.type) invalidPayload();
  if (body.type !== 'payment.succeeded' && body.type !== 'payment.refunded') {
    throw new UnprocessableEntityException({ code: 'UNSUPPORTED_EVENT', message: 'Unsupported payment event.' });
  }
  return body;
}
