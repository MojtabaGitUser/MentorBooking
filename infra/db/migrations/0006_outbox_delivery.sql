-- US-15 outbox delivery. Additive only: existing pending rows stay pending and become due at once.
-- available_at: earliest next attempt (backoff after a failure).
-- outcome: why a row left the queue; set exactly when processed_at is set.
ALTER TABLE outbox_events
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_error text,
  ADD COLUMN outcome text CHECK (outcome IN ('DELIVERED', 'SUPPRESSED', 'FAILED')),
  ADD CONSTRAINT outbox_outcome_when_processed CHECK ((outcome IS NULL) = (processed_at IS NULL));
CREATE INDEX outbox_due ON outbox_events (available_at, id) WHERE processed_at IS NULL;

-- The simulated notification channel: one durable, append-only record per delivered event.
-- Both unique keys make a recorded delivery exactly-once even if two workers race or a retry follows a crash.
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_event_id uuid NOT NULL UNIQUE REFERENCES outbox_events,
  event_key text NOT NULL UNIQUE,
  recipient_id uuid NOT NULL REFERENCES users,
  channel text NOT NULL DEFAULT 'log',
  type text NOT NULL,
  payload jsonb NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON notification_deliveries TO mentor_app;
