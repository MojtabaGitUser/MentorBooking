import { BadRequestException, Injectable } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { entryColumns, type LedgerEntry } from './ledger.service';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalidPage(): never {
  throw new BadRequestException({ code: 'INVALID_PAGE', message: 'Use a valid wallet cursor and a limit from 1 to 100.' });
}

export function pageOptions(cursor?: unknown, limit?: unknown) {
  if (cursor !== undefined && (typeof cursor !== 'string' || !uuid.test(cursor))) invalidPage();
  if (limit !== undefined && (typeof limit !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(limit))) invalidPage();
  return { cursor, limit: limit === undefined ? 20 : Number(limit) };
}

export interface LotBalance {
  lotId: string;
  expiresAt: Date | null;
  remaining: string;
  expired: boolean;
}

export async function readLotBalances(db: PoolClient, menteeId: string, at: Date | undefined, mode: 'spending' | 'history') {
  // A locked spend uses all committed movements, even if the caller waited for a
  // transaction whose ledger timestamp is later than the supplied expiry clock.
  const cutoff = mode === 'history' ? 'now()' : 'statement_timestamp()';
  const instant = `COALESCE($2::timestamptz, ${cutoff})`;
  const historyFilter = mode === 'history' ? `AND e.created_at <= ${instant}` : '';
  const result = await db.query<LotBalance>(`SELECT l.id AS "lotId", l.expires_at AS "expiresAt",
      l.expires_at IS NOT NULL AND l.expires_at <= ${instant} AS expired, SUM(e.delta) AS remaining
    FROM ledger_entries e JOIN credit_lots l ON l.id=e.lot_id
    WHERE e.mentee_id=$1 ${historyFilter}
    GROUP BY l.id ORDER BY l.expires_at ASC NULLS LAST, l.created_at, l.id`, [menteeId, at]);
  return result.rows;
}

interface HistoryEntry extends LedgerEntry {
  creditType: 'NORMAL' | 'ROLLOVER';
  expiresAt: Date | null;
}

export function summarizeLots(lots: LotBalance[]) {
  let normal = 0;
  let rollover = 0;
  let debt = 0;
  const rolloverLots: { lotId: string; remaining: number; expiresAt: Date }[] = [];
  for (const lot of lots) {
    const remaining = Number(lot.remaining);
    if (remaining < 0) debt += remaining;
    else if (lot.expiresAt === null) normal += remaining;
    else if (!lot.expired && remaining > 0) {
      rollover += remaining;
      rolloverLots.push({ lotId: lot.lotId, remaining, expiresAt: lot.expiresAt });
    }
  }
  const positive = normal + rollover;
  if (![normal, rollover, debt, positive].every(Number.isSafeInteger)) {
    throw new RangeError('Wallet totals exceed the exact integer range of the API.');
  }
  return { normal, rollover, debt, totalSpendable: Math.max(0, positive + debt), rolloverLots };
}

@Injectable()
export class WalletService {
  constructor(private readonly pool: Pool) {}

  async getWallet(menteeId: string, asOf?: Date, includePurchases = false) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const lots = await readLotBalances(db, menteeId, asOf, 'history');
      const history = await this.readPage(db, menteeId, 20, undefined, asOf);
      const purchases = includePurchases ? (await db.query(`SELECT id AS "paymentId",
        provider_payment_id AS "providerPaymentId", credits_purchased AS "packCredits", status,
        created_at AS "createdAt" FROM payments WHERE mentee_id=$1
        ORDER BY created_at DESC, id DESC LIMIT 10`, [menteeId])).rows : undefined;
      await db.query('COMMIT');
      const lastExpired = lots.filter(lot => lot.expired).at(-1);
      return { ...summarizeLots(lots), ...(purchases && { purchases }), ...(lastExpired && { lastRolloverExpiry: lastExpired.expiresAt }), history };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally { db.release(); }
  }

  async transactions(menteeId: string, cursor?: unknown, limit?: unknown) {
    const options = pageOptions(cursor, limit);
    return this.readPage(this.pool, menteeId, options.limit, options.cursor);
  }

  private async readPage(db: Pool | PoolClient, menteeId: string, limit: number, cursor?: string, asOf?: Date) {
    if (cursor) {
      const anchor = await db.query('SELECT 1 FROM ledger_entries WHERE mentee_id=$1 AND id=$2', [menteeId, cursor]);
      if (!anchor.rowCount) invalidPage();
    }
    const result = await db.query<HistoryEntry>(`SELECT ${entryColumns}, l.credit_type AS "creditType", l.expires_at AS "expiresAt"
      FROM ledger_entries e JOIN credit_lots l ON l.id=e.lot_id
      WHERE e.mentee_id=$1 AND e.created_at <= COALESCE($4::timestamptz, now())
        AND ($2::uuid IS NULL OR (e.created_at,e.id) < (
          SELECT created_at,id FROM ledger_entries WHERE id=$2 AND mentee_id=$1))
      ORDER BY e.created_at DESC,e.id DESC LIMIT $3`, [menteeId,cursor,limit+1,asOf]);
    const items = result.rows.slice(0, limit);
    return { items, nextCursor: result.rows.length > limit ? items[limit-1].id : null };
  }
}
