import { HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { denyAccess, type AuthenticatedUser } from '../auth/access';
import { LedgerService } from '../wallet/ledger.service';
import { canTransition, classifyAttendance, joinDecision, rolloverExpiresAt, RESOLUTION_GRACE_MS, type Outcome } from './lifecycle-policy';

interface SessionRow {
  id: string;
  menteeId: string;
  mentorId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  joinedMentorAt: Date | null;
  joinedMenteeAt: Date | null;
}

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const columns = `id, mentee_id AS "menteeId", mentor_id AS "mentorId", status, starts_at AS "startsAt", ends_at AS "endsAt",
  joined_mentor_at AS "joinedMentorAt", joined_mentee_at AS "joinedMenteeAt"`;
const RETRYABLE = new Set(['40001', '40P01']);

function notFound(): never {
  throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Session not found.' });
}

// Lifecycle transitions for the US-15 worker and the join endpoint. `now` is a trusted clock for
// tests and the worker; HTTP callers never supply it. No client route can start or resolve a session.
@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(private readonly pool: Pool, private readonly ledger: LedgerService) {}

  async join(user: AuthenticatedUser, sessionId: string, now?: Date) {
    if (!uuid.test(sessionId)) notFound();
    return this.retrying('Join', async tx => {
      // Join changes no credit, so it takes only the session row lock and never waits for another
      // lock while holding it; this cannot deadlock with cancellation (mentee, mentor, session).
      const { rows: [session] } = await tx.query<SessionRow>(`SELECT ${columns} FROM sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
      if (!session) notFound();
      const role = session.mentorId === user.id ? 'mentor' : session.menteeId === user.id ? 'mentee' : null;
      if (!role || role !== user.role) denyAccess();
      const clock = await this.clock(tx, now);
      if (joinDecision(session, clock) === 'record_and_start') await this.markStarted(tx, session.id);
      const column = role === 'mentor' ? 'joined_mentor_at' : 'joined_mentee_at';
      const previous = role === 'mentor' ? session.joinedMentorAt : session.joinedMenteeAt;
      // The first valid join is kept; retries never move it.
      const { rows: [row] } = await tx.query<{ status: string; joinedAt: Date }>(`UPDATE sessions SET ${column}=COALESCE(${column},$2)
        WHERE id=$1 RETURNING status, ${column} AS "joinedAt"`, [session.id, clock]);
      return { sessionId: session.id, role, status: row.status, joinedAt: row.joinedAt.toISOString(),
        alreadyJoined: previous !== null, startsAt: session.startsAt.toISOString(), endsAt: session.endsAt.toISOString() };
    });
  }

  // scheduled -> in_progress for sessions whose official start has passed. One statement; rows held
  // by a cancellation or another worker are skipped and picked up on the next tick.
  async startDue(options: { now?: Date; limit?: number } = {}) {
    const { rows } = await this.pool.query<{ id: string }>(`UPDATE sessions SET status='in_progress'
      WHERE id IN (SELECT id FROM sessions WHERE status='scheduled' AND starts_at <= COALESCE($1::timestamptz, clock_timestamp())
        ORDER BY starts_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
      AND status='scheduled' RETURNING id`, [options.now ?? null, options.limit ?? 100]);
    return { started: rows.map(row => row.id) };
  }

  // Resolve every session whose end + grace has passed. Candidates are read without locks; each is then
  // resolved in its own transaction that rechecks everything under the locks.
  async resolveDue(options: { now?: Date; limit?: number } = {}) {
    const { rows } = await this.pool.query<{ id: string }>(`SELECT id FROM sessions
      WHERE status IN ('scheduled','in_progress') AND ends_at + $3::interval <= COALESCE($1::timestamptz, clock_timestamp())
      ORDER BY ends_at, id LIMIT $2`, [options.now ?? null, options.limit ?? 100, `${RESOLUTION_GRACE_MS / 1000} seconds`]);
    const resolved: { sessionId: string; outcome: Outcome }[] = [];
    for (const { id } of rows) {
      const result = await this.resolveSession(id, options.now);
      if (result) resolved.push(result);
    }
    return { resolved };
  }

  // Returns null if the session is not (or no longer) due, e.g. cancelled or resolved by another worker.
  async resolveSession(sessionId: string, now?: Date): Promise<{ sessionId: string; outcome: Outcome } | null> {
    const { rows: [owner] } = await this.pool.query<{ menteeId: string }>('SELECT mentee_id AS "menteeId" FROM sessions WHERE id=$1', [sessionId]);
    if (!owner) return null;
    return this.retrying('Resolution', async tx => {
      // A mentor no-show grants credit, so take the shared order: mentee lock, then the session row.
      await this.ledger.lockMentee(tx, owner.menteeId);
      const { rows: [session] } = await tx.query<SessionRow>(`SELECT ${columns} FROM sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
      const clock = await this.clock(tx, now);
      if (!['scheduled', 'in_progress'].includes(session.status)) return null;
      if (clock.getTime() < session.endsAt.getTime() + RESOLUTION_GRACE_MS) return null;
      const outcome = classifyAttendance(session);
      if (!canTransition(session.status, outcome)) return null;
      const updated = await tx.query(`UPDATE sessions SET status=$2::text::session_status,
        completed_at=CASE WHEN $2::text='completed' THEN $3::timestamptz END
        WHERE id=$1 AND status IN ('scheduled','in_progress')`, [session.id, outcome, clock]);
      if (updated.rowCount !== 1) throw new Error('Locked session changed state');
      if (outcome === 'no_show_mentor') await this.grantNoShowRollover(tx, session, clock);
      return { sessionId: session.id, outcome };
    });
  }

  // One new ROLLOVER lot (not a refund of the booking lot) expiring exactly 30 days after the award.
  private async grantNoShowRollover(tx: PoolClient, session: SessionRow, awardedAt: Date) {
    const { rows: [lot] } = await tx.query<{ id: string }>(`INSERT INTO credit_lots
      (mentee_id, credit_type, original_quantity, session_id, expires_at) VALUES ($1,'ROLLOVER',1,$2,$3) RETURNING id`,
    [session.menteeId, session.id, rolloverExpiresAt(awardedAt)]);
    await this.ledger.appendEntry(tx, { menteeId: session.menteeId, lotId: lot.id, sessionId: session.id,
      kind: 'NO_SHOW_ROLLOVER', delta: 1, idempotencyKey: 'mentor-no-show:' + session.id,
      reason: 'Mentor did not attend; rollover credit valid for 30 days.' });
  }

  private async markStarted(tx: PoolClient, sessionId: string) {
    await tx.query("UPDATE sessions SET status='in_progress' WHERE id=$1 AND status='scheduled'", [sessionId]);
  }

  private async clock(tx: PoolClient, now?: Date) {
    const { rows: [row] } = await tx.query<{ now: Date }>('SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now', [now ?? null]);
    return row.now;
  }

  private async retrying<T>(label: string, work: (tx: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(work);
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = (error as { code?: string }).code;
        if (attempt < 3 && RETRYABLE.has(code ?? '')) continue;
        this.logger.error(`${label} failed: ${code ?? (error as Error).message}`);
        throw new InternalServerErrorException({ code: 'SESSION_UPDATE_FAILED', message: 'The session could not be updated. Nothing was changed; please retry.' });
      }
    }
  }

  private async attempt<T>(work: (tx: PoolClient) => Promise<T>) {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally { tx.release(); }
  }
}
