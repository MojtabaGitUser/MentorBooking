'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays } from 'lucide-react';
import { EmptyState } from '@/components/states/empty-state';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormDialog, field } from './form-dialog';
import { joinBooking } from '@/app/booking-actions';
import { mentorCancel } from '@/app/dashboard-actions';
import { sessionTime } from '@/lib/booking-format';
import { sessionLabels } from '@/lib/wallet';
import type { MentorSession } from '@/lib/dashboard';
export function MentorSessions({
  items,
  account,
  zone,
  initialNow,
  past,
}: {
  items: MentorSession[];
  account: string;
  zone: string;
  initialNow: number;
  past: boolean;
}) {
  const [now, setNow] = useState(initialNow),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    router = useRouter();
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  async function join(id: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const r = await joinBooking(account, id);
      setNotice(r.ok ? 'Your attendance has been recorded.' : r.message + ' (' + r.code + ')');
      router.refresh();
    } catch {
      setNotice('Attendance could not be verified. Refresh and check this session.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <p role="status">{notice}</p>
      {!items.length && (
        <EmptyState
          icon={CalendarDays}
          title={past ? 'No past sessions' : 'No upcoming sessions'}
          description={past ? 'Finished and cancelled sessions appear here.' : 'Booked sessions appear here.'}
        />
      )}
      {items.map((s) => {
        const active = ['scheduled', 'in_progress'].includes(s.status),
          when = sessionTime(s.startsAt, s.endsAt, zone);
        return (
          <Card key={s.sessionId} className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <h2 className="font-semibold">{s.mentee.displayName}</h2>
              <p className="my-1 text-sm">{when}</p>
              <Badge variant={active ? 'default' : 'neutral'}>
                {s.cancelledBy ? 'Cancelled by ' + s.cancelledBy : (sessionLabels[s.status] ?? s.status)}
              </Badge>
            </div>
            {active && (
              <div className="flex flex-wrap gap-2">
                {now >= Date.parse(s.startsAt) - 300000 && now < Date.parse(s.endsAt) && (
                  <Button disabled={busy || !!s.joinedMentorAt} onClick={() => join(s.sessionId)}>
                    {s.joinedMentorAt ? 'Attendance recorded' : 'Join session'}
                  </Button>
                )}
                <FormDialog
                  trigger="Cancel session"
                  title="Cancel this session?"
                  description={
                    s.mentee.displayName +
                    ' · ' +
                    when +
                    '. The mentee will receive a full one-credit refund.'
                  }
                  confirm="Confirm cancellation"
                  submit={(data) => mentorCancel(account, s.sessionId, String(data.get('reason') ?? ''))}
                  onSuccess={() => setNotice('Session cancelled. One credit refunded.')}
                >
                  <label className="block">
                    Reason (optional)
                    <input name="reason" maxLength={500} className={field} />
                  </label>
                </FormDialog>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
