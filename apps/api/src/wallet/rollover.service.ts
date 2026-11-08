import { Injectable } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { LedgerService } from './ledger.service';
import { readLotBalances, summarizeLots, type LotBalance } from './wallet.service';

// PostgreSQL orders the rows so timestamp comparisons retain microsecond precision.
export function firstSpendableLot(lots: LotBalance[]) {
  if (summarizeLots(lots).totalSpendable < 1) return null;
  const lot = lots.find(row => !row.expired && Number(row.remaining) > 0);
  if (!lot) return null;
  return { lotId: lot.lotId, remaining: Number(lot.remaining), expiresAt: lot.expiresAt };
}

const dueLots = `SELECT l.id, l.mentee_id, SUM(e.delta) AS remaining
  FROM credit_lots l JOIN ledger_entries e ON e.lot_id=l.id
  WHERE l.credit_type='ROLLOVER' AND l.expires_at <= COALESCE($1::timestamptz, statement_timestamp())`;

@Injectable()
export class RolloverService {
  constructor(private readonly pool: Pool, private readonly ledger: LedgerService) {}

  async selectSpendableLot(tx: PoolClient, menteeId: string, now?: Date) {
    await this.ledger.lockMentee(tx, menteeId);
    const lots = await readLotBalances(tx, menteeId, now, 'spending');
    return firstSpendableLot(lots);
  }

  async expireRolloverLots(now?: Date) {
    const owners = await this.pool.query<{ mentee_id: string }>(`
      SELECT DISTINCT mentee_id FROM (
        ${dueLots} GROUP BY l.id HAVING SUM(e.delta)>0
      ) due ORDER BY mentee_id`, [now]);
    let expiredLots = 0;
    for (const owner of owners.rows) {
      const tx = await this.pool.connect();
      try {
        await tx.query('BEGIN');
        await this.ledger.lockMentee(tx, owner.mentee_id);
        // Re-read after the lock: another worker or spender may have consumed the lot.
        const due = await tx.query<{ id: string; remaining: string }>(`
          ${dueLots} AND l.mentee_id=$2 GROUP BY l.id HAVING SUM(e.delta)>0 ORDER BY l.id`,
          [now, owner.mentee_id]);
        for (const lot of due.rows) {
          await this.ledger.appendEntry(tx, { menteeId: owner.mentee_id, lotId: lot.id,
            kind: 'ROLLOVER_EXPIRE', delta: -Number(lot.remaining),
            reason: 'Unspent rollover credit expired.', idempotencyKey: 'rollover-expire:' + lot.id });
        }
        await tx.query('COMMIT');
        expiredLots += due.rowCount ?? 0;
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally { tx.release(); }
    }
    return { expiredLots };
  }
}
