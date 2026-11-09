'use client';
import { Dialog } from 'radix-ui';
import { useRef, useState, type ReactNode, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export const field =
  'mt-1 block w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground';
type Result = { ok: true } | { ok: false; message: string; code: string };
export function FormDialog({
  trigger,
  title,
  description,
  confirm,
  children,
  submit,
  onSuccess,
  disabled,
  triggerRef,
  beforeOpen,
  dismissOnError,
}: {
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  beforeOpen?: () => boolean;
  dismissOnError?: boolean;
  trigger: string;
  title: string;
  description: string;
  confirm: string;
  children?: ReactNode;
  disabled?: boolean;
  submit: (data: FormData) => Promise<Result>;
  onSuccess?: () => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false),
    router = useRouter();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await submit(new FormData(event.currentTarget));
      if (!result.ok) {
        if (dismissOnError) setOpen(false);
        setError(result.message + ' (' + result.code + ')');
        router.refresh();
        return;
      }
      setOpen(false);
      onSuccess?.();
      router.refresh();
    } catch {
      setError('The result could not be verified. Refresh to check the current state.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!lock.current && (!v || !beforeOpen || beforeOpen())) {
          setOpen(v);
          setError('');
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button ref={triggerRef} type="button" disabled={disabled} size="sm" variant="outline">
          {trigger}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-3 overflow-auto rounded-xl border border-border bg-card p-5 shadow-raised">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">{description}</Dialog.Description>
          <form onSubmit={save} className="space-y-3">
            {children}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" disabled={busy} variant="outline">
                  Back
                </Button>
              </Dialog.Close>
              <Button disabled={busy}>{busy ? 'Submitting…' : confirm}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
