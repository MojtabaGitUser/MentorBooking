import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

export interface OutboxEvent {
  id: string;
  eventKey: string;
  type: string;
  payload: Record<string, unknown> & { recipientId?: string };
  attempts: number;
}

// The assignment's notification channel is a log. Delivery = one row in notification_deliveries
// (unique per event) plus a log line, written in the caller's transaction. Because the record and the
// outbox "processed" marker commit together, a recorded delivery happens exactly once. A real provider
// would be called here with eventKey as its idempotency key and would be at-least-once.
@Injectable()
export class NotificationSink {
  private readonly logger = new Logger('Notifications');

  async deliver(tx: PoolClient, event: OutboxEvent) {
    const recipientId = event.payload.recipientId;
    if (typeof recipientId !== 'string') throw new Error(`Event ${event.eventKey} has no recipient`);
    await tx.query(`INSERT INTO notification_deliveries (outbox_event_id, event_key, recipient_id, channel, type, payload)
      VALUES ($1,$2,$3,'log',$4,$5)`, [event.id, event.eventKey, recipientId, event.type, event.payload]);
    // Identifiers only; no names, contact details or payment data are logged.
    this.logger.log(`Delivered ${event.type} ${event.eventKey} to user ${recipientId}`);
  }
}
