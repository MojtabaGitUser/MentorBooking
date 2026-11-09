import type { Session } from '@/lib/types';
import { creditDelta, movementLabels, walletTime } from '@/lib/wallet';

export function SessionOutcome({ session, zone }: { session: Session; zone: string }) {
  const movements = session.creditActivity ?? [];
  return (
    <details className="mt-3 text-sm">
      <summary className="w-fit cursor-pointer font-medium">Attendance &amp; credit details</summary>
      <div className="mt-2 space-y-2 border-l-2 border-border pl-3">
        <p>
          You:{' '}
          {session.joinedMenteeAt ? 'joined ' + walletTime(session.joinedMenteeAt, zone) : 'no recorded join'}
          <br />
          Mentor:{' '}
          {session.joinedMentorAt ? 'joined ' + walletTime(session.joinedMentorAt, zone) : 'no recorded join'}
        </p>
        {movements.length === 0 ? (
          <p>No linked credit entries.</p>
        ) : (
          <ul>
            {movements.map((m) => (
              <li key={m.id} className="mb-1">
                {movementLabels[m.kind]} · {creditDelta(m.delta)} ({m.creditType.toLowerCase()})
                {m.expiresAt && <> · Lot expiry {walletTime(m.expiresAt, zone)}</>}
              </li>
            ))}
          </ul>
        )}
        {movements.some((m) => m.kind === 'BOOKING_DEBIT') && !movements.some((m) => m.delta > 0) && (
          <p>No refund or rollover award recorded.</p>
        )}
      </div>
    </details>
  );
}
