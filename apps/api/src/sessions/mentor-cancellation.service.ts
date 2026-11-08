import { HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { denyAccess, type AuthenticatedUser } from '../auth/access';
import { LedgerService } from '../wallet/ledger.service';
import { utcInstant } from './booking-input';
import { mentorCancellationDecision, mentorCancellationRequest, mentorCannotCancel } from './mentor-cancellation-policy';
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
export const MENTOR_CANCELLED_EVENT = 'MENTOR_CANCELLED';

function notFound(): never {
  throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Session not found.' });
}
const actor = (s: SessionRow) => s.status !== 'cancelled' ? null : s.cancellationActor === s.mentorId ? 'mentor' : 'mentee';

@Injectable()
export class MentorCancellationService {
  private readonly logger = new Logger(MentorCancellationService.name);

  constructor(private readonly pool: Pool, private readonly ledger: LedgerService) {}

  // `now` is a trusted test clock only; the controller never passes it.
  async cancel(user: AuthenticatedUser, sessionId: string, body: unknown, now?: Date) {
    const reason = mentorCancellationRequest(body);
    if (!uuid.test(sessionId)) notFound();
    const { rows: [owned] } = await this.pool.query<SessionRow>(`SELECT ${columns} FROM sessions WHERE id=$1`, [sessionId]);
    if (!owned) notFound();
    if (owned.mentorId !== user.id) denyAccess();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(owned, reason, now);
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = (error as { code?: string }).code;
        if (attempt < 3 && RETRYABLE.has(code ?? '')) continue;
        this.logger.error(`Mentor cancellation failed: ${code ?? (error as Error).message}`);
        throw new InternalServerErrorException({ code: 'CANCELLATION_FAILED',
          message: 'Cancellation could not be completed. Nothing was changed; please retry.' });
      }
    }
  }

  private async attempt(owned: SessionRow, reason: string | null, now?: Date) {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // Global lock order (US-11/US-12): mentee row, mentor profile row, session row.
      await this.ledger.lockMentee(tx, owned.menteeId);
      await tx.query('SELECT 1 FROM mentor_profiles WHERE mentor_id=$1 FOR UPDATE', [owned.mentorId]);
      const { rows: [session] } = await tx.query<SessionRow>(`SELECT ${columns} FROM sessions WHERE id=$1 FOR UPDATE`, [owned.id]);
      const { rows: [clock] } = await tx.query<{ now: Date }>('SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now', [now ?? null]);
      const decision = mentorCancellationDecision({ status: session.status, cancelledBy: actor(session) });
      if (decision.action === 'reject') mentorCannotCancel(decision.status, decision.cancelledBy);
      const result = decision.action === 'replay'
        ? await this.recorded(tx, session)
        : await this.apply(tx, session, reason, clock.now);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally { tx.release(); }
  }

  private async apply(tx: PoolClient, session: SessionRow, reason: string | null, now: Date) {
    const updated = await tx.query(`UPDATE sessions SET status='cancelled', cancelled_at=$2, cancellation_actor=$3
      WHERE id=$1 AND status IN ('scheduled','in_progress')`, [session.id, now, session.mentorId]);
    if (updated.rowCount !== 1) throw new Error('Locked session changed state');
    const refund = await refundAllocatedCredit(tx, this.ledger, { menteeId: session.menteeId, sessionId: session.id,
      kind: 'MENTOR_REFUND', idempotencyKey: 'mentor-refund:' + session.id, now,
      reason: 'Mentor cancelled the session; full refund.' + (reason ? ` Mentor reason: ${reason}` : '') });
    const eventKey = 'mentor-cancelled:' + session.id;
    // Same transaction as the status change and refund; processed_at stays NULL until US-15 delivers it.
    await tx.query(`INSERT INTO outbox_events (event_key, type, payload) VALUES ($1,$2,$3)`, [eventKey, MENTOR_CANCELLED_EVENT, {
      recipientId: session.menteeId, sessionId: session.id, mentorId: session.mentorId,
      startsAt: utcInstant(session.startsAt), cancelledAt: now.toISOString(), previousStatus: session.status,
      reason, refund: { credits: refund.credits, creditType: refund.creditType, lotId: refund.lotId } }]);
    return { sessionId: session.id, status: 'cancelled', cancelledAt: now.toISOString(), cancelledBy: 'mentor',
      previousStatus: session.status, alreadyCancelled: false,
      refund: { credits: refund.credits, creditType: refund.creditType, lotId: refund.lotId }, notification: { eventKey } };
  }

  private async recorded(tx: PoolClient, session: SessionRow) {
    const { rows: [refund] } = await tx.query<{ credits: number; lot_id: string | null; credit_type: string | null }>(`
      SELECT COALESCE(SUM(e.delta),0)::int AS credits, MIN(e.lot_id::text) AS lot_id, MIN(l.credit_type::text) AS credit_type
      FROM ledger_entries e JOIN credit_lots l ON l.id=e.lot_id
      WHERE e.session_id=$1 AND e.kind='MENTOR_REFUND'`, [session.id]);
    const { rows: [event] } = await tx.query<{ payload: { previousStatus: string } }>(
      'SELECT payload FROM outbox_events WHERE event_key=$1', ['mentor-cancelled:' + session.id]);
    return { sessionId: session.id, status: 'cancelled', cancelledAt: session.cancelledAt!.toISOString(), cancelledBy: 'mentor',
      previousStatus: event?.payload.previousStatus ?? null, alreadyCancelled: true,
      refund: { credits: refund.credits, creditType: refund.credit_type, lotId: refund.lot_id },
      notification: { eventKey: 'mentor-cancelled:' + session.id } };
  }
}
