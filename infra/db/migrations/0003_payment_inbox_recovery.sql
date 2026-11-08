ALTER TABLE payment_events
  ADD COLUMN processing_attempts integer NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0);
CREATE INDEX payment_events_pending ON payment_events (processing_attempts, received_at, id)
  WHERE processed_at IS NULL;

-- Runtime can update processing metadata, but the signed identity and bytes are immutable.
REVOKE UPDATE ON payment_events FROM mentor_app;
GRANT UPDATE (processed_at, processing_error, processing_attempts) ON payment_events TO mentor_app;
