'use client';

import { RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';

// Re-runs the server render (and its API calls) for the current URL.
export function RetryButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" onClick={() => start(() => router.refresh())} disabled={pending} aria-busy={pending}>
      <RotateCw aria-hidden className={pending ? 'animate-spin' : undefined} />
      {pending ? 'Retrying…' : 'Try again'}
    </Button>
  );
}
