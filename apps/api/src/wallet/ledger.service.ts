import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';

export type LedgerKind = 'PURCHASE_GRANT' | 'BOOKING_DEBIT' | 'CANCELLATION_REFUND' |
  'MENTOR_REFUND' | 'NO_SHOW_ROLLOVER' | 'ROLLOVER_EXPIRE' | 'ADMIN_GRANT' |
  'ADMIN_REVOKE' | 'PAYMENT_REVERSAL' | 'DEBT';

export interface AppendEntry {
  menteeId: string;
  lotId: string;
  kind: LedgerKind;
  delta: number;
  idempotencyKey: string;
  sessionId?: string;
  paymentId?: string;
  adjustmentId?: string;
  reason?: string;
}

export const entryColumns = `e.id, e.mentee_id AS "menteeId", e.lot_id AS "lotId", e.kind,
  e.delta, e.session_id AS "sessionId", e.payment_id AS "paymentId",
  e.adjustment_id AS "adjustmentId", e.reason, e.idempotency_key AS "idempotencyKey",
  e.created_at AS "createdAt"`;

export interface LedgerEntry extends Omit<AppendEntry, 'sessionId' | 'paymentId' | 'adjustmentId' | 'reason'> {
  id: string;
  sessionId: string | null;
  paymentId: string | null;
  adjustmentId: string | null;
  reason: string | null;
  createdAt: Date;
}

function invalid(message: string): never {
  throw new UnprocessableEntityException({ code: 'INVALID_LEDGER_ENTRY', message });
}

@Injectable()
export class LedgerService {
  // Call before balance checks and before locking a mentor in a multi-resource operation.
  async lockMentee(tx: PoolClient, menteeId: string) {
    if (tx.getTransactionStatus() !== 'T') throw new Error('An active PostgreSQL transaction is required');
    const result = await tx.query("SELECT id FROM users WHERE id=$1 AND role='mentee' FOR UPDATE", [menteeId]);
    if (!result.rowCount) invalid('A valid mentee is required.');
  }

  async appendEntry(tx: PoolClient, input: AppendEntry): Promise<LedgerEntry> {
    if (!input.idempotencyKey.trim() || !Number.isInteger(input.delta) || input.delta === 0) {
      invalid('A nonzero integer delta and an idempotency key are required.');
    }
    if (['ADMIN_GRANT', 'ADMIN_REVOKE'].includes(input.kind) && !input.reason?.trim()) {
      invalid('Administrative adjustments require a reason.');
    }
    await this.lockMentee(tx, input.menteeId);
    const { menteeId, lotId, kind, delta, idempotencyKey } = input;
    const sessionId = input.sessionId ?? null;
    const paymentId = input.paymentId ?? null;
    const adjustmentId = input.adjustmentId ?? null;
    const reason = input.reason ?? null;
    const args = [menteeId, lotId, kind, delta, sessionId, paymentId, adjustmentId, reason, idempotencyKey];

    // Composite FKs check the owner of each linked source. Also match originating
    // grants/reversals to their precise funding lot (one mentee can own several).
    const inserted = await tx.query<LedgerEntry>(`INSERT INTO ledger_entries AS e
      (mentee_id,lot_id,kind,delta,session_id,payment_id,adjustment_id,reason,idempotency_key)
      SELECT $1::uuid,$2::uuid,$3::ledger_kind,$4::integer,$5::uuid,$6::uuid,$7::uuid,$8::text,$9::text FROM credit_lots AS l
      WHERE l.id=$2 AND l.mentee_id=$1 AND CASE
        WHEN $3::ledger_kind IN ('PURCHASE_GRANT','PAYMENT_REVERSAL','DEBT') THEN l.payment_id=$6
        WHEN $3::ledger_kind='ADMIN_GRANT' THEN l.adjustment_id=$7
        WHEN $3::ledger_kind='NO_SHOW_ROLLOVER' THEN l.credit_type='ROLLOVER' AND l.session_id=$5
        WHEN $3::ledger_kind='ROLLOVER_EXPIRE' THEN l.credit_type='ROLLOVER'
        ELSE true END
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${entryColumns}`, args);
    if (inserted.rows[0]) return inserted.rows[0];

    // Separate statement observes a concurrently committed winner at READ COMMITTED.
    const existing = (await tx.query<LedgerEntry>(
      `SELECT ${entryColumns} FROM ledger_entries e WHERE idempotency_key=$1`, [idempotencyKey],
    )).rows[0];
    if (!existing) invalid('The credit lot must match the mentee and funding source.');
    if (existing.menteeId !== menteeId.toLowerCase() || existing.lotId !== lotId.toLowerCase() ||
        existing.kind !== kind || existing.delta !== delta || existing.reason !== reason ||
        existing.sessionId !== (sessionId?.toLowerCase() ?? null) ||
        existing.paymentId !== (paymentId?.toLowerCase() ?? null) ||
        existing.adjustmentId !== (adjustmentId?.toLowerCase() ?? null)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Key already used for another entry.' });
    }
    return existing;
  }
}
