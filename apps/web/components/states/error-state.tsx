import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { RetryButton } from './retry-button';

// An actionable error: never rendered as an empty list, so a failure is not mistaken for "no data".
export function ErrorState({ title, description, code, action }:
  { title: string; description: string; code?: string; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-xl border border-destructive/30 bg-destructive-soft px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-card text-destructive shadow-card">
        <AlertTriangle className="size-6" aria-hidden />
      </span>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>
      {code && <p className="mt-2 font-mono text-xs text-muted-foreground">Error code: {code}</p>}
      <div className="mt-5 flex flex-wrap justify-center gap-2">{action ?? <RetryButton />}</div>
    </div>
  );
}
