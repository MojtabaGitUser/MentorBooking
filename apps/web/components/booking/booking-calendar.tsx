'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, Coins, Globe } from 'lucide-react';
import { reserve } from '@/app/booking-actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InitialsAvatar } from '@/components/ui/avatar';
import { addDays, localTime, zoneOffset } from '@/lib/format';
import { dayLabel, sessionTime } from '@/lib/booking-format';
import type { MentorProfile, SlotPreview } from '@/lib/types';

type Slot = SlotPreview['slots'][number];
type Intent = { slot: Slot; key: string };
const subscribe = (callback: () => void) => {
  window.addEventListener('booking-intent', callback);
  return () => window.removeEventListener('booking-intent', callback);
};

export function BookingCalendar({
  account,
  mentor,
  zone,
  days,
  today,
  credits,
  slots,
}: {
  account: string;
  mentor: MentorProfile;
  zone: string;
  days: string[];
  today: string;
  credits: number;
  slots: Slot[];
}) {
  const router = useRouter();
  const [refreshing, refresh] = useTransition();
  const [day, setDay] = useState(slots[0]?.localStartsAt.slice(0, 10) ?? days[0]);
  const [choice, choose] = useState<Intent | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{
    sessionId: string;
    startsAt: string;
    endsAt: string;
    status: string;
  } | null>(null);
  const lock = useRef(false);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  const storage = 'booking-intent:' + account + ':' + mentor.id;
  const saved = useSyncExternalStore(
    subscribe,
    () => sessionStorage.getItem(storage),
    () => null,
  );
  const retry: Intent | null = saved ? JSON.parse(saved) : null;
  const intent = retry ?? choice;
  const locked = busy || refreshing || !!retry;
  const available = slots.filter((s) => Date.parse(s.startsAt) > now);
  function remember(value: Intent | null) {
    if (value) sessionStorage.setItem(storage, JSON.stringify(value));
    else sessionStorage.removeItem(storage);
    window.dispatchEvent(new Event('booking-intent'));
  }
  async function submit() {
    if (!intent || lock.current || (!retry && (!credits || Date.parse(intent.slot.startsAt) <= Date.now())))
      return;
    lock.current = true;
    setBusy(true);
    setMessage('');
    try {
      remember(intent);
      const result = await reserve(account, mentor.id, intent.slot.startsAt, intent.key);
      if (result.ok) {
        setReceipt(result.value);
        remember(null);
        refresh(() => router.refresh());
      } else if (!result.status || result.status >= 500) {
        setMessage('Confirmation could not be verified. Retry this booking with the same reference.');
      } else {
        remember(null);
        choose(null);
        const messages: Record<string, string> = {
          SLOT_UNAVAILABLE: 'This time slot is no longer available. Please choose another.',
          INVALID_SLOT: 'This slot cannot be booked. Please choose another.',
          SESSION_OVERLAP: 'You already have a session at that time. Please choose another.',
          INSUFFICIENT_CREDITS: 'Your available balance changed. You need one spendable credit to book.',
        };
        setMessage(messages[result.code] ?? result.message);
        refresh(() => router.refresh());
      }
    } catch {
      setMessage('Confirmation could not be verified. Retry this booking with the same reference.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (receipt)
    return (
      <Card className="max-w-xl p-6 sm:p-8" role="status">
        <CheckCircle2 className="mb-4 size-8 text-success" aria-hidden />
        <h2 className="text-xl font-semibold">
          {receipt.status === 'cancelled' ? 'Booking previously cancelled' : 'Booking confirmed'}
        </h2>
        <p className="mt-3 font-medium">{mentor.displayName}</p>
        <p>{sessionTime(receipt.startsAt, receipt.endsAt, zone)}</p>
        <p className="text-sm text-muted-foreground">{zone} · 1 credit spent at booking</p>
        <p className="mt-4 break-all text-xs text-muted-foreground">Session reference {receipt.sessionId}</p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/sessions">View my sessions</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/mentors">Discover mentors</Link>
          </Button>
        </div>
      </Card>
    );
  const path = '/mentors/' + mentor.id + '/book?week=';
  const previous = addDays(days[0], -7);
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <InitialsAvatar name={mentor.displayName} seed={mentor.id} />
            <div>
              <CardTitle>{mentor.displayName}</CardTitle>
              <p className="text-sm text-muted-foreground">Mentor · {mentor.timezone}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-2 border-t border-border pt-5">
            <h3 className="font-semibold">
              {dayLabel(days[0], { month: 'short', day: 'numeric' })} –{' '}
              {dayLabel(days[6], { month: 'short', day: 'numeric', year: 'numeric' })}
            </h3>
            <div className="flex gap-1">
              {days[0] > today && !locked ? (
                <Button variant="outline" size="icon" asChild>
                  <Link aria-label="Previous week" href={path + (previous < today ? today : previous)}>
                    <ChevronLeft />
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" size="icon" aria-label="Previous week" disabled>
                  <ChevronLeft />
                </Button>
              )}
              {locked ? (
                <Button disabled size="icon" aria-label="Next week">
                  <ChevronRight />
                </Button>
              ) : (
                <Button variant="outline" size="icon" asChild>
                  <Link aria-label="Next week" href={path + addDays(days[0], 7)}>
                    <ChevronRight />
                  </Link>
                </Button>
              )}
            </div>
          </div>
          <div role="group" aria-label="Choose a date" className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
            {days.map((d) => {
              const open = available.some((s) => s.localStartsAt.startsWith(d));
              return (
                <Button
                  key={d}
                  variant={d === day && open ? 'default' : 'outline'}
                  aria-pressed={d === day && open}
                  aria-label={dayLabel(d, { dateStyle: 'full' }) + (open ? '' : ', no openings')}
                  disabled={!open || locked}
                  className="h-16 flex-col gap-0 px-1"
                  onClick={() => {
                    setDay(d);
                    choose(null);
                    setMessage('');
                  }}
                >
                  <span className="text-xs">{dayLabel(d, { weekday: 'short' })}</span>
                  <span className="text-lg">{Number(d.slice(-2))}</span>
                </Button>
              );
            })}
          </div>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Globe className="size-4" />
            Times in {zone}
          </p>
          {available.some((s) => s.localStartsAt.startsWith(day)) ? (
            <fieldset>
              <legend className="mb-3 font-semibold">Available times</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {available
                  .filter((s) => s.localStartsAt.startsWith(day))
                  .map((slot) => (
                    <Button
                      data-start={slot.startsAt}
                      key={slot.startsAt}
                      variant={intent?.slot.startsAt === slot.startsAt ? 'default' : 'outline'}
                      disabled={locked}
                      aria-pressed={intent?.slot.startsAt === slot.startsAt}
                      className="h-11"
                      title={zoneOffset(zone, new Date(slot.startsAt))}
                      onClick={() => {
                        choose({ slot, key: crypto.randomUUID() });
                        setMessage('');
                      }}
                    >
                      {localTime(zone, new Date(slot.startsAt))}{' '}
                      <span className="text-xs">{zoneOffset(zone, new Date(slot.startsAt))}</span>
                    </Button>
                  ))}
              </div>
            </fieldset>
          ) : (
            <p role="status" className="rounded-lg border border-dashed border-border p-5 text-sm">
              No openings {available.length ? 'on this day' : 'this week'}. Choose another date or week.
            </p>
          )}
        </CardContent>
      </Card>
      <aside>
        <Card className="xl:sticky xl:top-24">
          <CardHeader>
            <CardTitle>Booking summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="font-medium">{mentor.displayName}</p>
            <div className="flex gap-2">
              <Badge variant="neutral">
                <Clock />
                30 minutes
              </Badge>
              <Badge variant="neutral">
                <Coins />1 credit
              </Badge>
            </div>
            <div className="rounded-lg bg-muted p-3 text-sm">
              <CalendarDays className="mb-2 size-4" aria-hidden />
              {intent ? (
                <>
                  {sessionTime(intent.slot.startsAt, intent.slot.endsAt, zone)}
                  <br />
                  {zone}
                </>
              ) : (
                'Choose a time to review your booking.'
              )}
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt>Spendable credits</dt>
                <dd>{credits}</dd>
              </div>
              {intent && credits > 0 && (
                <div className="flex justify-between">
                  <dt>Estimated after booking</dt>
                  <dd>{credits - 1}</dd>
                </div>
              )}
            </dl>
            {!credits && !retry && (
              <p className="text-sm text-muted-foreground">
                You need one spendable credit before you can book. <Link className="underline" href="/wallet">Open my wallet</Link>
              </p>
            )}
            {(message || (retry && !busy)) && (
              <p role="alert" className="text-sm text-destructive">
                {message || 'A previous confirmation is unresolved. Retry to check its outcome.'}
              </p>
            )}
            <Button
              className="w-full"
              disabled={
                busy ||
                refreshing ||
                !intent ||
                (!retry && (!credits || Date.parse(intent.slot.startsAt) <= now))
              }
              onClick={submit}
            >
              {busy ? 'Confirming…' : retry ? 'Retry confirmation' : 'Confirm booking'}
            </Button>
            {retry && (
              <Link className="text-sm underline" href="/sessions">
                Check my sessions
              </Link>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
