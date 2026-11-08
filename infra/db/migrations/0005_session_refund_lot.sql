-- US-12: a NORMAL lot that originates from a session is a refund lot, issued when the credit
-- allocated to that session came from a rollover lot that has since expired. Mentee and mentor
-- cancellation are mutually exclusive terminal outcomes, so a session can fund at most one.
-- Rollover lots (no-show credits) keep their existing semantics and are unaffected.
CREATE UNIQUE INDEX credit_lots_one_refund_lot_per_session
  ON credit_lots (session_id) WHERE credit_type = 'NORMAL' AND session_id IS NOT NULL;
