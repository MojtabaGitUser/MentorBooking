import { ConflictException, HttpException, Injectable, InternalServerErrorException, NotFoundException,
  NotImplementedException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { LedgerService } from '../wallet/ledger.service';
import type { PaymentEvent } from './webhook';

interface Payment {
  id: string;
  mentee_id: string;
  status: 'PENDING' | 'SUCCEEDED' | 'REFUNDED';
  credits_purchased: number;
}

@Injectable()
export class PaymentsService {
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

  async receive(event: PaymentEvent) {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      const { rows } = await tx.query<Payment>(`SELECT id, mentee_id, credits_purchased, status
        FROM payments WHERE provider_payment_id=$1 FOR UPDATE`, [event.paymentId]);
      const payment = rows[0];
      if (!payment) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: 'Unknown provider payment.' });
      if (event.packCredits !== undefined && event.packCredits !== payment.credits_purchased) {
        throw new UnprocessableEntityException({ code: 'PACK_MISMATCH', message: 'Credit quantity differs from the order.' });
      }
      if (event.type === 'payment.refunded') {
        throw new NotImplementedException({ code: 'REFUND_NOT_PROCESSED', message: 'Refund reconciliation is unavailable.' });
      }
      if (payment.status === 'REFUNDED') {
        throw new ConflictException({ code: 'PAYMENT_REFUNDED', message: 'Payment is already refunded.' });
      }
      const duplicate = payment.status === 'SUCCEEDED';
      if (!duplicate) {
        await this.ledger.lockMentee(tx, payment.mentee_id);
        const lot = await tx.query<{ id: string }>(`INSERT INTO credit_lots
          (mentee_id, credit_type, original_quantity, payment_id) VALUES ($1,'NORMAL',$2,$3) RETURNING id`,
          [payment.mentee_id, payment.credits_purchased, payment.id]);
        await this.ledger.appendEntry(tx, { menteeId: payment.mentee_id, lotId: lot.rows[0].id,
          paymentId: payment.id, kind: 'PURCHASE_GRANT', delta: payment.credits_purchased,
          idempotencyKey: 'purchase-grant:' + payment.id });
        await tx.query("UPDATE payments SET status='SUCCEEDED' WHERE id=$1", [payment.id]);
      }
      await tx.query('COMMIT');
      return { status: 'SUCCEEDED', duplicate };
    } catch (error) {
      await tx.query('ROLLBACK');
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({ code: 'PAYMENT_PROCESSING_FAILED', message: 'Could not process payment.' });
    } finally { tx.release(); }
  }
}
