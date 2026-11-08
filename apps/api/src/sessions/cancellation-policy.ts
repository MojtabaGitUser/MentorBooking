import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { utcInstant } from './booking-input';

// Mentee policy only. Mentor cancellation (US-13) always refunds and must not reuse this function.
export const REFUND_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CancellationReason = 'MORE_THAN_24_HOURS_BEFORE_START' | 'WITHIN_24_HOURS_OF_START' |
  'SESSION_STARTED' | 'ALREADY_CANCELLED' | 'NOT_SCHEDULED';

export interface SessionTiming {
  id: string;
  status: string;
  startsAt: Date;
}

export interface CancellationPreview {
  sessionId: string;
  status: string;
  eligible: boolean;
  refundableCredits: 0 | 1;
  refundType: 'FULL' | 'NONE';
  reason: CancellationReason;
  startsAt: string;
  cutoffAt: string;
  serverNow: string;
}

// Strict rule: a refund needs startsAt - now > 24h, i.e. now < cutoffAt. Exactly 24h refunds nothing.
// The official start, not the stored status, closes cancellation, so a delayed worker cannot reopen it.
export function menteeCancellationPolicy(session: SessionTiming, now: Date): CancellationPreview {
  const cutoff = new Date(session.startsAt.getTime() - REFUND_WINDOW_MS);
  let reason: CancellationReason;
  if (session.status === 'cancelled') reason = 'ALREADY_CANCELLED';
  else if (session.status !== 'scheduled') reason = 'NOT_SCHEDULED';
  else if (now.getTime() >= session.startsAt.getTime()) reason = 'SESSION_STARTED';
  else if (now.getTime() < cutoff.getTime()) reason = 'MORE_THAN_24_HOURS_BEFORE_START';
  else reason = 'WITHIN_24_HOURS_OF_START';
  const eligible = reason === 'MORE_THAN_24_HOURS_BEFORE_START' || reason === 'WITHIN_24_HOURS_OF_START';
  const refundableCredits = reason === 'MORE_THAN_24_HOURS_BEFORE_START' ? 1 : 0;
  return { sessionId: session.id, status: session.status, eligible, refundableCredits,
    refundType: refundableCredits ? 'FULL' : 'NONE', reason,
    startsAt: utcInstant(session.startsAt)!, cutoffAt: utcInstant(cutoff)!, serverNow: now.toISOString() };
}

// The client confirms the outcome it was shown; the server never applies a different one.
export function cancellationRequest(body: unknown): 0 | 1 {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !('expectedRefundableCredits' in body) || ![0, 1].includes(body.expectedRefundableCredits as number)) {
    throw new UnprocessableEntityException({ code: 'INVALID_CANCELLATION_REQUEST',
      message: 'Send {"expectedRefundableCredits":0|1} from the cancellation preview.' });
  }
  return body.expectedRefundableCredits as 0 | 1;
}

export function notCancellable(currentPreview: CancellationPreview): never {
  throw new ConflictException({ code: 'SESSION_NOT_CANCELLABLE',
    message: 'This session can no longer be cancelled.', details: { currentPreview } });
}

export function policyChanged(currentPreview: CancellationPreview): never {
  throw new ConflictException({ code: 'CANCELLATION_POLICY_CHANGED',
    message: 'The refund outcome has changed. Review it and confirm again.', details: { currentPreview } });
}
