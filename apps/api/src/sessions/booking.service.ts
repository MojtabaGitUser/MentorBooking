import { HttpException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { isOfferedStart } from '../mentor/slots';
import { LedgerService } from '../wallet/ledger.service';
import { RolloverService } from '../wallet/rollover.service';
import { assertAligned, bookingRequest, exclusionConflict, idempotencyConflict, insufficientCredits,
  mentorNotFound, sessionOverlap, slotUnavailable, utcInstant, type BookingRequest } from './booking-input';

export interface BookingResult {
  sessionId: string;
  mentorId: string;
  status: string;
  spentCreditType: 'NORMAL' | 'ROLLOVER';
  startsAt: string;
  endsAt: string;
}

interface SessionRow {
  id: string;
  mentor_id: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  credit_type: 'NORMAL' | 'ROLLOVER';
}

const RETRYABLE = new Set(['40001', '40P01']);

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(private readonly pool: Pool, private readonly ledger: LedgerService,
              private readonly rollover: RolloverService) {}

  // `now` is a trusted test clock only; the controller never passes it.
  async book(menteeId: string, body: unknown, key: unknown, now?: Date) {
    const request = bookingRequest(body, key);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(menteeId, request, now);
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = (error as { code?: string }).code;
        // A unique-key race on booking_requests can only follow a winner's commit: retry to replay it.
        const replayRace = code === '23505' && (error as { constraint?: string }).constraint === 'booking_requests_pkey';
        if (attempt < 3 && (RETRYABLE.has(code ?? '') || replayRace)) continue;
        this.logger.error(`Booking failed: ${code ?? (error as Error).message}`);
        throw new InternalServerErrorException({ code: 'BOOKING_FAILED', message: 'Booking could not be completed. Please retry.' });
      }
    }
  }

  private async attempt(menteeId: string, request: BookingRequest, now?: Date) {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await this.inTransaction(tx, menteeId, request, now);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      const mapped = exclusionConflict(error);
      if (mapped) mapped();
      throw error;
    } finally { tx.release(); }
  }

  private async inTransaction(tx: PoolClient, menteeId: string, request: BookingRequest, now?: Date) {
    // Lock order (design.md): mentee row first, mentor profile second. Every path that spends
    // credit locks the mentee; every schedule edit locks the mentor profile.
    await this.ledger.lockMentee(tx, menteeId);

    if (request.idempotencyKey) {
      const prior = await this.replay(tx, menteeId, request);
      if (prior) return { replayed: true, booking: prior };
    }

    const { rows: [mentor] } = await tx.query<{ timezone: string }>(`SELECT u.timezone FROM mentor_profiles p
      JOIN users u ON u.id=p.mentor_id WHERE p.mentor_id=$1 FOR UPDATE OF p`, [request.mentorId]);
    if (!mentor) mentorNotFound();
    assertAligned(request.startsAt, mentor.timezone);

    // The authoritative clock is read after both locks are held.
    const { rows: [clock] } = await tx.query<{ now: Date }>(
      'SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now', [now ?? null]);
    const startsAt = request.startsAt.toISOString();
    const { rows: [state] } = await tx.query<{ future: boolean; blocked: boolean; booked: boolean; overlap: boolean }>(`
      SELECT $2::timestamptz > $3::timestamptz AS future,
        EXISTS (SELECT FROM availability_blockouts WHERE mentor_id=$1
          AND starts_at < $2::timestamptz + interval '30 minutes' AND ends_at > $2::timestamptz) AS blocked,
        EXISTS (SELECT FROM sessions WHERE mentor_id=$1 AND status <> 'cancelled'
          AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $2::timestamptz + interval '30 minutes', '[)')) AS booked,
        EXISTS (SELECT FROM sessions WHERE mentee_id=$4 AND status <> 'cancelled'
          AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $2::timestamptz + interval '30 minutes', '[)')) AS overlap`,
    [request.mentorId, startsAt, clock.now, menteeId]);
    if (!state.future) slotUnavailable('IN_PAST');

    const rules = await tx.query<{ weekday: number; startMicros: number; endMicros: number }>(`SELECT weekday,
      (extract(epoch FROM start_local)*1000000)::float8 AS "startMicros",
      (extract(epoch FROM end_local)*1000000)::float8 AS "endMicros"
      FROM weekly_availability WHERE mentor_id=$1 AND is_active`, [request.mentorId]);
    if (!isOfferedStart(request.startsAt.getTime(), mentor.timezone, rules.rows)) slotUnavailable('OUTSIDE_AVAILABILITY');
    if (state.blocked) slotUnavailable('BLOCKED');
    if (state.booked) slotUnavailable('BOOKED');
    if (state.overlap) sessionOverlap();

    // US-10 policy under the held mentee lock: rollover by earliest expiry, then normal; debt counts.
    const lot = await this.rollover.selectSpendableLot(tx, menteeId, clock.now);
    if (!lot) insufficientCredits();

    const { rows: [session] } = await tx.query<{ id: string }>(`INSERT INTO sessions (mentor_id, mentee_id, starts_at, ends_at)
      VALUES ($1,$2,$3::timestamptz,$3::timestamptz + interval '30 minutes') RETURNING id`,
    [request.mentorId, menteeId, startsAt]);
    await tx.query('INSERT INTO session_credit_allocations (session_id, lot_id, mentee_id) VALUES ($1,$2,$3)',
      [session.id, lot.lotId, menteeId]);
    await this.ledger.appendEntry(tx, { menteeId, lotId: lot.lotId, sessionId: session.id,
      kind: 'BOOKING_DEBIT', delta: -1, idempotencyKey: 'booking-debit:' + session.id });
    if (request.idempotencyKey) {
      await tx.query('INSERT INTO booking_requests (mentee_id, idempotency_key, session_id) VALUES ($1,$2,$3)',
        [menteeId, request.idempotencyKey, session.id]);
    }
    return { replayed: false, booking: await this.load(tx, session.id) };
  }

  private async replay(tx: PoolClient, menteeId: string, request: BookingRequest) {
    const { rows: [prior] } = await tx.query<{ session_id: string }>(
      'SELECT session_id FROM booking_requests WHERE mentee_id=$1 AND idempotency_key=$2',
      [menteeId, request.idempotencyKey]);
    if (!prior) return null;
    const booking = await this.load(tx, prior.session_id);
    if (booking.mentorId !== request.mentorId || booking.startsAt !== utcInstant(request.startsAt)) idempotencyConflict();
    return booking;
  }

  private async load(tx: PoolClient, sessionId: string): Promise<BookingResult> {
    const { rows: [row] } = await tx.query<SessionRow>(`SELECT s.id, s.mentor_id, s.starts_at, s.ends_at, s.status, l.credit_type
      FROM sessions s JOIN session_credit_allocations a ON a.session_id=s.id JOIN credit_lots l ON l.id=a.lot_id
      WHERE s.id=$1`, [sessionId]);
    return { sessionId: row.id, mentorId: row.mentor_id, status: row.status, spentCreditType: row.credit_type,
      startsAt: utcInstant(row.starts_at)!, endsAt: utcInstant(row.ends_at)! };
  }
}
