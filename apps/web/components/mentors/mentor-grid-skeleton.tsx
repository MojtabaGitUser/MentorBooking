import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function MentorGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div role="status" aria-live="polite" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="mentor-grid-skeleton">
      <span className="sr-only">Loading mentors…</span>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="p-5">
          <div className="flex items-start gap-3.5">
            <Skeleton className="size-12 rounded-full" />
            <div className="flex-1 space-y-2 pt-1"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>
          </div>
          <div className="mt-5 space-y-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div>
          <Skeleton className="mt-5 h-3 w-1/3" />
          <div className="mt-4 border-t border-border pt-4"><Skeleton className="h-4 w-24" /></div>
        </Card>
      ))}
    </div>
  );
}
