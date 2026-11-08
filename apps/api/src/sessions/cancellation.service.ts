import { HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { requireResourceAccess, type AuthenticatedUser } from '../auth/access';
import { LedgerService } from '../wallet/ledger.service';
import { cancellationRequest, menteeCancellationPolicy, notCancellable, policyChanged } from './cancellation-policy';
import { refundAllocatedCredit } from './refund';

interface SessionRow {
  id: string;
  menteeId: string;
  mentorId: string;
  status: string;
  startsAt: Date;
  cancelledAt: Date | null;
  cancellationActor: string | null;
}

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const columns = `id, mentee_id AS "menteeId", mentor_id AS "mentorId", status, starts_at AS "startsAt",
  cancelled_at AS "cancelledAt", cancellation_actor AS "cancellationActor"`;
const RETRYABLE = new Set(['40001', '40P01']);

function notFound(): never {
  throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Session not found.' });
}

@Injectable()
export class CancellationService {
  private readonly logger = new Logger(CancellationService.name);

  constructor(private readonly pool: Pool, private readonly ledger: LedgerService) {}

  // `now` is a trusted test clock only; controllers never pass it.
  async preview(user: AuthenticatedUser, sessionId: string, now?: Date) {
    const session = await this.owned(this.pool, user, sessionId);
    return menteeCancellationPolicy(session, await this.clock(this.pool, now));
  }

  async cancel(user: AuthenticatedUser, sessionId: string, body: unknown, now?: Date) {
    const expected = cancellationRequest(body);
    const session = await this.owned(this.pool, user, sessionId);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(session, expected, now);
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = (error as { code?: string }).code;
        if (attempt < 3 && RETRYABLE.has(code ?? '')) continue;
        this.logger.error(`Cancellation failed: ${code ?? (error as Error).message}`);
        throw new InternalServerErrorException({ code: 'CANCELLATION_FAILED',
          message: 'Cancellation could not be completed. Nothing was changed; please retry.' });
      }
    }
  }

  private async attempt(owned: SessionRow, expected: 0 | 1, now?: Date) {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // Global lock order (same as US-11 booking): mentee row, mentor profile row, then the session row.
      await this.ledger.lockMentee(tx, owned.menteeId);
      await tx.query('SELECT 1 FROM mentor_profiles WHERE mentor_id=$1 FOR UPDATE', [owned.mentorId]);
      const { rows: [session] } = await tx.query<SessionRow>(`SELECT ${columns} FROM sessions WHERE id=$1 FOR UPDATE`, [owned.id]);
      // The decision instant is read after every lock is held.
      const clock = await this.clock(tx, now);
      const result = session.status === 'cancelled'
        ? await this.recorded(tx, session)
        : await this.decide(tx, session, expected, clock);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally { tx.release(); }
  }

  private async decide(tx: PoolClient, session: SessionRow, expected: 0 | 1, now: Date) {
    const policy = menteeCancellationPolicy(session, now);
    if (!policy.eligible) notCancellable(policy);
    // Never apply an outcome the mentee did not confirm, in either direction.
    if (policy.refundableCredits !== expected) policyChanged(policy);
    const updated = await tx.query(`UPDATE sessions SET status='cancelled', cancelled_at=$2, cancellation_actor=$3
      WHERE id=$1 AND status='scheduled'`, [session.id, now, session.menteeId]);
    if (updated.rowCount !== 1) throw new Error('Locked session changed state');
    const refund = policy.refundableCredits
      ? await refundAllocatedCredit(tx, this.ledger, { menteeId: session.menteeId, sessionId: session.id,
        kind: 'CANCELLATION_REFUND', idempotencyKey: 'cancel-refund:' + session.id, now,
        reason: 'Mentee cancelled more than 24 hours before the session start.' })
      : null;
    return { sessionId: session.id, status: 'cancelled', cancelledAt: now.toISOString(), cancelledBy: 'mentee',
      alreadyCancelled: false, reason: policy.reason,
      refund: { credits: refund?.credits ?? 0, creditType: refund?.creditType ?? null, lotId: refund?.lotId ?? null } };
  }

  // Repeated requests after any committed cancellation are stable no-ops reporting what happened.
  private async recorded(tx: PoolClient, session: SessionRow) {
    const { rows: [refund] } = await tx.query<{ credits: number; lot_id: string | null; credit_type: string | null }>(`
      SELECT COALESCE(SUM(e.delta),0)::int AS credits, MIN(e.lot_id::text) AS lot_id, MIN(l.credit_type::text) AS credit_type
      FROM ledger_entries e JOIN credit_lots l ON l.id=e.lot_id
      WHERE e.session_id=$1 AND e.kind IN ('CANCELLATION_REFUND','MENTOR_REFUND')`, [session.id]);
    return { sessionId: session.id, status: 'cancelled', cancelledAt: session.cancelledAt!.toISOString(),
      cancelledBy: session.cancellationActor === session.menteeId ? 'mentee' : 'mentor', alreadyCancelled: true,
      reason: 'ALREADY_CANCELLED',
      refund: { credits: refund.credits, creditType: refund.credit_type, lotId: refund.lot_id } };
  }

  private async owned(db: Pool | PoolClient, user: AuthenticatedUser, sessionId: string) {
    if (!uuid.test(sessionId)) notFound();
    const { rows: [session] } = await db.query<SessionRow>(`SELECT ${columns} FROM sessions WHERE id=$1`, [sessionId]);
    if (!session) notFound();
    requireResourceAccess(user, 'readSessions', session.menteeId);
    return session;
  }

  private async clock(db: Pool | PoolClient, now?: Date) {
    const { rows: [row] } = await db.query<{ now: Date }>('SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now', [now ?? null]);
    return row.now;
  }
}

