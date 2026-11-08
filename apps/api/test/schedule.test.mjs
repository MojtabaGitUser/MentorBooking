import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weeklyInput, blockoutInput } from '../dist/mentor/schedule-input.js';

test('weekly input accepts ISO weekdays and wall-clock minutes only', () => {
  for (const weekday of [1,7]) {
    const rule = { weekday, startLocal:'09:00', endLocal:'12:00' };
    assert.deepEqual(weeklyInput(rule),rule);
  }
  for (const body of [{weekday:0},{weekday:8},{weekday:'1'},{weekday:1.5},{startLocal:'9:00'},
    {endLocal:'24:00'},{startLocal:'10:60'},{timezone:'UTC'},{mentorId:'other'}, {}, []]) {
    assert.throws(() => weeklyInput(body,true), {status:422});
  }
  assert.throws(() => weeklyInput({weekday:1}), {status:422});
});

test('blockout input requires a zoned time and supports fractional seconds and nullable reason', () => {
  for (const startsAt of ['2030-01-01T14:15Z','2030-01-01T14:15:30.000001+05:30']) {
    assert.equal(blockoutInput({startsAt,reason:null},true).startsAt, startsAt);
  }
  for (const body of [{startsAt:'2030-01-01'},{endsAt:'2030-01-01T10:00:00'},
    {reason:5},{endsAt:null},{mentorId:'other'},{}]) {
    assert.throws(() => blockoutInput(body,true), {status:422});
  }
});
