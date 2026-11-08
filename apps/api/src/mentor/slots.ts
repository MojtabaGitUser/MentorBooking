import { UnprocessableEntityException } from '@nestjs/common';
import { DateTime, IANAZone } from 'luxon';

function invalid(message: string): never {
  throw new UnprocessableEntityException({ code: 'INVALID_SLOT_QUERY', message });
}

function calendarDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('Expected YYYY-MM-DD.');
  const date = DateTime.fromISO(value, { zone: 'utc' });
  if (!date.isValid || date.year === 0) invalid('Invalid calendar date.');
  return date;
}

export function slotQuery(query: Record<string, unknown>, savedZone: string) {
  if (Object.keys(query).some(key => !['from', 'to', 'timezone'].includes(key))) invalid('Unexpected query parameter.');
  const from = calendarDate(query.from);
  const to = calendarDate(query.to);
  if (to < from) invalid('to must be on or after from.');
  const viewerTimezone = query.timezone === undefined ? savedZone : query.timezone;
  if (typeof viewerTimezone !== 'string' || !IANAZone.isValidZone(viewerTimezone) || /^[+-]/.test(viewerTimezone)) {
    invalid('Unknown IANA timezone.');
  }
  return { from, to: DateTime.min(to, from.plus({ days: 30 })), viewerTimezone };
}

interface Rule {
  weekday: number;
  startMicros: number;
  endMicros: number;
}

const minute = 60_000;
const duration = 30 * minute;

// The UTC calendar cursor represents local labels only. Real instants are resolved separately.
export function candidateStarts(range: ReturnType<typeof slotQuery>, mentorZone: string, rules: Rule[]) {
  const starts = new Set<number>();
  for (let day = range.from; day <= range.to; day = day.plus({ days: 1 })) {
    for (const rule of rules.filter(rule => rule.weekday === day.weekday)) {
      const firstMinute = Math.ceil(rule.startMicros / (duration * 1000)) * 30;
      for (let m = firstMinute; m < 1440 && m * minute * 1000 < rule.endMicros; m += 30) {
        const label = day.plus({ minutes: m });
        const local = label.setZone(mentorZone, { keepLocalTime: true });
        if (!local.isValid || local.toISODate() !== day.toISODate() || local.hour !== label.hour ||
            local.minute !== label.minute) continue;
        const start = Math.min(...local.getPossibleOffsets().map(dt => dt.toMillis()));
        if (fitsWindow(start, local.zone, day.toMillis(), rule)) starts.add(start);
      }
    }
  }
  return [...starts].sort((a, b) => a - b);
}

// Over each constant-offset segment, wall time advances monotonically. Check both segments
// if a transition falls inside the slot (some zones transition at a quarter hour).
function fitsWindow(start: number, zone: DateTime['zone'], day: number, rule: Rule) {
  const end = start + duration;
  const firstOffset = zone.offset(start);
  const lastOffset = zone.offset(end - 1);
  const contains = (a: number, b: number, offset: number) =>
    (a - day + offset * minute) * 1000 >= rule.startMicros &&
    (b - day + offset * minute) * 1000 <= rule.endMicros;
  if (firstOffset === lastOffset) return contains(start, end, firstOffset);
  let before = start, after = end - 1;
  while (after - before > 1) {
    const mid = before + Math.floor((after - before) / 2);
    if (zone.offset(mid) === firstOffset) before = mid;
    else after = mid;
  }
  return contains(start, after, firstOffset) && contains(after, end, lastOffset);
}

export function displaySlot(start: Date, viewerTimezone: string) {
  const utc = DateTime.fromJSDate(start, { zone: 'utc' });
  const end = utc.plus({ minutes: 30 });
  const format = { suppressMilliseconds: true };
  return {
    startsAt: utc.toISO(format), endsAt: end.toISO(format),
    localStartsAt: utc.setZone(viewerTimezone).toISO(format),
    localEndsAt: end.setZone(viewerTimezone).toISO(format),
  };
}
