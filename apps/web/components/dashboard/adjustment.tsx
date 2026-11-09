'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormDialog, field } from './form-dialog';
import { adjustCredits } from '@/app/dashboard-actions';
import { creditDelta, walletTime } from '@/lib/wallet';
import type { Adjustment, Receipt } from '@/lib/dashboard';

export function AdjustmentForm({
  target,
  name,
  zone,
  account,
}: {
  target: string;
  name: string;
  zone: string;
  account: string;
}) {
  const store = 'credit-adjustment:' + account + ':' + target,
    router = useRouter();
  const [ready, setReady] = useState(false),
    [intent, setIntent] = useState<Adjustment | null>(null),
    [mode, setMode] = useState('grant'),
    [quantity, setQuantity] = useState('1'),
    [reason, setReason] = useState('');
  const [error, setError] = useState(''),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    review = useRef<HTMLButtonElement>(null),
    form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(store);
      if (raw) setIntent(JSON.parse(raw));
      setReady(true);
    } catch {
      setError('Retry storage unavailable. Reopen this tab before adjusting credits.');
    }
  }, [store]);
  async function send(request: Adjustment) {
    if (lock.current) return { ok: false as const, code: 'PENDING', message: 'Request in progress.' };
    lock.current = true;
    setBusy(true);
    setReceipt(null);
    setError('');
    try {
      // Persist the complete immutable request before sending. A replay returns the original receipt.
      sessionStorage.setItem(store, JSON.stringify(request));
      setIntent(request);
      const result = await adjustCredits(account, target, request);
      if (!result.ok) {
        setError(result.message + ' (' + result.code + ')');
        if ([404, 409, 422].includes(result.status)) {
          sessionStorage.removeItem(store);
          setIntent(null);
        }
        return result;
      }
      sessionStorage.removeItem(store);
      setIntent(null);
      setReceipt(result.value);
      setReason('');
      router.refresh();
      return { ok: true as const };
    } catch {
      const message = 'Outcome unverified. Retry this saved adjustment to recover its receipt.';
      setError(message);
      return { ok: false as const, code: 'UNVERIFIED', message };
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const delta = Number(quantity) * (mode === 'grant' ? 1 : -1);
  function validate(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError('Enter a reason.');
      return;
    }
    setError('');
    review.current?.click();
  }
  return (
    <Card className="min-w-0 space-y-3 p-5">
      <h2 className="text-lg font-semibold">Credit adjustment</h2>
      {intent && !busy ? (
        <div className="space-y-3">
          <p>
            Saved adjustment for {name}: {creditDelta(intent.delta)}
          </p>
          <p className="break-all">{intent.reason}</p>
          <Button disabled={busy} onClick={() => send(intent)}>
            {busy ? 'Checking…' : 'Retry saved adjustment'}
          </Button>
        </div>
      ) : (
        <>
          <form ref={form} className="space-y-3" onSubmit={validate}>
            <label className="block">
              Action
              <select className={field} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="grant">Grant credits</option>
                <option value="revoke">Revoke credits</option>
              </select>
            </label>
            <label className="block">
              Quantity
              <input
                className={field}
                type="number"
                min="1"
                max="1000"
                step="1"
                required
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
            <label className="block">
              Adjustment reason
              <textarea
                className={field}
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </form>
          <FormDialog
            trigger="Review adjustment"
            disabled={!ready || busy}
            triggerRef={review}
            dismissOnError
            beforeOpen={() => {
              if (!form.current?.reportValidity()) return false;
              if (!reason.trim()) {
                setError('Enter a reason.');
                return false;
              }
              setError('');
              return true;
            }}
            title="Confirm credit adjustment?"
            description={name + ' · ' + creditDelta(delta)}
            confirm="Confirm adjustment"
            submit={() => send({ delta, reason: reason.trim(), idempotencyKey: crypto.randomUUID() })}
          >
            <p className="break-all text-sm">{reason}</p>
          </FormDialog>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {receipt && (
        <section role="status" className="space-y-1 rounded-md bg-success-soft p-3 text-sm">
          <h3 className="font-semibold">Adjustment confirmed</h3>
          <p>
            {creditDelta(receipt.delta)} · {walletTime(receipt.createdAt, zone)}
          </p>
          <p className="break-all">{receipt.reason}</p>
          <p className="break-all">Receipt {receipt.adjustmentId}</p>
        </section>
      )}
    </Card>
  );
}
