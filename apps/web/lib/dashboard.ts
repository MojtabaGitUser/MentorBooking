import type { CurrentUser, Session } from './types';
import type { LedgerPage } from './wallet';
export type DirectoryUser = Pick<CurrentUser, 'id' | 'role' | 'displayName'>;
export type MentorSession = Omit<Session, 'mentor'> & {
  mentee: Pick<CurrentUser, 'id' | 'displayName' | 'timezone'>;
};
export type Weekly = { id: string; weekday: number; startLocal: string; endLocal: string; isActive: boolean };
export type Blockout = { id: string; startsAt: string; endsAt: string; reason: string | null };
export type Audit = LedgerPage & {
  user: DirectoryUser;
  balance: { totalSpendable: number; normal: number; rollover: number; debt: number } | null;
};
export type Adjustment = { delta: number; reason: string; idempotencyKey: string };
export type Receipt = { adjustmentId: string; delta: number; reason: string; createdAt: string };
export const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Keep the stored precision when editing one endpoint or just its reason.
export function localStamp(iso: string, zone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(iso));
  const get = (key: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === key)?.value;
  const offset = get('timeZoneName')?.replace('GMT', '') || '+00:00';
  return (
    get('year') +
    '-' +
    get('month') +
    '-' +
    get('day') +
    'T' +
    get('hour') +
    ':' +
    get('minute') +
    ':' +
    get('second') +
    (iso.match(/\.\d+/)?.[0] ?? '') +
    offset
  );
}

export function validLocalStamp(text: string, zone: string) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(:\d\d)?(\.\d{1,6})?(Z|[+-]\d\d:\d\d)$/.exec(text);
  if (!match || !Number.isFinite(Date.parse(text))) return false;
  return (
    localStamp(text, zone) ===
    match[1] + (match[2] || ':00') + (match[3] || '') + (match[4] === 'Z' ? '+00:00' : match[4])
  );
}
