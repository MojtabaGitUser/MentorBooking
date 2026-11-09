import assert from 'node:assert/strict';
import test from 'node:test';
import { localStamp, validLocalStamp } from './dashboard.ts';
test('London skips spring gaps and distinguishes both autumn offsets', () => {
  const zone = 'Europe/London';
  assert.equal(validLocalStamp('2030-03-31T01:30:00+00:00', zone), false);
  for (const offset of ['+00:00', '+01:00']) assert.ok(validLocalStamp('2030-10-27T01:30:00' + offset, zone));
  assert.equal(validLocalStamp('2030-06-01T12:00:00Z', zone), false);
});
test('blockout edits preserve fractions, half-hour offsets and local day boundaries', () => {
  const instant = '2030-01-01T02:00:00.123456Z';
  assert.equal(localStamp(instant, 'Asia/Kolkata'), '2030-01-01T07:30:00.123456+05:30');
  assert.equal(localStamp(instant, 'America/Los_Angeles'), '2029-12-31T18:00:00.123456-08:00');
  assert.ok(validLocalStamp('2030-01-01T07:30+05:30', 'Asia/Kolkata'));
  assert.equal(validLocalStamp('2030-02-30T12:00:00Z', 'Europe/London'), false);
});
