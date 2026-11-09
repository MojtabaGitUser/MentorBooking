import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canTransition, classifyAttendance, isTerminal, joinDecision, rolloverExpiresAt, resolutionDueAt,
  EARLY_JOIN_MS, NO_SHOW_ROLLOVER_MS } from '../dist/sessions/lifecycle-policy.js';

const startsAt = new Date('2030-06-03T14:00:00Z');
const endsAt = new Date('2030-06-03T14:30:00Z');
const at = ms => new Date(startsAt.getTime() + ms);
const decide = (now, status = 'scheduled') => {
  try { return joinDecision({ status, startsAt, endsAt }, now); } catch (error) { return error.getResponse().code; }
};
const T = new Date('2030-01-01T00:00:00Z');

test('state machine: terminal states have no exits; cancelled never becomes started or completed', () => {
  for (const terminal of ['completed', 'no_show_mentee', 'no_show_mentor', 'cancelled']) {
    assert.ok(isTerminal(terminal));
    for (const to of ['scheduled', 'in_progress', 'completed', 'no_show_mentee', 'no_show_mentor', 'cancelled']) {
      assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to}`);
    }
  }
  assert.ok(canTransition('scheduled', 'in_progress'));
  assert.ok(canTransition('in_progress', 'completed'));
  assert.ok(canTransition('in_progress', 'cancelled'));
  assert.equal(canTransition('in_progress', 'scheduled'), false);
  assert.equal(canTransition('unknown', 'completed'), false);
});

test('attendance classification follows B4, including the both-absent decision', () => {
  assert.equal(classifyAttendance({ joinedMentorAt: T, joinedMenteeAt: T }), 'completed');
  assert.equal(classifyAttendance({ joinedMentorAt: T, joinedMenteeAt: null }), 'no_show_mentee');
  assert.equal(classifyAttendance({ joinedMentorAt: null, joinedMenteeAt: T }), 'no_show_mentor');
  assert.equal(classifyAttendance({ joinedMentorAt: null, joinedMenteeAt: null }), 'no_show_mentee');
});

test('join window is [start - 5 min, end): early joins only record; joins after start also start', () => {
  assert.equal(EARLY_JOIN_MS, 300_000);
  assert.equal(decide(at(-EARLY_JOIN_MS - 1)), 'JOIN_WINDOW_NOT_OPEN');
  assert.equal(decide(at(-EARLY_JOIN_MS)), 'record');
  assert.equal(decide(at(-1)), 'record');
  assert.equal(decide(at(0)), 'record_and_start');
  assert.equal(decide(at(0), 'in_progress'), 'record');
  assert.equal(decide(new Date(endsAt.getTime() - 1), 'in_progress'), 'record');
  assert.equal(decide(endsAt, 'in_progress'), 'JOIN_WINDOW_CLOSED');
  for (const status of ['cancelled', 'completed', 'no_show_mentee', 'no_show_mentor']) assert.equal(decide(at(0), status), 'SESSION_NOT_JOINABLE');
});

test('rollover expiry is exactly 720 elapsed hours, unaffected by the London clock change', () => {
  assert.equal(NO_SHOW_ROLLOVER_MS, 30 * 24 * 3_600_000);
  const awarded = new Date('2030-10-10T12:00:00.123Z'); // the 30 days span the 27 Oct 2030 change
  assert.equal(rolloverExpiresAt(awarded).toISOString(), '2030-11-09T12:00:00.123Z');
  assert.equal(resolutionDueAt(endsAt).toISOString(), '2030-06-03T14:35:00.000Z');
});
