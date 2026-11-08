-- US-11 booking idempotency. A row exists only for a committed booking: it is inserted in the
-- same transaction as the session, allocation and debit, so a failed attempt leaves no key behind.
-- Keys are scoped per mentee. The request fingerprint (mentor and start) is the referenced session.
CREATE TABLE booking_requests (
  mentee_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[!-~]{1,128}$'),
  session_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mentee_id, idempotency_key),
  FOREIGN KEY (session_id, mentee_id) REFERENCES sessions (id, mentee_id)
);

GRANT SELECT, INSERT ON booking_requests TO mentor_app;
