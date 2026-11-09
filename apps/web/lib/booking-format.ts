// Day labels are calendar dates; parsing them in the browser timezone can move them into yesterday.
export function dayLabel(day: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(
    new Date(day + 'T00:00:00Z'),
  );
}

export function sessionTime(start: string, end: string, zone: string) {
  const a = new Date(start),
    b = new Date(end);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  });
  const firstDay = date.format(a),
    lastDay = date.format(b);
  return (
    firstDay + ' · ' + time.format(a) + ' – ' + (firstDay === lastDay ? '' : lastDay + ' · ') + time.format(b)
  );
}

export function dateParam(value: unknown, today: string) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < today ||
    value > '9999-12-21'
  )
    return today;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : today;
}
