import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DateTime } from 'luxon';

export const SESSION_MINUTES = 30;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
// An explicit Z or numeric offset is required, so the instant is never interpreted in a server zone.
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const idempotencyKey = /^[!-~]{1,128}$/;

export interface BookingRequest {
  mentorId: string;
  startsAt: Date;
  idempotencyKey: string | null;
}

export type UnavailableReason = 'IN_PAST' | 'OUTSIDE_AVAILABILITY' | 'BLOCKED' | 'BOOKED';

function invalidRequest(message: string): never {
  throw new UnprocessableEntityException({ code: 'INVALID_BOOKING_REQUEST', message });
}

export function mentorNotFound(): never {
  throw new NotFoundException({ code: 'MENTOR_NOT_FOUND', message: 'Mentor not found.' });
}

export function slotUnavailable(reason: UnavailableReason): never {
  throw new ConflictException({ code: 'SLOT_UNAVAILABLE',
    message: 'This time slot is no longer available. Please select another slot.', details: { reason } });
}

export function sessionOverlap(): never {
  throw new ConflictException({ code: 'SESSION_OVERLAP',
    message: 'You already have a session that overlaps this time.' });
}

export function insufficientCredits(): never {
  throw new ConflictException({ code: 'INSUFFICIENT_CREDITS',
    message: 'You need at least one spendable credit to book a session.' });
}

export function idempotencyConflict(): never {
  throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT',
    message: 'This Idempotency-Key was already used for a different booking.' });
}

// Only syntax is validated here; existence, availability and credit are checked under locks.
export function bookingRequest(body: unknown, key: unknown): BookingRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalidRequest('Expected a JSON object.');
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('mentorId') || !keys.includes('startsAt')) {
    invalidRequest('Provide exactly mentorId and startsAt.');
  }
  const { mentorId, startsAt } = body as Record<string, unknown>;
  if (typeof mentorId !== 'string') invalidRequest('mentorId must be a string.');
  if (typeof startsAt !== 'string' || !instant.test(startsAt)) {
    invalidRequest('startsAt must be an ISO-8601 instant with Z or an explicit offset.');
  }
  const parsed = DateTime.fromISO(startsAt, { setZone: true });
  if (!parsed.isValid) invalidRequest('startsAt is not a valid instant.');
  if (key !== undefined && (typeof key !== 'string' || !idempotencyKey.test(key))) {
    invalidRequest('Idempotency-Key must be 1-128 visible ASCII characters.');
  }
  if (!uuid.test(mentorId)) mentorNotFound();
  return { mentorId: mentorId.toLowerCase(), startsAt: parsed.toJSDate(), idempotencyKey: (key as string | undefined) ?? null };
}

// Sessions start on :00 or :30 of the mentor's wall clock (this differs from UTC in +05:45 zones).
export function assertAligned(startsAt: Date, mentorZone: string) {
  const local = DateTime.fromJSDate(startsAt, { zone: mentorZone });
  if (local.second !== 0 || local.millisecond !== 0 || local.minute % SESSION_MINUTES !== 0) {
    throw new UnprocessableEntityException({ code: 'INVALID_SLOT',
      message: 'Sessions start on the hour or half hour in the mentor\'s timezone.' });
  }
}

export function utcInstant(value: Date) {
  return DateTime.fromJSDate(value, { zone: 'utc' }).toISO({ suppressMilliseconds: true });
}

// Exclusion violations are the final guard if a writer bypasses the application locks.
export function exclusionConflict(error: unknown) {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code !== '23P01') return null;
  if (constraint === 'sessions_mentor_overlap') return () => slotUnavailable('BOOKED');
  if (constraint === 'sessions_mentee_overlap') return () => sessionOverlap();
  return null;
}
