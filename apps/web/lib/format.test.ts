import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, avatarTone, directoryFilters, directoryQueryString, directoryView, initials, localTime, resultSummary,
  weekdaysSummary, zoneCity, zoneDate, zoneOffset } from './format.ts';

test('initials fall back gracefully for missing or unusual names', () => {
  assert.equal(initials('Maya Okafor'), 'MO');
  assert.equal(initials('  ravi   kumar sen '), 'RS');
  assert.equal(initials('Cher'), 'C');
  assert.equal(initials('Élodie Ünal'), 'ÉÜ');
  assert.equal(initials(''), '?');
  assert.equal(initials('<img> 123'), 'I');
  assert.equal(initials('123 456'), '?');
});

test('avatar tone is stable per person and within range', () => {
  const id = '00000000-0000-4000-8000-000000000006';
  assert.equal(avatarTone(id, 6), avatarTone(id, 6));
  for (const seed of ['a', 'b', id]) assert.ok(avatarTone(seed, 6) >= 0 && avatarTone(seed, 6) < 6);
});

test('timezone labels use the IANA zone and real offsets, including half-hour zones and DST', () => {
  assert.equal(zoneCity('America/Sao_Paulo'), 'Sao Paulo');
  assert.equal(zoneCity('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(zoneOffset('Asia/Kolkata', new Date('2030-01-15T00:00:00Z')), 'GMT+5:30');
  assert.equal(zoneOffset('Europe/London', new Date('2030-01-15T00:00:00Z')), 'GMT+0');
  assert.equal(zoneOffset('Europe/London', new Date('2030-07-15T00:00:00Z')), 'GMT+1');
  assert.equal(localTime('Asia/Kolkata', new Date('2030-01-15T03:30:00Z')), '9:00 AM');
  // The mentor's calendar date can differ from UTC: used for the slot preview range.
  assert.equal(zoneDate('Asia/Tokyo', new Date('2030-01-14T20:00:00Z')), '2030-01-15');
  assert.equal(addDays('2030-12-25', 13), '2031-01-07');
});

test('directory URL state keeps only supported parameters and round-trips', () => {
  assert.deepEqual(directoryFilters({ q: '  react ', timezone: 'Asia/Tokyo', sort: 'rating' }), { q: 'react', timezone: 'Asia/Tokyo' });
  assert.deepEqual(directoryFilters({ q: ['a', 'b'] }), { q: 'a', timezone: '' });
  assert.equal(directoryFilters({ q: 'x'.repeat(150) }).q.length, 100);
  assert.equal(directoryQueryString({ q: 'React & SQL', timezone: 'Asia/Tokyo' }), '?q=React+%26+SQL&timezone=Asia%2FTokyo');
  assert.equal(directoryQueryString({ q: '  ', timezone: '' }), '');
});

test('empty directory and "no results" are distinct states', () => {
  assert.equal(directoryView(3, { q: '', timezone: '' }), 'results');
  assert.equal(directoryView(0, { q: '', timezone: '' }), 'empty');
  assert.equal(directoryView(0, { q: 'zzz', timezone: '' }), 'no-results');
  assert.equal(directoryView(0, { q: '', timezone: 'Asia/Tokyo' }), 'no-results');
  assert.equal(resultSummary(1, { q: '', timezone: '' }), '1 mentor');
  assert.equal(resultSummary(5, { q: '', timezone: '' }), '5 mentors');
  assert.equal(resultSummary(0, { q: 'x', timezone: '' }), '0 mentors found');
});

test('weekly availability summary handles none, some and every day', () => {
  assert.equal(weekdaysSummary([]), null);
  assert.equal(weekdaysSummary([1, 3]), 'Mon · Wed');
  assert.equal(weekdaysSummary([1, 2, 3, 4, 5, 6, 7]), 'Every day');
});
