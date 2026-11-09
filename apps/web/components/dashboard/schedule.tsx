'use client';
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { FormDialog, field } from './form-dialog';
import { scheduleChange } from '@/app/dashboard-actions';
import { days, localStamp, validLocalStamp, type Weekly, type Blockout } from '@/lib/dashboard';
import { walletTime } from '@/lib/wallet';

export function Schedule({
  weekly,
  blocks,
  zone,
  account,
  example,
}: {
  weekly: Weekly[];
  blocks: Blockout[];
  zone: string;
  account: string;
  example: string;
}) {
  const [notice, setNotice] = useState('');
  function weeklyForm(day: number, row?: Weekly) {
    return (
      <FormDialog
        trigger={row ? 'Edit' : 'Add window'}
        title={(row ? 'Edit' : 'Add') + ' weekly window'}
        confirm="Save window"
        description={days[day - 1] + ' · ' + zone}
        onSuccess={() => setNotice('Weekly schedule updated.')}
        submit={(data) => {
          const inputs = {
            weekday: Number(data.get('weekday')),
            startLocal: String(data.get('start')).replace(/^(\d\d:\d\d):00$/, '$1'),
            endLocal: String(data.get('end')).replace(/^(\d\d:\d\d):00$/, '$1'),
          };
          // Legacy rules may have second precision. Preserve untouched endpoints on PATCH.
          const body = row
            ? Object.fromEntries(
                Object.entries(inputs).filter(([k, v]) => row[k as keyof typeof inputs] !== v),
              )
            : inputs;
          if (!Object.keys(body).length) return Promise.resolve({ ok: true });
          return scheduleChange(account, 'availability', row ? 'PATCH' : 'POST', row?.id ?? null, body);
        }}
      >
        <label className="block">
          Weekday
          <select className={field} name="weekday" defaultValue={day}>
            {days.map((label, i) => (
              <option key={label} value={i + 1}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          Start time
          <input
            name="start"
            type="time"
            step="any"
            required
            defaultValue={row?.startLocal}
            className={field}
          />
        </label>
        <label className="block">
          End time
          <input name="end" type="time" step="any" required defaultValue={row?.endLocal} className={field} />
        </label>
      </FormDialog>
    );
  }
  function blockForm(row?: Blockout) {
    return (
      <FormDialog
        trigger={row ? 'Edit' : 'Add blockout'}
        title={row ? 'Edit blockout' : 'Add blockout'}
        confirm="Save blockout"
        description={'Enter local dates with their UTC offsets in ' + zone + '. Example: ' + example}
        onSuccess={() => setNotice('Blockouts updated.')}
        submit={(data) => {
          const startsAt = String(data.get('start')).trim(),
            endsAt = String(data.get('end')).trim();
          if (![startsAt, endsAt].every((stamp) => validLocalStamp(stamp, zone)))
            return Promise.resolve({
              ok: false,
              code: 'INVALID_LOCAL_TIME',
              message: 'Use a valid local timestamp and the UTC offset in effect at that time.',
            });
          return scheduleChange(account, 'blockouts', row ? 'PATCH' : 'POST', row?.id ?? null, {
            startsAt,
            endsAt,
            reason: String(data.get('reason')).trim() || null,
          });
        }}
      >
        <label className="block">
          Start with offset
          <input
            className={field}
            name="start"
            required
            placeholder={example}
            defaultValue={row && localStamp(row.startsAt, zone)}
          />
        </label>
        <label className="block">
          End with offset
          <input
            className={field}
            name="end"
            required
            placeholder={example}
            defaultValue={row && localStamp(row.endsAt, zone)}
          />
        </label>
        <label className="block">
          Reason (optional)
          <input className={field} name="reason" defaultValue={row?.reason ?? ''} />
        </label>
      </FormDialog>
    );
  }
  function remove(section: 'availability' | 'blockouts', id: string, description: string) {
    return (
      <FormDialog
        trigger="Delete"
        title={section === 'availability' ? 'Delete weekly window?' : 'Delete blockout?'}
        description={description}
        confirm="Confirm deletion"
        submit={() => scheduleChange(account, section, 'DELETE', id)}
        onSuccess={() => setNotice('Schedule entry deleted.')}
      />
    );
  }
  return (
    <div className="space-y-6">
      {notice && <p role="status">{notice}</p>}
      <Card className="p-5">
        <h2 className="text-lg font-semibold">Weekly availability</h2>
        <p className="mb-3 text-sm text-muted-foreground">Recurring local hours · {zone}</p>
        {days.map((day, i) => (
          <section key={day} aria-label={day} className="border-t border-border py-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">{day}</h3>
              {weeklyForm(i + 1)}
            </div>
            {weekly.filter((w) => w.weekday === i + 1).length === 0 && (
              <p className="text-sm text-muted-foreground">No windows</p>
            )}
            {weekly
              .filter((w) => w.weekday === i + 1)
              .map((w) => (
                <div key={w.id} className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="mr-auto tabular-nums">
                    {w.startLocal} – {w.endLocal}
                    {!w.isActive && ' · Inactive'}
                  </span>
                  {weeklyForm(i + 1, w)}
                  {remove('availability', w.id, day + ' · ' + w.startLocal + ' – ' + w.endLocal)}
                </div>
              ))}
          </section>
        ))}
      </Card>
      <Card id="blockouts" className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Upcoming blockouts</h2>
          {blockForm()}
        </div>
        {!blocks.length && <p className="mt-3 text-sm text-muted-foreground">No upcoming blockouts</p>}
        {blocks.map((b) => (
          <div key={b.id} className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <div className="mr-auto min-w-0">
              <p>
                {walletTime(b.startsAt, zone)} – {walletTime(b.endsAt, zone)}
              </p>
              <p className="break-all text-sm text-muted-foreground">{b.reason}</p>
            </div>
            {blockForm(b)}
            {remove('blockouts', b.id, walletTime(b.startsAt, zone) + ' – ' + walletTime(b.endsAt, zone))}
          </div>
        ))}
      </Card>
    </div>
  );
}
