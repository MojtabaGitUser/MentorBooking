import Link from 'next/link';
import { requireRole } from '@/lib/require-role';
import { apiGet, bookingAccountScope } from '@/lib/api';
import { ApiErrorState } from '@/components/states/api-error';
import { PageHeader } from '@/components/layout/page-header';
import { MentorSessions } from '@/components/dashboard/mentor-sessions';
import { Button } from '@/components/ui/button';
import type { MentorSession } from '@/lib/dashboard';
export default async function Sessions({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireRole('mentor'),
    past = (await searchParams).status === 'past';
  try {
    const { items } = await apiGet<{ items: MentorSession[] }>(
      '/mentor/sessions?status=' + (past ? 'past' : 'upcoming'),
    );
    return (
      <>
        <PageHeader
          title="My sessions"
          description={user.timezone}
          breadcrumbs={[{ label: 'Dashboard', href: '/mentor' }, { label: 'My sessions' }]}
        />
        <nav aria-label="Session views" className="mb-4 flex gap-2">
          {['Upcoming', 'Past'].map((label) => (
            <Button key={label} asChild variant={(label === 'Past') === past ? 'secondary' : 'ghost'}>
              <Link href={label === 'Past' ? '/mentor/sessions?status=past' : '/mentor/sessions'}>
                {label}
              </Link>
            </Button>
          ))}
        </nav>
        <MentorSessions
          items={items}
          zone={user.timezone}
          initialNow={Date.now()}
          account={bookingAccountScope(user.id)}
          past={past}
        />
      </>
    );
  } catch (e) {
    return <ApiErrorState error={e} />;
  }
}
