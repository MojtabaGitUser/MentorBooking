import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateParam, dayLabel, sessionTime } from './booking-format.ts';
import { zoneDate, localTime, zoneOffset } from './format.ts';

test('a Kolkata opening at 09:00 on January 15 is shown in Los Angeles on January 14', () => {
  const start = '2026-01-15T03:30:00Z',
    end = '2026-01-15T04:00:00Z';
  assert.equal(zoneDate('Asia/Kolkata', new Date(start)), '2026-01-15');
  assert.equal(zoneDate('America/Los_Angeles', new Date(start)), '2026-01-14');
  assert.match(sessionTime(start, end, 'America/Los_Angeles'), /Jan 14/);
  assert.equal(localTime('America/Los_Angeles', new Date(start)), '7:30 PM');
});

test('render authoritative London instants across spring gaps and autumn folds', () => {
  const spring = new Date('2026-03-29T01:00:00Z');
  assert.equal(localTime('Europe/London', spring), '2:00 AM');
  const early = new Date('2026-10-25T00:30:00Z'),
    late = new Date('2026-10-25T01:30:00Z');
  assert.equal(localTime('Europe/London', early), localTime('Europe/London', late));
  assert.match(
    sessionTime(early.toISOString(), '2026-10-25T01:00:00Z', 'Europe/London'),
    /GMT\+1.*1:00.*GMT/,
  );
  assert.notEqual(zoneOffset('Europe/London', early), zoneOffset('Europe/London', late));
});

test('week navigation rejects malformed, impossible, and past dates', () => {
  const today = '2030-01-05';
  for (const value of [undefined, '2030-02-31', '2029-01-01', ['2030-01-10']])
    assert.equal(dateParam(value, today), today);
  assert.equal(dateParam('2030-02-01', today), '2030-02-01');
  assert.equal(dayLabel('2030-02-01', { weekday: 'short' }), 'Fri');
});
