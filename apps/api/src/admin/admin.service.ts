import { ConflictException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException,
  UnprocessableEntityException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import type { AuthenticatedUser } from '../auth/access';
import { LedgerService } from '../wallet/ledger.service';
import { readLotBalances, summarizeLots, WalletService } from '../wallet/wallet.service';
import { adjustmentRequest, targetUserId, type AdjustmentRequest } from './admin-input';

interface AdjustmentRow {
  id: string;
  menteeId: string;
  adminId: string;
  delta: number;
  reason: string;
  idempotencyKey: string;
  createdAt: Date;
}

const RETRYABLE = new Set(['40001', '40P01']);
const adjustmentColumns = `id, mentee_id AS "menteeId", admin_id AS "adminId", delta, reason,
  idempotency_key AS "idempotencyKey", created_at AS "createdAt"`;

function targetMissing(): never {
  throw new NotFoundException({ code: 'TARGET_USER_NOT_FOUND', message: 'User not found.' });
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private readonly pool: Pool, private readonly ledger: LedgerService, private readonly wallets: WalletService) {}

  async findUsers(query: unknown) {
    const search = typeof query === 'string' ? query.trim() : '';
    const { rows } = await this.pool.query(`SELECT id, role, display_name AS "displayName" FROM users
      WHERE strpos(lower(display_name), lower($1)) > 0 OR id::text = lower($1)
      ORDER BY display_name, id LIMIT 26`, [search]);
    return { items: rows.slice(0, 25), hasMore: rows.length > 25 };
  }

  // Any user's ledger. Mentors and admins hold no credit, so their ledger is empty.
  async ledgerFor(userId: string, cursor?: unknown, limit?: unknown) {
    const id = targetUserId(userId);
    const { rows: [user] } = await this.pool.query<{ id: string; role: string; displayName: string }>(
      'SELECT id, role, display_name AS "displayName" FROM users WHERE id=$1', [id]);
    if (!user) targetMissing();
    const page = await this.wallets.transactions(id, cursor, limit);
    const adjustments = page.items.map(item => item.adjustmentId).filter((value): value is string => !!value);
    const { rows } = await this.pool.query<{ id: string; adminId: string }>(
      'SELECT id, admin_id AS "adminId" FROM credit_adjustments WHERE id = ANY($1::uuid[])', [adjustments]);
    const adjustedBy = new Map(rows.map(row => [row.id, row.adminId]));
    const balance = user.role === 'mentee' ? summarizeLots(await this.balances(id)) : null;
    return { user, balance: balance && { normal: balance.normal, rollover: balance.rollover, debt: balance.debt,
      totalSpendable: balance.totalSpendable },
    items: page.items.map(item => ({ ...item, adjustedBy: item.adjustmentId ? adjustedBy.get(item.adjustmentId) ?? null : null })),
    nextCursor: page.nextCursor };
  }

  async adjust(admin: AuthenticatedUser, userId: string, body: unknown, now?: Date) {
    const menteeId = targetUserId(userId);
    const request = adjustmentRequest(body);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(admin.id, menteeId, request, now);
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = (error as { code?: string; constraint?: string }).code;
        // A unique-key race can only follow a committed winner; retry to replay it.
        const replayRace = code === '23505' && (error as { constraint?: string }).constraint === 'credit_adjustments_idempotency_key_key';
        if (attempt < 3 && (RETRYABLE.has(code ?? '') || replayRace)) continue;
        this.logger.error(`Credit adjustment failed: ${code ?? (error as Error).message}`);
        throw new InternalServerErrorException({ code: 'ADJUSTMENT_FAILED', message: 'Adjustment could not be completed. Nothing was changed; please retry.' });
      }
    }
  }

  private async attempt(adminId: string, menteeId: string, request: AdjustmentRequest, now?: Date) {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const { rows: [target] } = await tx.query<{ role: string }>('SELECT role FROM users WHERE id=$1', [menteeId]);
      if (!target) targetMissing();
      if (target.role !== 'mentee') {
        throw new UnprocessableEntityException({ code: 'TARGET_NOT_MENTEE', message: 'Only mentees hold credits.' });
      }
      // The same mentee lock as booking, cancellation, payments and expiry.
      await this.ledger.lockMentee(tx, menteeId);
      const { rows: [prior] } = await tx.query<AdjustmentRow>(
        `SELECT ${adjustmentColumns} FROM credit_adjustments WHERE idempotency_key=$1`, [request.idempotencyKey]);
      const result = prior
        ? await this.replay(tx, prior, adminId, menteeId, request)
        : await this.apply(tx, adminId, menteeId, request, now);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally { tx.release(); }
  }

  private async apply(tx: PoolClient, adminId: string, menteeId: string, request: AdjustmentRequest, now?: Date) {
    let plan: { lotId: string; delta: number }[] = [];
    if (request.delta < 0) {
      // Revoke only spendable credit, in the US-10 spend order (rollover by expiry, then normal),
      // never more than a lot holds, so no lot goes negative and debt is never deepened.
      const lots = await readLotBalances(tx, menteeId, now, 'spending');
      const available = summarizeLots(lots).totalSpendable;
      if (available < -request.delta) {
        throw new ConflictException({ code: 'INSUFFICIENT_CREDITS',
          message: 'Cannot revoke more than the mentee\'s spendable credit.', details: { available, requested: -request.delta } });
      }
      let remaining = -request.delta;
      for (const lot of lots) {
        if (remaining === 0) break;
        const balance = Number(lot.remaining);
        if (lot.expired || balance <= 0) continue;
        const take = Math.min(balance, remaining);
        plan.push({ lotId: lot.lotId, delta: -take });
        remaining -= take;
      }
    }
    const { rows: [adjustment] } = await tx.query<AdjustmentRow>(`INSERT INTO credit_adjustments
      (idempotency_key, mentee_id, admin_id, reason, delta) VALUES ($1,$2,$3,$4,$5) RETURNING ${adjustmentColumns}`,
    [request.idempotencyKey, menteeId, adminId, request.reason, request.delta]);
    if (request.delta > 0) {
      const { rows: [lot] } = await tx.query<{ id: string }>(`INSERT INTO credit_lots
        (mentee_id, credit_type, original_quantity, adjustment_id) VALUES ($1,'NORMAL',$2,$3) RETURNING id`,
      [menteeId, request.delta, adjustment.id]);
      plan = [{ lotId: lot.id, delta: request.delta }];
    }
    for (const step of plan) {
      await this.ledger.appendEntry(tx, { menteeId, lotId: step.lotId, adjustmentId: adjustment.id, reason: request.reason,
        kind: step.delta > 0 ? 'ADMIN_GRANT' : 'ADMIN_REVOKE', delta: step.delta,
        idempotencyKey: `admin-adjustment:${adjustment.id}:${step.lotId}` });
    }
    return { replayed: false, receipt: await this.receipt(tx, adjustment) };
  }

  private async replay(tx: PoolClient, prior: AdjustmentRow, adminId: string, menteeId: string, request: AdjustmentRequest) {
    if (prior.menteeId !== menteeId || prior.adminId !== adminId || prior.delta !== request.delta || prior.reason !== request.reason) {
      throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'This idempotencyKey was already used for a different adjustment.' });
    }
    return { replayed: true, receipt: await this.receipt(tx, prior) };
  }

  private async receipt(tx: PoolClient, adjustment: AdjustmentRow) {
    const { rows: entries } = await tx.query(`SELECT id, kind, delta, lot_id AS "lotId", created_at AS "createdAt"
      FROM ledger_entries WHERE adjustment_id=$1 ORDER BY created_at, id`, [adjustment.id]);
    return { adjustmentId: adjustment.id, menteeId: adjustment.menteeId, adjustedBy: adjustment.adminId,
      delta: adjustment.delta, reason: adjustment.reason, idempotencyKey: adjustment.idempotencyKey,
      createdAt: adjustment.createdAt, entries };
  }

  private async balances(menteeId: string) {
    const db = await this.pool.connect();
    try { return await readLotBalances(db, menteeId, undefined, 'history'); } finally { db.release(); }
  }
}
