import { UserX } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/states/empty-state';
import { Button } from '@/components/ui/button';

export default function MentorNotFound() {
  return (
    <>
      <PageHeader title="Mentor not found" breadcrumbs={[{ label: 'Mentors', href: '/mentors' }, { label: 'Not found' }]} />
      <EmptyState icon={UserX} title="We couldn't find this mentor"
        description="The link may be out of date, or the mentor is no longer listed."
        action={<Button asChild><Link href="/mentors">Browse mentors</Link></Button>} />
    </>
  );
}
