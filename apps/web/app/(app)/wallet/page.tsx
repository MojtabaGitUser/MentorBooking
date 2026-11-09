import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Coins } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { ApiErrorState } from '@/components/states/api-error';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Balance } from '@/components/wallet/balance';
import { Ledger } from '@/components/wallet/ledger';
import { PurchasePack } from '@/components/wallet/purchase';
import { apiGet, bookingAccountScope } from '@/lib/api';
import { currentUser, homeFor } from '@/lib/session';
import { walletTime, type Wallet, type Purchase } from '@/lib/wallet';

export const metadata = { title: 'My wallet' };
export default async function WalletPage() {
  const user = await currentUser();
  if (!user) redirect('/?error=signin-required');
  if (user.role !== 'mentee') redirect(homeFor(user.role));
  let wallet: Wallet & { purchases: Purchase[] };
  try {
    wallet = await apiGet<Wallet & { purchases: Purchase[] }>('/wallet/me?include=purchases');
  } catch (error) {
    return <ApiErrorState error={error} />;
  }
  const { history, purchases, ...balances } = wallet;
  return (
    <>
      <PageHeader title="My wallet" description={'Credit balances and activity · ' + user.timezone} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Balance wallet={balances} zone={user.timezone} />
        <Card className="min-w-0 space-y-4 p-5 sm:p-6">
          <h2 className="flex items-center gap-2 font-semibold">
            <Coins className="size-5 text-primary" />
            Credit pack
          </h2>
          <p className="text-sm text-muted-foreground">
            Four normal credits. Each 30-minute session costs one credit.
          </p>
          <PurchasePack account={bookingAccountScope(user.id)} />
          {purchases.length > 0 && (
            <section className="border-t border-border pt-4">
              <h3 className="text-sm font-semibold">Recent purchases</h3>
              <ul className="divide-y divide-border">
                {purchases.map((p) => (
                  <li key={p.paymentId} className="space-y-2 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">{p.packCredits} credits</span>
                      <Badge
                        variant={
                          p.status === 'SUCCEEDED'
                            ? 'success'
                            : p.status === 'PENDING'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {{ SUCCEEDED: 'Completed', PENDING: 'Pending', REFUNDED: 'Refunded' }[p.status]}
                      </Badge>
                    </div>
                    <time dateTime={p.createdAt} className="text-xs text-muted-foreground">
                      {walletTime(p.createdAt, user.timezone)}
                    </time>
                    {p.status === 'PENDING' && (
                      <details className="text-xs">
                        <summary className="cursor-pointer">Complete demo payment</summary>
                        <p className="my-2">Run in the project terminal, then refresh your wallet.</p>
                        <code className="block break-all rounded-md bg-muted p-2">
                          npm run payment:simulate -- --payment {p.providerPaymentId} --event succeeded
                        </code>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Card>
      </div>
      <Card className="mt-5 p-5 sm:p-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Recent activity</h2>
          <Link href="/wallet/history" className="text-sm font-medium text-primary underline">
            View transaction history
          </Link>
        </div>
        <Ledger rows={history.items.slice(0, 5)} zone={user.timezone} />
      </Card>
    </>
  );
}
