import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateStarts, displaySlot, slotQuery } from '../dist/mentor/slots.js';

function daySlots(date, mentorZone, viewerZone, weekday, start, end) {
  const range = slotQuery({ from:date, to:date }, viewerZone);
  const rule = { weekday, startMicros:start * 60_000_000, endMicros:end * 60_000_000 };
  return candidateStarts(range, mentorZone, [rule,rule]).map(ms => displaySlot(new Date(ms),viewerZone));
}

test('London spring gap on 2026-03-29 skips 01:xx without shifting or duplicating starts', () => {
  const slots = daySlots('2026-03-29','Europe/London','Europe/London',7,0,240);
  assert.deepEqual(slots.map(s=>s.startsAt.slice(11)),['00:00:00Z','00:30:00Z','01:00:00Z','01:30:00Z','02:00:00Z','02:30:00Z']);
  assert.deepEqual(slots.map(s=>s.localStartsAt.slice(11,16)),['00:00','00:30','02:00','02:30','03:00','03:30']);
  assert.equal(slots[1].localEndsAt,'2026-03-29T02:00:00+01:00');
});

test('London fold on 2026-10-25 selects earlier 01:00 and 01:30 once, in UTC order', () => {
  const slots = daySlots('2026-10-25','Europe/London','Europe/London',7,0,240);
  assert.deepEqual(slots.map(s=>s.startsAt),[
    '2026-10-24T23:00:00Z','2026-10-24T23:30:00Z','2026-10-25T00:00:00Z','2026-10-25T00:30:00Z',
    '2026-10-25T02:00:00Z','2026-10-25T02:30:00Z','2026-10-25T03:00:00Z','2026-10-25T03:30:00Z']);
  assert.deepEqual(slots.slice(2,4).map(s=>s.localStartsAt),['2026-10-25T01:00:00+01:00','2026-10-25T01:30:00+01:00']);
  for (const s of slots) assert.equal(Date.parse(s.endsAt)-Date.parse(s.startsAt),1_800_000);
});

test('Kolkata January 15 at 09:00 is January 14 at 19:30 in Los Angeles', () => {
  const [slot] = daySlots('2026-01-15','Asia/Kolkata','America/Los_Angeles',4,540,570);
  assert.equal(slot.startsAt,'2026-01-15T03:30:00Z');
  assert.equal(slot.localStartsAt,'2026-01-14T19:30:00-08:00');
});

test('partial windows on quarter-hour offsets align on the mentor clock', () => {
  const slots = daySlots('2030-01-07','Asia/Kathmandu','UTC',1,541,610);
  assert.deepEqual(slots.map(s=>s.startsAt),['2030-01-07T03:45:00Z']);
});

test('a transition inside a real half-hour must fit the window on both sides', () => {
  const slots = daySlots('2026-09-27','Pacific/Chatham','Pacific/Chatham',7,150,225);
  assert.deepEqual(slots,[]);
  const full = daySlots('2026-09-27','Pacific/Chatham','Pacific/Chatham',7,150,240);
  assert.equal(full[0].localEndsAt,'2026-09-27T04:00:00+13:45');
});

test('range uses inclusive mentor dates, clamps to 31 dates and rejects invalid queries', () => {
  const range = slotQuery({from:'2030-01-01', to:'2030-03-01'},'UTC');
  assert.equal(range.to.toISODate(),'2030-01-31');
  for (const overrides of [{from:'2030-02-30'},{from:'2031-01-01'},{timezone:'+05:30'},
    {timezone:'Mars/Olympus'}, {timezone:['UTC','UTC']}, {from:undefined},{before:'2031-01-01'}]) {
    assert.throws(()=>slotQuery({from:'2030-01-01',to:'2030-02-01',...overrides},'UTC'),{status:422});
  }
});

test('mentor-date bounds exclude the previous evening and stop at the last requested midnight', () => {
  const range = slotQuery({from:'2030-01-07',to:'2030-01-07'},'Asia/Kolkata');
  const rules = [
    {weekday:7,startMicros:23.5*3_600_000_000,endMicros:86_400_000_000},
    {weekday:1,startMicros:0,endMicros:1_800_000_000},
    {weekday:2,startMicros:0,endMicros:1_800_000_000},
  ];
  const starts = candidateStarts(range,'Asia/Kolkata',rules);
  assert.deepEqual(starts.map(ms=>new Date(ms).toISOString()),['2030-01-06T18:30:00.000Z']);
});
