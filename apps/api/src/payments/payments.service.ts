import { ConflictException, HttpException, Injectable, InternalServerErrorException, NotFoundException,
  Logger, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { LedgerService } from '../wallet/ledger.service';
import type { PaymentEvent } from './webhook';

interface Payment {
  id: string;
  mentee_id: string;
  status: 'PENDING' | 'SUCCEEDED' | 'REFUNDED';
  credits_purchased: number;
}

interface InboxRow {
  provider_payment_id: string;
  event_type: PaymentEvent['type'];
  processed_at: Date | null;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly pool: Pool, private readonly ledger: LedgerService) {}

  async purchase(menteeId: string, body: unknown) {
    if (!body || typeof body !== 'object' || !('packCredits' in body) ||
        body.packCredits !== 4 || Object.keys(body).length !== 1) {
      throw new UnprocessableEntityException({ code: 'INVALID_PURCHASE', message: 'Request a pack of 4 credits.' });
    }
    const result = await this.pool.query(`INSERT INTO payments (mentee_id, provider_payment_id, credits_purchased)
      VALUES ($1,$2,$3) RETURNING id AS "paymentId", provider_payment_id AS "providerPaymentId",
      status, credits_purchased AS "packCredits"`, [menteeId, 'fake_' + randomUUID(), body.packCredits]);
    return result.rows[0];
  }

  async receive(event: PaymentEvent, raw: Buffer) {
    // Commit a verified receipt before processing. A new process can resume from this row.
    const inserted = await this.pool.query(`INSERT INTO payment_events
      (provider_event_id, provider_payment_id, event_type, raw_payload)
      SELECT $1, provider_payment_id, $3, $4 FROM payments
      WHERE provider_payment_id=$2 AND ($5::numeric IS NULL OR credits_purchased=$5)
      ON CONFLICT (provider_event_id) DO NOTHING`,
      [event.eventId, event.paymentId, event.type, raw, event.packCredits]);
    if (!inserted.rowCount) {
      const existing = await this.pool.query<{ raw_payload: Buffer }>(
        'SELECT raw_payload FROM payment_events WHERE provider_event_id=$1', [event.eventId]);
      if (existing.rowCount) {
        if (!existing.rows[0].raw_payload.equals(raw)) {
          this.logger.warn(`Conflicting webhook identity: ${event.eventId}`);
          throw new ConflictException({ code: 'EVENT_ID_CONFLICT', message: 'Event ID already has a different payload.' });
        }
      } else {
        const order = await this.pool.query('SELECT 1 FROM payments WHERE provider_payment_id=$1', [event.paymentId]);
        if (!order.rowCount) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: 'Unknown provider payment.' });
        throw new UnprocessableEntityException({ code: 'PACK_MISMATCH', message: 'Credit quantity differs from the order.' });
      }
    }
    return this.processEvent(event.eventId);
  }

  async recoverPending() {
    const { rows } = await this.pool.query<{ provider_event_id: string }>(`SELECT provider_event_id
      FROM payment_events WHERE processed_at IS NULL ORDER BY processing_attempts, received_at, id LIMIT 100`);
    let failed = 0;
    for (const row of rows) {
      try {
        await this.processEvent(row.provider_event_id);
      } catch {
        this.logger.error(`Webhook recovery failed: ${row.provider_event_id}`);
        failed++;
      }
    }
    return { examined: rows.length, failed };
  }

  private async processEvent(eventId: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.reconcile(eventId);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (attempt < 3 && (code === '40001' || code === '40P01')) continue;
        // Another request may already have recovered the event since our rollback.
        await this.pool.query(`UPDATE payment_events SET processing_attempts=processing_attempts+1,
          processing_error='PAYMENT_PROCESSING_FAILED' WHERE provider_event_id=$1 AND processed_at IS NULL`, [eventId]);
        if (error instanceof HttpException) throw error;
        throw new InternalServerErrorException({ code: 'PAYMENT_PROCESSING_FAILED', message: 'Processing failed; retry the event.' });
      }
    }
  }

  private async reconcile(eventId: string) {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      const inbox = await tx.query<InboxRow>(`SELECT provider_payment_id, event_type, processed_at
        FROM payment_events WHERE provider_event_id=$1 FOR UPDATE`, [eventId]);
      const event = inbox.rows[0];
      const result = await tx.query<Payment>(`SELECT id, mentee_id, credits_purchased, status
        FROM payments WHERE provider_payment_id=$1 FOR UPDATE`, [event.provider_payment_id]);
      const payment = result.rows[0];
      const previous = payment.status;
      if (!event.processed_at) {
        if (event.event_type === 'payment.refunded') {
          if (previous === 'SUCCEEDED') await this.reverseGrant(tx, payment);
          payment.status = 'REFUNDED';
        } else if (previous === 'PENDING') {
          // A verified refund may already be durable while its processor is offline.
          const refund = await tx.query(`SELECT 1 FROM payment_events
            WHERE provider_payment_id=$1 AND event_type='payment.refunded' LIMIT 1`, [event.provider_payment_id]);
          if (refund.rowCount) {
            payment.status = 'REFUNDED';
          } else {
            await this.grant(tx, payment);
            payment.status = 'SUCCEEDED';
          }
        }
        if (previous !== payment.status) {
          await tx.query('UPDATE payments SET status=$2 WHERE id=$1', [payment.id, payment.status]);
        }
        await tx.query(`UPDATE payment_events SET processed_at=clock_timestamp(), processing_error=NULL,
          processing_attempts=processing_attempts+1 WHERE provider_event_id=$1`, [eventId]);
      }
      await tx.query('COMMIT');
      return { status: payment.status, duplicate: previous === payment.status };
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }

  private async grant(tx: PoolClient, payment: Payment) {
    await this.ledger.lockMentee(tx, payment.mentee_id);
    const lot = await tx.query<{ id: string }>(`INSERT INTO credit_lots
      (mentee_id, credit_type, original_quantity, payment_id) VALUES ($1,'NORMAL',$2,$3) RETURNING id`,
      [payment.mentee_id, payment.credits_purchased, payment.id]);
    await this.ledger.appendEntry(tx, { menteeId: payment.mentee_id, lotId: lot.rows[0].id,
      paymentId: payment.id, kind: 'PURCHASE_GRANT', delta: payment.credits_purchased,
      idempotencyKey: 'purchase-grant:' + payment.id });
  }

  private async reverseGrant(tx: PoolClient, payment: Payment) {
    await this.ledger.lockMentee(tx, payment.mentee_id);
    // Locate the actual immutable grant, including payments confirmed before the inbox existed.
    const { rows } = await tx.query<{ lot_id: string; delta: number; remaining: string }>(`
      SELECT g.lot_id, g.delta, (SELECT SUM(delta) FROM ledger_entries WHERE lot_id=g.lot_id) AS remaining
      FROM ledger_entries g WHERE g.idempotency_key=$1 AND g.payment_id=$2 AND g.kind='PURCHASE_GRANT'`,
      ['purchase-grant:' + payment.id, payment.id]);
    const grant = rows[0];
    if (!grant || grant.delta !== payment.credits_purchased) throw Error('Inconsistent purchase grant');
    const unspent = Math.max(0, Math.min(grant.delta, Number(grant.remaining)));
    const spent = grant.delta - unspent;
    const source = { menteeId: payment.mentee_id, lotId: grant.lot_id, paymentId: payment.id };
    if (unspent) await this.ledger.appendEntry(tx, { ...source, kind: 'PAYMENT_REVERSAL', delta: -unspent,
      idempotencyKey: 'purchase-reversal:' + payment.id });
    if (spent) await this.ledger.appendEntry(tx, { ...source, kind: 'DEBT', delta: -spent,
      idempotencyKey: 'purchase-debt:' + payment.id });
  }
}
