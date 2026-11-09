import { PageHeader } from '@/components/layout/page-header';
import { MentorGridSkeleton } from '@/components/mentors/mentor-grid-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <>
      <PageHeader title="Find your mentor" description="Discover experienced mentors and find the right guidance for your goals." />
      <Skeleton className="h-[7.5rem] rounded-xl sm:h-[5.25rem]" />
      <Skeleton className="mt-6 h-5 w-24" />
      <div className="mt-6"><MentorGridSkeleton /></div>
    </>
  );
}
