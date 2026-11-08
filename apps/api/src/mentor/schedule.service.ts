import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { requireResourceAccess, type AuthenticatedUser } from '../auth/access';
import { blockoutInput, invalid, weeklyInput } from './schedule-input';

type Table = 'weekly_availability' | 'availability_blockouts';
const weeklyColumns = `id, mentor_id AS "mentorId", weekday,
  regexp_replace(start_local::text, '^([0-9]{2}:[0-9]{2}):00$', '\\1') AS "startLocal",
  regexp_replace(end_local::text, '^([0-9]{2}:[0-9]{2}):00$', '\\1') AS "endLocal",
  is_active AS "isActive", (SELECT timezone FROM users WHERE id=mentor_id) AS timezone`;
const blockoutColumns = `id, mentor_id AS "mentorId", reason,
  to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startsAt",
  to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "endsAt"`;

function missing(): never {
  throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND', message: 'Schedule resource not found.' });
}

@Injectable()
export class ScheduleService {
  constructor(private readonly pool: Pool) {}

  listWeekly(id: string) {
    return this.pool.query(`SELECT ${weeklyColumns} FROM weekly_availability
      WHERE mentor_id=$1 ORDER BY weekday,start_local,end_local,id`, [id]).then(result => result.rows);
  }

  listBlockouts(id: string) {
    return this.pool.query(`SELECT ${blockoutColumns} FROM availability_blockouts
      WHERE mentor_id=$1 ORDER BY starts_at,ends_at,id`, [id]).then(result => result.rows);
  }

  // US-11 takes this same profile row lock after locking the mentee.
  private async edit<T>(user: AuthenticatedUser, operation: (tx: PoolClient) => Promise<T>) {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const mentor = await tx.query('SELECT mentor_id FROM mentor_profiles WHERE mentor_id=$1 FOR UPDATE', [user.id]);
      if (!mentor.rowCount) missing();
      const result = await operation(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      if (['22007', '22008', '22009'].includes((error as {code:string}).code)) invalid('Invalid timestamp.');
      throw error;
    } finally { tx.release(); }
  }

  private async owned(tx: PoolClient, user: AuthenticatedUser, table: Table, id: string) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) missing();
    const { rows: [row] } = await tx.query(`SELECT ${table === 'weekly_availability' ? weeklyColumns : blockoutColumns}
      FROM ${table} WHERE id=$1`, [id]);
    if (!row) missing();
    requireResourceAccess(user, table === 'weekly_availability' ? 'editAvailability' : 'editBlockout', row.mentorId);
    return row;
  }

  saveWeekly(user: AuthenticatedUser, body: unknown, id?: string) {
    return this.edit(user, async tx => {
      const old = id && await this.owned(tx, user, 'weekly_availability', id);
      const input = weeklyInput(body, !!id);
      const args = [user.id, input.weekday ?? old?.weekday, input.startLocal ?? old?.startLocal,
        input.endLocal ?? old?.endLocal];
      const { rows: [check] } = await tx.query(`SELECT $3::time < $4::time AS valid, EXISTS (
        SELECT FROM weekly_availability WHERE mentor_id=$1 AND weekday=$2 AND is_active
        AND id IS DISTINCT FROM $5 AND start_local < $4 AND end_local > $3) AS overlap`, [...args, id]);
      if (!check.valid) invalid('startLocal must precede endLocal.');
      if ((old?.isActive ?? true) && check.overlap) invalid('Weekly rules overlap.');
      const result = id
        ? await tx.query(`UPDATE weekly_availability SET weekday=$2,start_local=$3,end_local=$4
          WHERE mentor_id=$1 AND id=$5 RETURNING ${weeklyColumns}`, [...args, id])
        : await tx.query(`INSERT INTO weekly_availability (mentor_id,weekday,start_local,end_local)
          VALUES ($1,$2,$3,$4) RETURNING ${weeklyColumns}`, args);
      return result.rows[0];
    });
  }

  saveBlockout(user: AuthenticatedUser, body: unknown, id?: string) {
    return this.edit(user, async tx => {
      const old = id && await this.owned(tx, user, 'availability_blockouts', id);
      const input = blockoutInput(body, !!id);
      const startsAt = input.startsAt ?? old?.startsAt;
      const endsAt = input.endsAt ?? old?.endsAt;
      const reason = input.reason === undefined ? old?.reason : input.reason;
      const args = [user.id, startsAt, endsAt];
      const { rows: [range] } = await tx.query('SELECT $1::timestamptz < $2::timestamptz AS valid', [startsAt, endsAt]);
      if (!range.valid) invalid('startsAt must precede endsAt.');
      const conflicts = await tx.query(`SELECT id FROM sessions WHERE mentor_id=$1 AND status <> 'cancelled'
        AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at,id`, args);
      if (conflicts.rowCount) throw new ConflictException({ code: 'BLOCKOUT_CONFLICT',
        message: 'Blockout overlaps booked sessions.', sessionIds: conflicts.rows.map(row => row.id) });
      const result = id
        ? await tx.query(`UPDATE availability_blockouts SET starts_at=$2,ends_at=$3,reason=$4
          WHERE mentor_id=$1 AND id=$5 RETURNING ${blockoutColumns}`, [...args, reason, id])
        : await tx.query(`INSERT INTO availability_blockouts (mentor_id,starts_at,ends_at,reason)
          VALUES ($1,$2,$3,$4) RETURNING ${blockoutColumns}`, [...args, reason]);
      return result.rows[0];
    });
  }

  remove(user: AuthenticatedUser, table: Table, id: string) {
    return this.edit(user, async tx => {
      await this.owned(tx, user, table, id);
      await tx.query(`DELETE FROM ${table} WHERE mentor_id=$1 AND id=$2`, [user.id, id]);
    });
  }
}
