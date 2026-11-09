'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { RefreshCw, WalletCards } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { walletTime, type Wallet } from '@/lib/wallet';

export function Balance({ wallet, zone }: { wallet: Omit<Wallet, 'history'>; zone: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [invalidated, setInvalidated] = useState('');
  const next = wallet.rolloverLots[0]?.expiresAt;
  useEffect(() => {
    if (!next) return;
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      clearTimeout(timer);
      const delay = Date.parse(next!) - Date.now();
      if (delay <= 0) {
        setInvalidated(next!);
        start(() => router.refresh());
      } else timer = setTimeout(check, Math.min(delay, 2_000_000_000));
    }
    check();
    window.addEventListener('focus', check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', check);
    };
  }, [next, router]);
  const stale = !!next && invalidated === next;
  return (
    <section aria-label="Credit balances" className="space-y-4">
      <Card className="overflow-hidden">
        <div className="flex justify-between gap-2 bg-primary-soft p-5 sm:p-6">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-primary-soft-foreground">
              <WalletCards size={18} />
              Spendable credits
            </p>
            <p
              className="mt-3 text-4xl font-semibold tabular-nums"
              aria-live="polite"
              data-testid="spendable"
            >
              {stale ? 'Updating…' : wallet.totalSpendable}
            </p>
            {!stale && wallet.totalSpendable === 0 && (
              <p className="mt-2 text-sm">No credits available to book.</p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => start(() => router.refresh())}
          >
            <RefreshCw size={15} />
            {pending ? 'Refreshing…' : 'Refresh wallet'}
          </Button>
        </div>
        <dl className="grid grid-cols-2 divide-x divide-border p-5 sm:p-6">
          <div>
            <dt className="text-sm text-muted-foreground">Normal credits</dt>
            <dd className="mt-1 text-2xl font-semibold">{wallet.normal}</dd>
          </div>
          <div className="pl-5">
            <dt className="text-sm text-muted-foreground">Rollover credits</dt>
            <dd className="mt-1 text-2xl font-semibold">{stale ? '…' : wallet.rollover}</dd>
          </div>
        </dl>
        {wallet.debt < 0 && (
          <p className="px-5 pb-5 text-sm">
            Outstanding debt: {Math.abs(wallet.debt)} credits. This reduces your spendable balance.
          </p>
        )}
      </Card>
      <Card className="space-y-2 p-5">
        <h2 className="font-semibold">Rollover expiry</h2>
        <p className="text-sm text-muted-foreground">
          Rollover credits are used before normal credits, earliest expiry first.
        </p>
        {!next || stale ? (
          <p className="text-sm">{stale ? 'Checking expired credits…' : 'No spendable rollover lots.'}</p>
        ) : (
          <ul className="divide-y divide-border">
            {wallet.rolloverLots.map((lot, i) => (
              <li key={lot.lotId} className="flex flex-wrap justify-between gap-1 py-2 text-sm">
                <strong>
                  {lot.remaining} {lot.remaining === 1 ? 'credit' : 'credits'}
                  {i === 0 ? ' · Next to expire' : ''}
                </strong>
                <time dateTime={lot.expiresAt}>{walletTime(lot.expiresAt, zone)}</time>
              </li>
            ))}
          </ul>
        )}
        {wallet.lastRolloverExpiry && (
          <p className="text-sm text-muted-foreground">
            Last expired rollover lot: {walletTime(wallet.lastRolloverExpiry, zone)}
          </p>
        )}
      </Card>
    </section>
  );
}
