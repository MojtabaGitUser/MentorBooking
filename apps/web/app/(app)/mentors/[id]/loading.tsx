import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading mentor profile…</span>
      <Skeleton className="h-4 w-40" /><Skeleton className="mt-3 h-8 w-2/3 max-w-64" />
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card className="flex items-center gap-4 p-6"><Skeleton className="size-16 rounded-full" /><div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-4 w-3/4" /></div></Card>
          <Card className="space-y-3 p-6"><Skeleton className="h-5 w-20" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-5/6" /></Card>
          <Card className="space-y-3 p-6"><Skeleton className="h-5 w-32" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-full" /></Card>
        </div>
        <Card className="space-y-3 p-6"><Skeleton className="h-5 w-40" />{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}<Skeleton className="h-10 w-full" /></Card>
      </div>
    </div>
  );
}
