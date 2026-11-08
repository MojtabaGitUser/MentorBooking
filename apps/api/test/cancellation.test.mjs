import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancellationRequest, menteeCancellationPolicy, REFUND_WINDOW_MS } from '../dist/sessions/cancellation-policy.js';

const startsAt = new Date('2030-06-03T10:00:00Z');
const session = (status = 'scheduled') => ({ id: 's1', status, startsAt });
const at = offsetMs => new Date(startsAt.getTime() + offsetMs);
const H = 3_600_000;
const outcome = (now, status) => {
  const p = menteeCancellationPolicy(session(status), now);
  return [p.eligible, p.refundableCredits, p.refundType, p.reason];
};

test('strict 24-hour boundary: more than 24h refunds 1, exactly 24h and less refund 0', () => {
  assert.equal(REFUND_WINDOW_MS, 24 * H);
  assert.deepEqual(outcome(at(-48 * H)), [true, 1, 'FULL', 'MORE_THAN_24_HOURS_BEFORE_START']);
  assert.deepEqual(outcome(at(-24 * H - 1)), [true, 1, 'FULL', 'MORE_THAN_24_HOURS_BEFORE_START']);
  assert.deepEqual(outcome(at(-24 * H)), [true, 0, 'NONE', 'WITHIN_24_HOURS_OF_START']);
  assert.deepEqual(outcome(at(-24 * H + 1)), [true, 0, 'NONE', 'WITHIN_24_HOURS_OF_START']);
  assert.deepEqual(outcome(at(-(23 * H + 59 * 60_000))), [true, 0, 'NONE', 'WITHIN_24_HOURS_OF_START']);
  assert.deepEqual(outcome(at(-1)), [true, 0, 'NONE', 'WITHIN_24_HOURS_OF_START']);
});

test('the official start closes cancellation even while the stored status is still scheduled', () => {
  assert.deepEqual(outcome(at(0)), [false, 0, 'NONE', 'SESSION_STARTED']);
  assert.deepEqual(outcome(at(60_000)), [false, 0, 'NONE', 'SESSION_STARTED']);
});

test('only scheduled sessions are cancellable by the mentee', () => {
  for (const status of ['in_progress', 'completed', 'no_show_mentee', 'no_show_mentor']) {
    assert.deepEqual(outcome(at(-48 * H), status), [false, 0, 'NONE', 'NOT_SCHEDULED'], status);
  }
  assert.deepEqual(outcome(at(-48 * H), 'cancelled'), [false, 0, 'NONE', 'ALREADY_CANCELLED']);
});

test('preview exposes exact UTC instants for the start, the cutoff and the server clock', () => {
  const now = new Date('2030-06-01T09:15:30.250Z');
  assert.deepEqual(menteeCancellationPolicy(session(), now), {
    sessionId: 's1', status: 'scheduled', eligible: true, refundableCredits: 1, refundType: 'FULL',
    reason: 'MORE_THAN_24_HOURS_BEFORE_START', startsAt: '2030-06-03T10:00:00Z', cutoffAt: '2030-06-02T10:00:00Z',
    serverNow: '2030-06-01T09:15:30.250Z' });
});

test('confirmation body must carry exactly the previewed refund amount', () => {
  assert.equal(cancellationRequest({ expectedRefundableCredits: 1 }), 1);
  assert.equal(cancellationRequest({ expectedRefundableCredits: 0 }), 0);
  for (const body of [undefined, null, {}, [], { expectedRefundableCredits: 2 }, { expectedRefundableCredits: '1' },
    { expectedRefundableCredits: true }, { expectedRefundableCredits: 1, reason: 'x' }]) {
    assert.throws(() => cancellationRequest(body), error => error.getStatus() === 422 &&
      error.getResponse().code === 'INVALID_CANCELLATION_REQUEST', JSON.stringify(body));
  }
});
