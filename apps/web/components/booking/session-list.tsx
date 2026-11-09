'use client';

import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { CalendarDays } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { cancelBooking, joinBooking, previewCancellation } from '@/app/booking-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/states/empty-state';
import { InitialsAvatar } from '@/components/ui/avatar';
import { sessionTime } from '@/lib/booking-format';
import type { RefundPreview, Session } from '@/lib/types';

export function SessionList({
  account,
  zone,
  items,
  past,
  initialNow,
}: {
  account: string;
  zone: string;
  items: Session[];
  past: boolean;
  initialNow: number;
}) {
  const router = useRouter();
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [selected, select] = useState<Session | null>(null);
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLDivElement | null>(null);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch {
      setError('The result could not be verified. Please try again.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function open(session: Session) {
    setNotice('');
    select(session);
    setPreview(null);
    return run(async () => {
      const r = await previewCancellation(account, session.sessionId);
      if (r.ok) setPreview(r.value);
      else setError(r.message);
    });
  }
  function confirm() {
    if (!selected || !preview?.eligible) return;
    return run(async () => {
      const r = await cancelBooking(account, selected.sessionId, preview.refundableCredits);
      if (!r.ok) {
        if (r.preview) setPreview(r.preview);
        setError(r.message);
        return;
      }
      select(null);
      setPreview(null);
      setNotice(
        `Session cancelled by ${r.value.cancelledBy === 'mentor' ? 'the mentor' : 'you'}. ${r.value.refund.credits} credit refunded.`,
      );
      router.refresh();
    });
  }
  function join(id: string) {
    return run(async () => {
      const r = await joinBooking(account, id);
      if (!r.ok) setError(r.message);
      else {
        setNotice('Your attendance has been recorded.');
        router.refresh();
      }
    });
  }
  return (
    <div ref={heading} tabIndex={-1} className="space-y-3">
      {notice && (
        <p role="status" className="rounded-lg bg-success-soft p-3 text-sm text-success">
          {notice}
        </p>
      )}
      {error && !selected && <p role="alert">{error}</p>}
      {!items.length && (
        <EmptyState
          icon={CalendarDays}
          title={past ? 'No past sessions' : 'No upcoming sessions'}
          description={
            past
              ? 'Completed and cancelled sessions will appear here.'
              : 'Choose a mentor to book your first available time.'
          }
        />
      )}
      {items.map((s) => {
        const starts = Date.parse(s.startsAt),
          ends = Date.parse(s.endsAt);
        const active = ['scheduled', 'in_progress'].includes(s.status);
        const status = s.cancelledBy
          ? 'Cancelled by ' + (s.cancelledBy === 'mentor' ? 'mentor' : 'you')
          : s.status.replaceAll('_', ' ');
        return (
          <Card
            key={s.sessionId}
            className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <InitialsAvatar name={s.mentor.displayName} seed={s.mentor.id} />
              <div>
                <h2 className="font-semibold">{s.mentor.displayName}</h2>
                <p className="my-1 text-sm">{sessionTime(s.startsAt, s.endsAt, zone)}</p>
                <Badge className="capitalize" variant={active ? 'default' : 'neutral'}>
                  {status}
                </Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {active && now >= starts - 300000 && now < ends && (
                <Button disabled={busy || !!s.joinedMenteeAt} onClick={() => join(s.sessionId)}>
                  {s.joinedMenteeAt ? 'Attendance recorded' : 'Join session'}
                </Button>
              )}
              {s.status === 'scheduled' && now < starts && (
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    void open(s);
                  }}
                >
                  Cancel session
                </Button>
              )}
            </div>
          </Card>
        );
      })}
      <Dialog.Root
        open={!!selected}
        onOpenChange={(value) => {
          if (!value && !busy) {
            select(null);
            setError('');
          }
        }}
      >
        {selected && (
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
            <Dialog.Content
              className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-auto rounded-xl border border-border bg-card p-6 text-card-foreground shadow-raised"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                (trigger.current?.isConnected ? trigger.current : heading.current)?.focus();
              }}
            >
              <Dialog.Title className="text-lg font-semibold">Cancel this session?</Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                {selected.mentor.displayName} ·{' '}
                {sessionTime(
                  preview?.startsAt ?? selected.startsAt,
                  preview
                    ? new Date(Date.parse(preview.startsAt) + 30 * 60_000).toISOString()
                    : selected.endsAt,
                  zone,
                )}{' '}
                · {zone}
              </Dialog.Description>
              {busy && !preview && <p role="status">Checking refund…</p>}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {preview && (
                <div aria-live="polite" className="rounded-lg bg-muted p-4">
                  <p className="font-semibold">
                    {preview.eligible
                      ? `${preview.refundableCredits} credit refund`
                      : 'Cancellation unavailable'}
                  </p>
                  <p className="mt-1 text-sm">
                    {!preview.eligible
                      ? 'This session can no longer be cancelled.'
                      : preview.refundableCredits
                        ? 'More than 24 hours remain before the session starts.'
                        : 'Exactly 24 hours or less remain before the session starts.'}
                  </p>
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Dialog.Close asChild>
                  <Button disabled={busy} variant="outline">
                    Keep session
                  </Button>
                </Dialog.Close>
                {!preview && error && (
                  <Button disabled={busy} onClick={() => open(selected)}>
                    Retry preview
                  </Button>
                )}
                {preview?.eligible && (
                  <Button disabled={busy} onClick={confirm}>
                    {busy ? 'Cancelling…' : 'Confirm cancellation'}
                  </Button>
                )}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </Dialog.Root>
    </div>
  );
}
