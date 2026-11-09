# Entity relationship diagram

```mermaid
erDiagram
  USERS ||--o| MENTOR_PROFILES : has
  MENTOR_PROFILES ||--o{ WEEKLY_AVAILABILITY : defines
  MENTOR_PROFILES ||--o{ AVAILABILITY_BLOCKOUTS : excludes
  MENTOR_PROFILES ||--o{ SESSIONS : hosts
  USERS ||--o{ SESSIONS : books
  USERS ||--o{ PAYMENTS : owns
  PAYMENTS ||--o{ PAYMENT_EVENTS : receives
  USERS ||--o{ CREDIT_ADJUSTMENTS : receives
  USERS ||--o{ CREDIT_ADJUSTMENTS : administers
  USERS ||--o{ CREDIT_LOTS : owns
  PAYMENTS o|--o{ CREDIT_LOTS : funds
  SESSIONS o|--o{ CREDIT_LOTS : refunds_or_awards
  CREDIT_ADJUSTMENTS o|--o{ CREDIT_LOTS : grants
  CREDIT_LOTS ||--o{ LEDGER_ENTRIES : journals
  SESSIONS o|--o{ LEDGER_ENTRIES : explains
  PAYMENTS o|--o{ LEDGER_ENTRIES : explains
  CREDIT_ADJUSTMENTS o|--o{ LEDGER_ENTRIES : explains
  SESSIONS ||--|| SESSION_CREDIT_ALLOCATIONS : consumes
  CREDIT_LOTS ||--o{ SESSION_CREDIT_ALLOCATIONS : supplies
  USERS ||--o{ BOOKING_REQUESTS : retries
  SESSIONS ||--o| BOOKING_REQUESTS : records
  OUTBOX_EVENTS ||--o| NOTIFICATION_DELIVERIES : delivers

  USERS { uuid id PK
    user_role role
    text display_name
    text timezone }
  MENTOR_PROFILES { uuid mentor_id PK, FK
    text bio }
  WEEKLY_AVAILABILITY { uuid id PK
    uuid mentor_id FK
    smallint weekday
    time start_local
    time end_local }
  AVAILABILITY_BLOCKOUTS { uuid id PK
    uuid mentor_id FK
    timestamptz starts_at
    timestamptz ends_at }
  SESSIONS { uuid id PK
    uuid mentor_id FK
    uuid mentee_id FK
    timestamptz starts_at
    timestamptz ends_at
    session_status status }
  PAYMENTS { uuid id PK
    uuid mentee_id FK
    text provider_payment_id UK
    payment_status status }
  PAYMENT_EVENTS { uuid id PK
    text provider_event_id UK
    text provider_payment_id FK
    bytea raw_payload
    timestamptz processed_at }
  CREDIT_ADJUSTMENTS { uuid id PK
    text idempotency_key UK
    uuid mentee_id FK
    uuid admin_id FK
    int delta
    text reason }
  CREDIT_LOTS { uuid id PK
    uuid mentee_id FK
    credit_type credit_type
    int original_quantity
    timestamptz expires_at }
  SESSION_CREDIT_ALLOCATIONS { uuid id PK
    uuid session_id UK, FK
    uuid lot_id FK
    int quantity }
  LEDGER_ENTRIES { uuid id PK
    uuid mentee_id FK
    uuid lot_id FK
    ledger_kind kind
    int delta
    text idempotency_key UK }
  BOOKING_REQUESTS { uuid mentee_id PK, FK
    text idempotency_key PK
    uuid session_id FK }
  OUTBOX_EVENTS { uuid id PK
    text event_key UK
    text type
    jsonb payload
    int attempts
    timestamptz processed_at }
  NOTIFICATION_DELIVERIES { uuid id PK
    uuid outbox_event_id UK, FK
    text event_key UK
    timestamptz delivered_at }
```

## Important guarantees

- Partial GiST exclusion constraints reject overlapping active sessions for either mentor or mentee.
- Composite role foreign keys prevent using a user in the wrong domain role.
- A credit lot has exactly one source; rollover lots require an expiry and session source.
- Ledger kind/delta/source combinations are checked, and update/delete/truncate is rejected.
- Unique webhook, business, booking, ledger, and outbox keys make retries durable.
- Allocation preserves the exact funding lot required for deterministic refunds.
