import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mentorCancellationDecision, mentorCancellationRequest } from '../dist/sessions/mentor-cancellation-policy.js';
import { adjustmentRequest, MAX_ADJUSTMENT, targetUserId } from '../dist/admin/admin-input.js';

const failure = fn => { try { fn(); } catch (error) { return [error.getStatus(), error.getResponse().code]; } return null; };

test('mentor policy: cancel while scheduled or in progress, replay own cancellation, reject other outcomes', () => {
  assert.deepEqual(mentorCancellationDecision({ status: 'scheduled', cancelledBy: null }), { action: 'cancel' });
  assert.deepEqual(mentorCancellationDecision({ status: 'in_progress', cancelledBy: null }), { action: 'cancel' });
  assert.deepEqual(mentorCancellationDecision({ status: 'cancelled', cancelledBy: 'mentor' }), { action: 'replay' });
  assert.deepEqual(mentorCancellationDecision({ status: 'cancelled', cancelledBy: 'mentee' }),
    { action: 'reject', status: 'cancelled', cancelledBy: 'mentee' });
  for (const status of ['completed', 'no_show_mentee', 'no_show_mentor']) {
    assert.deepEqual(mentorCancellationDecision({ status, cancelledBy: null }), { action: 'reject', status, cancelledBy: null });
  }
});

test('mentor policy has no time input: it is independent of the mentee 24-hour rule', () => {
  assert.equal(mentorCancellationDecision.length, 1);
  assert.deepEqual(Object.keys(mentorCancellationDecision({ status: 'scheduled', cancelledBy: null })), ['action']);
});

test('mentor cancellation body is optional; a reason must be 1-500 characters', () => {
  for (const body of [undefined, null, {}]) assert.equal(mentorCancellationRequest(body), null);
  assert.equal(mentorCancellationRequest({ reason: '  Sick  ' }), 'Sick');
  for (const body of [[], { reason: '' }, { reason: '   ' }, { reason: 7 }, { reason: 'x'.repeat(501) }, { actor: 'admin' }]) {
    assert.deepEqual(failure(() => mentorCancellationRequest(body)), [422, 'INVALID_CANCELLATION_REQUEST'], JSON.stringify(body));
  }
});

test('admin adjustment requires a nonzero bounded integer, a nonblank reason and a key; no actor field', () => {
  assert.deepEqual(adjustmentRequest({ delta: -2, reason: ' goodwill ', idempotencyKey: 'adj-1' }),
    { delta: -2, reason: 'goodwill', idempotencyKey: 'adj-1' });
  const valid = { delta: 1, reason: 'r', idempotencyKey: 'k' };
  for (const body of [null, [], {}, { ...valid, delta: 0 }, { ...valid, delta: 1.5 }, { ...valid, delta: '1' },
    { ...valid, delta: MAX_ADJUSTMENT + 1 }, { ...valid, reason: '' }, { ...valid, reason: '  ' }, { delta: 1, idempotencyKey: 'k' },
    { ...valid, idempotencyKey: '' }, { ...valid, idempotencyKey: 'has space' }, { ...valid, adminId: 'x' }]) {
    assert.deepEqual(failure(() => adjustmentRequest(body)), [422, 'INVALID_ADJUSTMENT'], JSON.stringify(body));
  }
  assert.deepEqual(failure(() => targetUserId('nope')), [404, 'TARGET_USER_NOT_FOUND']);
});
