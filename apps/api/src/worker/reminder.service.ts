import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

export const REMINDER_EVENT = 'SESSION_REMINDER';
export const REMINDER_LEAD = '1 hour'; // 60 elapsed minutes on UTC instants, so DST changes are irrelevant
export const reminderKey = (sessionId: string) => `reminder:${sessionId}:T-1h`;

@Injectable()
export class ReminderService {
  constructor(private readonly pool: Pool) {}

  // Queues one reminder for each still-scheduled session that starts within the next hour.
  // Due at starts_at - 1h; a session booked later than that (or missed while the worker was down)
  // is reminded on the next tick, as long as it has not started.
  // FOR SHARE SKIP LOCKED: a session held by an in-flight cancellation or join is skipped this tick
  // and re-evaluated against its committed state next tick, so a cancelled session is never queued.
  // The unique event_key makes concurrent or repeated ticks harmless.
  async queueDue(options: { now?: Date; limit?: number } = {}) {
    const { rows } = await this.pool.query<{ event_key: string }>(`
      WITH clock AS (SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now),
      due AS (
        SELECT s.id, s.mentee_id, s.mentor_id, s.starts_at, s.ends_at FROM sessions s, clock
        WHERE s.status='scheduled' AND s.starts_at > clock.now AND s.starts_at - $3::interval <= clock.now
          AND NOT EXISTS (SELECT FROM outbox_events o WHERE o.event_key='reminder:'||s.id||':T-1h')
        ORDER BY s.starts_at, s.id LIMIT $2
        FOR SHARE OF s SKIP LOCKED)
      INSERT INTO outbox_events (event_key, type, payload)
      SELECT 'reminder:'||id||':T-1h', $4, jsonb_build_object('recipientId', mentee_id, 'sessionId', id,
        'mentorId', mentor_id,
        'startsAt', to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'endsAt', to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'remindAt', to_char((starts_at - $3::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      FROM due
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_key`, [options.now ?? null, options.limit ?? 100, REMINDER_LEAD, REMINDER_EVENT]);
    return { queued: rows.length };
  }
}
