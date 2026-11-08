import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

// Mentor policy (US-13). Deliberately independent of the mentee 24-hour policy: a mentor may cancel
// any time before a terminal outcome, before or after the official start, and the mentee always
// gets the session's credit back.
export type MentorCancellationDecision =
  | { action: 'cancel' }
  | { action: 'replay' }
  | { action: 'reject'; status: string; cancelledBy: 'mentee' | 'mentor' | null };

export function mentorCancellationDecision(session: { status: string; cancelledBy: 'mentee' | 'mentor' | null }): MentorCancellationDecision {
  if (session.status === 'scheduled' || session.status === 'in_progress') return { action: 'cancel' };
  // A committed mentor cancellation is the same outcome: retries are stable no-ops.
  if (session.status === 'cancelled' && session.cancelledBy === 'mentor') return { action: 'replay' };
  // Completed, either no-show, or a mentee cancellation already decided the money: incompatible.
  return { action: 'reject', status: session.status, cancelledBy: session.status === 'cancelled' ? session.cancelledBy : null };
}

export function mentorCancellationRequest(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'reason')) {
    throw invalid();
  }
  const { reason } = body as { reason?: unknown };
  if (reason === undefined) return null;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw invalid();
  return reason.trim();
}

function invalid() {
  return new UnprocessableEntityException({ code: 'INVALID_CANCELLATION_REQUEST',
    message: 'Optional body: {"reason":"..."} with 1-500 characters.' });
}

export function mentorCannotCancel(status: string, cancelledBy: 'mentee' | 'mentor' | null): never {
  throw new ConflictException({ code: 'SESSION_NOT_CANCELLABLE',
    message: 'This session already has a final outcome and cannot be cancelled.', details: { status, cancelledBy } });
}
