import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { ApiErrorState } from '@/components/states/api-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Ledger } from '@/components/wallet/ledger';
import { apiGet } from '@/lib/api';
import { currentUser, homeFor } from '@/lib/session';
import type { LedgerPage } from '@/lib/wallet';
export const metadata = { title: 'Transaction history' };
export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const user = await currentUser();
  if (!user) redirect('/?error=signin-required');
  if (user.role !== 'mentee') redirect(homeFor(user.role));
  const { cursor } = await searchParams;
  let page: LedgerPage;
  try {
    page = await apiGet<LedgerPage>(
      '/wallet/me/transactions?limit=20' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
  } catch (error) {
    return (
      <>
        <Link className="text-sm underline" href="/wallet/history">
          Latest transactions
        </Link>
        <ApiErrorState error={error} />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Transaction history"
        description={'Most recent first · ' + user.timezone}
        breadcrumbs={[{ label: 'My wallet', href: '/wallet' }, { label: 'History' }]}
      />
      <Card className="p-5 sm:px-6">
        <Ledger rows={page.items} zone={user.timezone} />
      </Card>
      <nav aria-label="Ledger pages" className="mt-4 flex justify-between gap-3">
        {cursor && (
          <Button asChild variant="outline">
            <Link href="/wallet/history">Latest transactions</Link>
          </Button>
        )}
        {page.nextCursor && (
          <Button asChild variant="outline" className="ml-auto">
            <Link href={'/wallet/history?cursor=' + page.nextCursor}>Older transactions</Link>
          </Button>
        )}
      </nav>
    </>
  );
}
