import { Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { candidateStarts, displaySlot, slotQuery } from './slots';

@Injectable()
export class SlotsService {
  constructor(private readonly pool: Pool) {}

  async list(mentorId: string, query: Record<string, unknown>, savedZone: string) {
    const range = slotQuery(query, savedZone);
    const missing = () => new NotFoundException({ code: 'MENTOR_NOT_FOUND', message: 'Mentor not found.' });
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(mentorId)) throw missing();
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows: [mentor] } = await tx.query(`SELECT timezone FROM mentor_profiles
        JOIN users ON users.id=mentor_profiles.mentor_id WHERE mentor_id=$1`, [mentorId]);
      if (!mentor) throw missing();
      const rules = await tx.query<{weekday:number; startMicros:number; endMicros:number}>(`SELECT weekday,
        (extract(epoch FROM start_local)*1000000)::float8 AS "startMicros",
        (extract(epoch FROM end_local)*1000000)::float8 AS "endMicros"
        FROM weekly_availability WHERE mentor_id=$1 AND is_active`, [mentorId]);
      const candidates = candidateStarts(range, mentor.timezone, rules.rows);
      const { rows } = await tx.query(`SELECT start FROM unnest($2::timestamptz[]) AS slot(start)
        WHERE start > CURRENT_TIMESTAMP
        AND NOT EXISTS (SELECT FROM availability_blockouts WHERE mentor_id=$1
          AND starts_at < start + interval '30 minutes' AND ends_at > start)
        AND NOT EXISTS (SELECT FROM sessions WHERE mentor_id=$1 AND status <> 'cancelled'
          AND tstzrange(starts_at, ends_at, '[)') && tstzrange(start, start + interval '30 minutes', '[)'))
        ORDER BY start`, [mentorId, candidates.map(ms => new Date(ms).toISOString())]);
      await tx.query('COMMIT');
      return { mentorTimezone: mentor.timezone, viewerTimezone: range.viewerTimezone,
        slots: rows.map(row => displaySlot(row.start, range.viewerTimezone)) };
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally { tx.release(); }
  }
}
