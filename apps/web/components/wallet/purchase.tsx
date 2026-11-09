'use client';
import { Dialog } from 'radix-ui';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { purchasePack } from '@/app/booking-actions';

export function PurchasePack({ account }: { account: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function confirm() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await purchasePack(account);
      if (result.ok) setMessage('Purchase requested. Check its status below.');
      else if (result.status > 0 && result.status < 500)
        setMessage('Purchase request failed. ' + result.message);
      else
        setMessage(
          'Purchase could not be verified. Refresh the wallet and check recent purchases before starting another request.',
        );
    } catch {
      setMessage(
        'Purchase could not be verified. Refresh the wallet and check recent purchases before starting another request.',
      );
    } finally {
      setOpen(false);
      setBusy(false);
      lock.current = false;
      router.refresh();
    }
  }
  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <Dialog.Trigger asChild>
          <Button>Buy 4 credits</Button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-xl border border-border bg-card p-6 shadow-raised">
            <Dialog.Title className="text-lg font-semibold">Buy a four-credit pack?</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              This demo creates a pending purchase. The four normal credits become available when the fake
              provider confirms payment.
            </Dialog.Description>
            <div className="flex flex-wrap justify-end gap-2">
              <Dialog.Close asChild>
                <Button disabled={busy} variant="outline">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button disabled={busy} onClick={confirm}>
                {busy ? 'Requesting…' : 'Confirm purchase'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
    </>
  );
}
