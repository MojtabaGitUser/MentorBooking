import type { PoolClient } from 'pg';
import type { LedgerService } from '../wallet/ledger.service';

export interface RefundInput {
  menteeId: string;
  sessionId: string;
  kind: 'CANCELLATION_REFUND' | 'MENTOR_REFUND';
  idempotencyKey: string;
  reason: string;
  now: Date;
}

export interface RefundResult {
  credits: 1;
  creditType: 'NORMAL' | 'ROLLOVER';
  lotId: string;
  reissued: boolean;
}

// Returns the one credit the session consumed, attributed per design decision B3:
// - NORMAL source lot: credit back to that lot.
// - ROLLOVER source lot still valid at `now`: credit back to it; its expiry is unchanged.
// - ROLLOVER source lot expired at `now` (expires_at <= now, as in the wallet): issue a new
//   NORMAL lot originating from the session and credit it. The expired lot is never revived and
//   the original allocation row is left untouched for audit.
// Caller must hold the mentee lock and have made the cancellation decision in the same transaction.
export async function refundAllocatedCredit(tx: PoolClient, ledger: LedgerService, input: RefundInput): Promise<RefundResult> {
  const { rows: [source] } = await tx.query<{ lot_id: string; credit_type: 'NORMAL' | 'ROLLOVER'; expired: boolean }>(`
    SELECT a.lot_id, l.credit_type, l.expires_at IS NOT NULL AND l.expires_at <= $3::timestamptz AS expired
    FROM session_credit_allocations a JOIN credit_lots l ON l.id=a.lot_id
    WHERE a.session_id=$1 AND a.mentee_id=$2`, [input.sessionId, input.menteeId, input.now]);
  if (!source) throw new Error('Session has no credit allocation');

  let lotId = source.lot_id;
  let creditType = source.credit_type;
  let reason = input.reason;
  if (source.credit_type === 'ROLLOVER' && source.expired) {
    const { rows: [lot] } = await tx.query<{ id: string }>(`INSERT INTO credit_lots
      (mentee_id, credit_type, original_quantity, session_id) VALUES ($1,'NORMAL',1,$2) RETURNING id`,
    [input.menteeId, input.sessionId]);
    lotId = lot.id;
    creditType = 'NORMAL';
    reason += ` Original rollover lot ${source.lot_id} had expired; refunded as normal credit.`;
  }
  await ledger.appendEntry(tx, { menteeId: input.menteeId, lotId, sessionId: input.sessionId,
    kind: input.kind, delta: 1, idempotencyKey: input.idempotencyKey, reason });
  return { credits: 1, creditType, lotId, reissued: lotId !== source.lot_id };
}
