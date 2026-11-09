import { ReceiptText } from 'lucide-react';
import { EmptyState } from '@/components/states/empty-state';
import { Badge } from '@/components/ui/badge';
import { creditDelta, movementLabels, walletTime, type LedgerRow } from '@/lib/wallet';

export function Ledger({ rows, zone }: { rows: LedgerRow[]; zone: string }) {
  if (!rows.length)
    return (
      <EmptyState
        icon={ReceiptText}
        title="No transactions yet"
        description="Credit purchases, session charges and refunds will appear here."
      />
    );
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.id} className="py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-medium">{movementLabels[row.kind]}</h3>
              <time className="text-xs text-muted-foreground" dateTime={row.createdAt}>
                {walletTime(row.createdAt, zone)}
              </time>
            </div>
            <Badge variant={row.delta > 0 ? 'success' : 'neutral'} className="shrink-0 tabular-nums">
              {creditDelta(row.delta)}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {row.creditType === 'NORMAL' ? 'Normal' : 'Rollover'} credit
            {row.expiresAt && (
              <>
                {' '}
                · {Date.parse(row.expiresAt) <= Date.now() ? 'Expired' : 'Expires'}{' '}
                {walletTime(row.expiresAt, zone)}
              </>
            )}
          </p>
          {row.reason && <p className="mt-1 break-words text-sm">{row.reason}</p>}
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer rounded font-medium">Transaction details</summary>
            <dl className="mt-2 space-y-1">
              {Object.entries({
                Transaction: row.id,
                Lot: row.lotId,
                Session: row.sessionId,
                Payment: row.paymentId,
                Adjustment: row.adjustmentId,
              })
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt className="inline">{k} </dt>
                    <dd className="inline break-all font-mono">{v}</dd>
                  </div>
                ))}
            </dl>
          </details>
        </li>
      ))}
    </ul>
  );
}
