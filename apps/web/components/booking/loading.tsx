import { Skeleton } from '@/components/ui/skeleton';
export default function BookingLoading() {
  return (
    <div role="status" className="space-y-5">
      <span className="sr-only">Loading schedule…</span>
      <Skeleton className="h-9 w-52" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
