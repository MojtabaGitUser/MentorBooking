import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAligned, bookingRequest, exclusionConflict } from '../dist/sessions/booking-input.js';
import { isOfferedStart } from '../dist/mentor/slots.js';

const mentorId = '00000000-0000-4000-8000-000000000001';
const code = (fn) => { try { fn(); } catch (error) { return [error.getStatus(), error.getResponse().code]; } return null; };
const rule = (weekday, startMinute, endMinute) => ({ weekday, startMicros: startMinute * 60e6, endMicros: endMinute * 60e6 });
const at = iso => Date.parse(iso);

test('request accepts only mentorId and an explicit-offset instant; mentee identity is never read from the body', () => {
  const parsed = bookingRequest({ mentorId, startsAt: '2030-01-07T09:00:00+05:30' }, 'retry-1');
  assert.deepEqual(parsed, { mentorId, startsAt: new Date('2030-01-07T03:30:00Z'), idempotencyKey: 'retry-1' });
  assert.equal(bookingRequest({ mentorId: mentorId.toUpperCase(), startsAt: '2030-01-07T03:30Z' }).mentorId, mentorId);
  for (const body of [null, [], {}, { mentorId }, { mentorId, startsAt: '2030-01-07T03:30:00Z', menteeId: mentorId },
    { mentorId, startsAt: '2030-01-07T03:30:00' }, { mentorId, startsAt: '2030-01-07' }, { mentorId, startsAt: 1893987000000 },
    { mentorId, startsAt: '2030-02-30T03:30:00Z' }, { mentorId: 7, startsAt: '2030-01-07T03:30:00Z' }]) {
    assert.deepEqual(code(() => bookingRequest(body)), [422, 'INVALID_BOOKING_REQUEST'], JSON.stringify(body));
  }
  for (const key of ['', 'x'.repeat(129), 'has space', 'ü']) {
    assert.deepEqual(code(() => bookingRequest({ mentorId, startsAt: '2030-01-07T03:30:00Z' }, key)), [422, 'INVALID_BOOKING_REQUEST']);
  }
  assert.deepEqual(code(() => bookingRequest({ mentorId: 'not-a-uuid', startsAt: '2030-01-07T03:30:00Z' })), [404, 'MENTOR_NOT_FOUND']);
});

test('alignment is checked on the mentor wall clock, including sub-second and quarter-hour offsets', () => {
  assert.equal(code(() => assertAligned(new Date('2030-01-07T03:30:00Z'), 'Asia/Kolkata')), null);
  assert.equal(code(() => assertAligned(new Date('2030-01-07T03:45:00Z'), 'Asia/Kathmandu')), null);
  for (const [iso, zone] of [['2030-01-07T03:30:00Z', 'Asia/Kathmandu'], ['2030-01-07T03:15:00Z', 'UTC'],
    ['2030-01-07T03:30:01Z', 'UTC'], ['2030-01-07T03:30:00.001Z', 'UTC']]) {
    assert.deepEqual(code(() => assertAligned(new Date(iso), zone)), [422, 'INVALID_SLOT'], iso + ' ' + zone);
  }
});

test('booking revalidation accepts exactly the preview slots across the London spring gap', () => {
  const sunday = [rule(7, 0, 240)];
  for (const iso of ['2030-03-31T00:00:00Z', '2030-03-31T00:30:00Z', '2030-03-31T01:00:00Z', '2030-03-31T02:30:00Z']) {
    assert.ok(isOfferedStart(at(iso), 'Europe/London', sunday), iso);
  }
  // 03:00Z is 04:00 BST, the rule end; Saturday 23:30Z is outside the Sunday rule.
  for (const iso of ['2030-03-31T03:00:00Z', '2030-03-30T23:30:00Z']) assert.ok(!isOfferedStart(at(iso), 'Europe/London', sunday), iso);
});

test('booking revalidation accepts only the earlier occurrence of repeated fall-back labels', () => {
  const sunday = [rule(7, 0, 240)];
  assert.ok(isOfferedStart(at('2030-10-27T00:00:00Z'), 'Europe/London', sunday));  // 01:00 BST
  assert.ok(isOfferedStart(at('2030-10-27T00:30:00Z'), 'Europe/London', sunday));  // 01:30 BST
  assert.ok(!isOfferedStart(at('2030-10-27T01:00:00Z'), 'Europe/London', sunday)); // 01:00 GMT, repeated label
  assert.ok(!isOfferedStart(at('2030-10-27T01:30:00Z'), 'Europe/London', sunday)); // 01:30 GMT, repeated label
  assert.ok(isOfferedStart(at('2030-10-27T02:00:00Z'), 'Europe/London', sunday));  // 02:00 GMT
});

test('mentor-local weekday drives revalidation when the UTC date differs', () => {
  const mondayEarly = [rule(1, 0, 120)];
  // Monday 01:00 in Kolkata is Sunday 19:30 UTC.
  assert.ok(isOfferedStart(at('2030-01-06T19:30:00Z'), 'Asia/Kolkata', mondayEarly));
  assert.ok(!isOfferedStart(at('2030-01-07T19:30:00Z'), 'Asia/Kolkata', mondayEarly));
});

test('PostgreSQL exclusion violations map to stable domain conflicts; other errors are not masked', () => {
  const mapped = constraint => code(exclusionConflict({ code: '23P01', constraint }));
  assert.deepEqual(mapped('sessions_mentor_overlap'), [409, 'SLOT_UNAVAILABLE']);
  assert.deepEqual(mapped('sessions_mentee_overlap'), [409, 'SESSION_OVERLAP']);
  assert.equal(exclusionConflict({ code: '23P01', constraint: 'other' }), null);
  assert.equal(exclusionConflict({ code: '23505', constraint: 'sessions_mentor_overlap' }), null);
});
