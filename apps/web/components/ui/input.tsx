import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn('h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 disabled:opacity-50', className)} {...props} />;
}

// Native select: fully keyboard and screen-reader accessible, and uses the platform picker on mobile.
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn('h-10 w-full appearance-none rounded-md border border-input bg-card bg-[length:16px] bg-[right_0.75rem_center] bg-no-repeat pl-3 pr-9 text-sm text-foreground shadow-sm focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40', "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium text-foreground', className)} {...props} />;
}
