CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE user_role AS ENUM ('mentor', 'mentee', 'admin');
CREATE TYPE session_status AS ENUM
  ('scheduled', 'in_progress', 'completed', 'no_show_mentee', 'no_show_mentor', 'cancelled');
CREATE TYPE credit_type AS ENUM ('NORMAL', 'ROLLOVER');
CREATE TYPE payment_status AS ENUM ('PENDING', 'SUCCEEDED', 'REFUNDED');
CREATE TYPE ledger_kind AS ENUM
  ('PURCHASE_GRANT', 'BOOKING_DEBIT', 'CANCELLATION_REFUND', 'MENTOR_REFUND',
   'NO_SHOW_ROLLOVER', 'ROLLOVER_EXPIRE', 'ADMIN_GRANT', 'ADMIN_REVOKE', 'PAYMENT_REVERSAL', 'DEBT');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role user_role NOT NULL,
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  timezone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, role)
);

CREATE FUNCTION validate_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown timezone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_timezone BEFORE INSERT OR UPDATE OF timezone ON users
  FOR EACH ROW EXECUTE FUNCTION validate_timezone();

CREATE TABLE mentor_profiles (
  mentor_id uuid PRIMARY KEY,
  role user_role GENERATED ALWAYS AS ('mentor'::user_role) STORED,
  bio text NOT NULL DEFAULT '',
  FOREIGN KEY (mentor_id, role) REFERENCES users (id, role)
);

CREATE TABLE weekly_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_id uuid NOT NULL REFERENCES mentor_profiles,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_local time NOT NULL,
  end_local time NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  CHECK (start_local < end_local)
);
CREATE INDEX weekly_mentor_day ON weekly_availability (mentor_id, weekday) WHERE is_active;

CREATE TABLE availability_blockouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_id uuid NOT NULL REFERENCES mentor_profiles,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  CHECK (starts_at < ends_at)
);
CREATE INDEX blockouts_mentor_start ON availability_blockouts (mentor_id, starts_at);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_id uuid NOT NULL REFERENCES mentor_profiles,
  mentee_id uuid NOT NULL,
  mentee_role user_role GENERATED ALWAYS AS ('mentee'::user_role) STORED,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status session_status NOT NULL DEFAULT 'scheduled',
  cancellation_actor uuid REFERENCES users,
  cancelled_at timestamptz,
  joined_mentor_at timestamptz,
  joined_mentee_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mentee_id, mentee_role) REFERENCES users (id, role),
  UNIQUE (id, mentee_id),
  CHECK (ends_at > starts_at AND ends_at - starts_at = interval '30 minutes'),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancellation_actor IS NOT NULL)),
  CHECK (cancellation_actor IN (mentor_id, mentee_id)),
  CONSTRAINT sessions_mentor_overlap EXCLUDE USING gist
    (mentor_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status <> 'cancelled'),
  CONSTRAINT sessions_mentee_overlap EXCLUDE USING gist
    (mentee_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status <> 'cancelled')
);
CREATE INDEX sessions_mentor_start ON sessions (mentor_id, starts_at);
CREATE INDEX sessions_mentee_start ON sessions (mentee_id, starts_at);
CREATE INDEX sessions_due ON sessions (status, starts_at) WHERE status IN ('scheduled', 'in_progress');

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentee_id uuid NOT NULL,
  mentee_role user_role GENERATED ALWAYS AS ('mentee'::user_role) STORED,
  provider_payment_id text NOT NULL UNIQUE,
  status payment_status NOT NULL DEFAULT 'PENDING',
  credits_purchased integer NOT NULL CHECK (credits_purchased > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mentee_id, mentee_role) REFERENCES users (id, role),
  UNIQUE (id, mentee_id)
);
CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id text NOT NULL UNIQUE,
  provider_payment_id text NOT NULL REFERENCES payments (provider_payment_id),
  event_type text NOT NULL,
  raw_payload bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text
);
CREATE INDEX payment_events_payment ON payment_events (provider_payment_id);

