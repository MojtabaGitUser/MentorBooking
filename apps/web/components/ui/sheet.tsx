'use client';

import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Side drawer built on Radix Dialog (focus trap, Escape, focus return), after shadcn/ui's Sheet (MIT).
export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

export function SheetContent({ className, children, title, ...props }: ComponentProps<typeof Dialog.Content> & { title: string; children: ReactNode }) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/50" />
      <Dialog.Content aria-describedby={undefined} className={cn('fixed inset-y-0 left-0 z-50 flex w-[18rem] max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-raised outline-none', className)} {...props}>
        <Dialog.Title className="sr-only">{title}</Dialog.Title>
        {children}
        <Dialog.Close className="absolute right-3 top-3 inline-flex size-9 items-center justify-center rounded-md text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
          <X className="size-4" aria-hidden /><span className="sr-only">Close navigation</span>
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
