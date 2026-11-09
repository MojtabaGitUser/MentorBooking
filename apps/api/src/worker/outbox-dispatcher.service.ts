import { Injectable, Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { MENTOR_CANCELLED_EVENT } from '../sessions/mentor-cancellation.service';
import { NotificationSink, type OutboxEvent } from './notification-sink';
import { REMINDER_EVENT } from './reminder.service';

export const MAX_DELIVERY_ATTEMPTS = 8;
// Exponential backoff after a failed attempt: 5s, 10s, 20s ... capped at 5 minutes.
export function retryDelayMs(attempts: number) {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

type Result = 'delivered' | 'suppressed' | 'failed' | 'empty';

@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(private readonly pool: Pool, private readonly sink: NotificationSink) {}

  // Processes up to `limit` due events, each in its own short transaction, so one bad event never
  // blocks or rolls back the others. Concurrent workers claim disjoint rows (SKIP LOCKED).
  async dispatch(options: { now?: Date; limit?: number } = {}) {
    const totals = { delivered: 0, suppressed: 0, failed: 0 };
    for (let i = 0; i < (options.limit ?? 100); i++) {
      const result = await this.processOne(options.now);
      if (result === 'empty') break;
      totals[result]++;
    }
    return totals;
  }

  private async processOne(now?: Date): Promise<Result> {
    const tx = await this.pool.connect();
    let claimed: OutboxEvent | undefined;
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const { rows: [clock] } = await tx.query<{ now: Date }>('SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now', [now ?? null]);
      // A crash anywhere below aborts this transaction and releases the row lock: the event stays
      // pending (processed_at NULL) and the next tick claims it again. Nothing is ever stuck "claimed".
      ({ rows: [claimed] } = await tx.query<OutboxEvent>(`SELECT id, event_key AS "eventKey", type, payload, attempts
        FROM outbox_events WHERE processed_at IS NULL AND available_at <= $1
        ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [clock.now]));
      if (!claimed) { await tx.query('COMMIT'); return 'empty'; }
      const outcome = await this.handle(tx, claimed, clock.now);
      await tx.query(`UPDATE outbox_events SET processed_at=$2, outcome=$3, attempts=attempts+1, last_error=NULL WHERE id=$1`,
        [claimed.id, clock.now, outcome]);
      await tx.query('COMMIT');
      return outcome === 'DELIVERED' ? 'delivered' : 'suppressed';
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      if (!claimed) throw error;
      await this.recordFailure(claimed, error as Error, now);
      return 'failed';
    } finally { tx.release(); }
  }

  private async handle(tx: PoolClient, event: OutboxEvent, now: Date): Promise<'DELIVERED' | 'SUPPRESSED'> {
    if (event.type === REMINDER_EVENT) {
      // A reminder queued before a cancellation (or one found after the start) is stale: drop it.
      const { rows: [session] } = await tx.query<{ status: string; startsAt: Date }>(
        'SELECT status, starts_at AS "startsAt" FROM sessions WHERE id=$1 FOR SHARE', [event.payload.sessionId]);
      if (!session || session.status !== 'scheduled' || session.startsAt.getTime() <= now.getTime()) return 'SUPPRESSED';
    } else if (event.type !== MENTOR_CANCELLED_EVENT) {
      throw new Error(`Unsupported outbox event type ${event.type}`);
    }
    await this.sink.deliver(tx, event);
    return 'DELIVERED';
  }

  // Runs after the rollback, so nothing from the failed attempt survives. Bounded retries with
  // backoff; after MAX_DELIVERY_ATTEMPTS the row is parked as FAILED (visible, never silently lost).
  private async recordFailure(event: OutboxEvent, error: Error, now?: Date) {
    const attempts = event.attempts + 1;
    const final = attempts >= MAX_DELIVERY_ATTEMPTS;
    const message = error.message.slice(0, 500);
    await this.pool.query(`UPDATE outbox_events SET attempts=attempts+1, last_error=$2,
        available_at=COALESCE($4::timestamptz, clock_timestamp()) + $3::interval,
        processed_at=CASE WHEN $5 THEN COALESCE($4::timestamptz, clock_timestamp()) END,
        outcome=CASE WHEN $5 THEN 'FAILED' END
      WHERE id=$1 AND processed_at IS NULL`,
    [event.id, message, `${retryDelayMs(attempts) / 1000} seconds`, now ?? null, final]);
    if (final) this.logger.error(`Outbox ${event.eventKey} failed permanently after ${attempts} attempts: ${message}`);
    else this.logger.warn(`Outbox ${event.eventKey} attempt ${attempts} failed, retry in ${retryDelayMs(attempts) / 1000}s: ${message}`);
  }
}