CREATE TABLE credit_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  mentee_id uuid NOT NULL,
  mentee_role user_role GENERATED ALWAYS AS ('mentee'::user_role) STORED,
  admin_id uuid NOT NULL,
  admin_role user_role GENERATED ALWAYS AS ('admin'::user_role) STORED,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  delta integer NOT NULL CHECK (delta <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (admin_id, admin_role) REFERENCES users (id, role),
  FOREIGN KEY (mentee_id, mentee_role) REFERENCES users (id, role),
  UNIQUE (id, mentee_id)
);

CREATE TABLE credit_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentee_id uuid NOT NULL REFERENCES users,
  credit_type credit_type NOT NULL,
  original_quantity integer NOT NULL CHECK (original_quantity > 0),
  expires_at timestamptz,
  payment_id uuid,
  session_id uuid,
  adjustment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, mentee_id),
  CHECK (num_nonnulls(payment_id, session_id, adjustment_id) = 1),
  FOREIGN KEY (payment_id, mentee_id) REFERENCES payments (id, mentee_id),
  FOREIGN KEY (session_id, mentee_id) REFERENCES sessions (id, mentee_id),
  FOREIGN KEY (adjustment_id, mentee_id) REFERENCES credit_adjustments (id, mentee_id),
  CHECK ((credit_type = 'ROLLOVER') = (expires_at IS NOT NULL)),
  CHECK (expires_at > created_at),
  CHECK (credit_type <> 'ROLLOVER' OR session_id IS NOT NULL)
);
CREATE INDEX lots_owner_expiry ON credit_lots (mentee_id, expires_at);

CREATE TABLE session_credit_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE,
  lot_id uuid NOT NULL,
  mentee_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, mentee_id) REFERENCES sessions (id, mentee_id),
  FOREIGN KEY (lot_id, mentee_id) REFERENCES credit_lots (id, mentee_id)
);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentee_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  kind ledger_kind NOT NULL,
  delta integer NOT NULL CHECK (delta <> 0),
  session_id uuid,
  payment_id uuid,
  adjustment_id uuid,
  reason text,
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (lot_id, mentee_id) REFERENCES credit_lots (id, mentee_id),
  FOREIGN KEY (session_id, mentee_id) REFERENCES sessions (id, mentee_id),
  FOREIGN KEY (payment_id, mentee_id) REFERENCES payments (id, mentee_id),
  FOREIGN KEY (adjustment_id, mentee_id) REFERENCES credit_adjustments (id, mentee_id),
  CHECK ((delta > 0) = (kind IN ('PURCHASE_GRANT', 'CANCELLATION_REFUND',
                                  'MENTOR_REFUND', 'NO_SHOW_ROLLOVER', 'ADMIN_GRANT'))),
  CHECK ((session_id IS NOT NULL) = (kind IN ('BOOKING_DEBIT', 'CANCELLATION_REFUND', 'MENTOR_REFUND', 'NO_SHOW_ROLLOVER'))),
  CHECK ((payment_id IS NOT NULL) = (kind IN ('PURCHASE_GRANT', 'PAYMENT_REVERSAL', 'DEBT'))),
  CHECK ((adjustment_id IS NOT NULL) = (kind IN ('ADMIN_GRANT', 'ADMIN_REVOKE')))
);
CREATE INDEX ledger_owner_history ON ledger_entries (mentee_id, created_at DESC, id);
CREATE INDEX ledger_lot ON ledger_entries (lot_id);

CREATE FUNCTION reject_ledger_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger is append-only; insert a compensating entry' USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_change();

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox_events (created_at, id) WHERE processed_at IS NULL;

GRANT USAGE ON SCHEMA public TO mentor_app;
GRANT SELECT ON schema_migrations TO mentor_app;
GRANT SELECT, INSERT, UPDATE ON users, mentor_profiles, sessions, payments, payment_events, outbox_events TO mentor_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON weekly_availability, availability_blockouts TO mentor_app;
GRANT SELECT, INSERT ON ledger_entries, credit_adjustments, credit_lots, session_credit_allocations TO mentor_app;
