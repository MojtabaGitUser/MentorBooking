import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const idempotencyKey = /^[!-~]{1,128}$/;
// A sanity bound against fat-finger mistakes; adjustments are single-pack-scale corrections.
export const MAX_ADJUSTMENT = 1000;

export interface AdjustmentRequest {
  delta: number;
  reason: string;
  idempotencyKey: string;
}

function invalid(message: string): never {
  throw new UnprocessableEntityException({ code: 'INVALID_ADJUSTMENT', message });
}

export function targetUserId(id: string) {
  if (!uuid.test(id)) throw new NotFoundException({ code: 'TARGET_USER_NOT_FOUND', message: 'User not found.' });
  return id.toLowerCase();
}

// The acting administrator always comes from authentication; the body cannot name one.
export function adjustmentRequest(body: unknown): AdjustmentRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Expected a JSON object.');
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'delta,idempotencyKey,reason') invalid('Provide exactly delta, reason and idempotencyKey.');
  const { delta, reason, idempotencyKey: key } = body as Record<string, unknown>;
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ADJUSTMENT) {
    invalid(`delta must be a nonzero integer between -${MAX_ADJUSTMENT} and ${MAX_ADJUSTMENT}.`);
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) invalid('A reason of 1-500 characters is required.');
  if (typeof key !== 'string' || !idempotencyKey.test(key)) invalid('idempotencyKey must be 1-128 visible ASCII characters.');
  return { delta, reason: reason.trim(), idempotencyKey: key };
}
