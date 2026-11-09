// Pure presentation helpers (no imports) so they run under `node --test` with type stripping.

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(word => /\p{L}/u.test(word));
  if (!words.length) return '?';
  const letter = (word: string) => word.match(/\p{L}/u)![0];
  const first = letter(words[0]);
  const last = words.length > 1 ? letter(words[words.length - 1]) : '';
  return (first + last).toUpperCase();
}

// Stable colour choice per person, so an avatar does not change between pages or reloads.
export function avatarTone(seed: string, tones: number) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % tones;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const weekdayShort = (isoWeekday: number) => WEEKDAYS[isoWeekday - 1] ?? '?';
export const weekdayLong = (isoWeekday: number) => WEEKDAYS_LONG[isoWeekday - 1] ?? '?';

// "Asia/Kolkata" -> "Kolkata", "America/Argentina/Buenos_Aires" -> "Buenos Aires".
export function zoneCity(zone: string) {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
}

// Current UTC offset label for an IANA zone at an instant, e.g. "GMT+5:30". Display only.
export function zoneOffset(zone: string, at: Date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(at).find(p => p.type === 'timeZoneName');
  // ICU builds differ on UTC itself ("GMT" vs "GMT+0"); always show the explicit form.
  return part ? (part.value === 'GMT' ? 'GMT+0' : part.value) : zone;
}

export function localTime(zone: string, at: Date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(at);
}

// YYYY-MM-DD of an instant on a zone's calendar.
export function zoneDate(zone: string, at: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function addDays(isoDate: string, days: number) {
  const date = new Date(isoDate + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface DirectoryFilters {
  q: string;
  timezone: string;
}

// Reads the directory's URL state. Only parameters the API supports are kept.
export function directoryFilters(params: Record<string, string | string[] | undefined>): DirectoryFilters {
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';
  return { q: one(params.q).trim().slice(0, 100), timezone: one(params.timezone).trim() };
}

export function directoryQueryString(filters: Partial<DirectoryFilters>) {
  const params = new URLSearchParams();
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.timezone) params.set('timezone', filters.timezone);
  const query = params.toString();
  return query ? '?' + query : '';
}

export type DirectoryView = 'results' | 'no-results' | 'empty';

// "No results" (filters active) and "empty directory" (no filters) are different messages.
export function directoryView(total: number, filters: DirectoryFilters): DirectoryView {
  if (total > 0) return 'results';
  return filters.q || filters.timezone ? 'no-results' : 'empty';
}

export function resultSummary(total: number, filters: DirectoryFilters) {
  const noun = total === 1 ? 'mentor' : 'mentors';
  if (!filters.q && !filters.timezone) return `${total} ${noun}`;
  return `${total} ${noun} found`;
}

export function weekdaysSummary(weekdays: number[]) {
  if (!weekdays.length) return null;
  if (weekdays.length === 7) return 'Every day';
  return weekdays.map(weekdayShort).join(' · ');
}
