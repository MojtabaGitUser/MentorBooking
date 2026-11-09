import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { SessionList } from '@/components/booking/session-list';
import { ApiErrorState } from '@/components/states/api-error';
import { Button } from '@/components/ui/button';
import { apiGet, bookingAccountScope } from '@/lib/api';
import { currentUser, homeFor } from '@/lib/session';
import type { Session } from '@/lib/types';

export const metadata = { title: 'My sessions' };
export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await currentUser();
  if (!user) redirect('/?error=signin-required');
  if (user.role !== 'mentee') redirect(homeFor(user.role));
  const past = (await searchParams).status === 'past';
  let data;
  try {
    data = await Promise.all([
      apiGet<{ items: Session[] }>('/sessions/me?status=' + (past ? 'past' : 'upcoming')),
      apiGet<{ totalSpendable: number }>('/wallet/me'),
    ]);
  } catch (error) {
    return <ApiErrorState error={error} />;
  }
  const [sessions, wallet] = data;
  return (
    <>
      <PageHeader
        title="My sessions"
        description={`Times in ${user.timezone} · ${wallet.totalSpendable} spendable credit${wallet.totalSpendable === 1 ? '' : 's'}`}
        actions={
          <Button asChild variant="outline">
            <Link href="/mentors">Discover mentors</Link>
          </Button>
        }
      />
      <nav aria-label="Session views" className="mb-5 flex gap-2">
        {['Upcoming', 'Past'].map((label) => {
          const active = (label === 'Past') === past;
          return (
            <Button key={label} asChild variant={active ? 'secondary' : 'ghost'}>
              <Link
                aria-current={active ? 'page' : undefined}
                href={label === 'Past' ? '/sessions?status=past' : '/sessions'}
              >
                {label}
              </Link>
            </Button>
          );
        })}
      </nav>
      <SessionList
        account={bookingAccountScope(user.id)}
        zone={user.timezone}
        items={sessions.items}
        past={past}
        initialNow={Date.now()}
      />
    </>
  );
}
