import { Skeleton } from '@/components/ui/skeleton';
export default function WalletLoading() {
  return (
    <div role="status" className="space-y-4">
      <span className="sr-only">Loading wallet activity…</span>
      <Skeleton className="h-9 w-52" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
