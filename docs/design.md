# PostgreSQL domain model

```mermaid
erDiagram
    USERS ||--o| MENTOR_PROFILES : has
    MENTOR_PROFILES ||--o{ WEEKLY_AVAILABILITY : offers
    MENTOR_PROFILES ||--o{ AVAILABILITY_BLOCKOUTS : blocks
    MENTOR_PROFILES ||--o{ SESSIONS : hosts
    USERS ||--o{ SESSIONS : books
    USERS ||--o{ PAYMENTS : purchases
    PAYMENTS ||--o{ PAYMENT_EVENTS : receives
    USERS ||--o{ CREDIT_ADJUSTMENTS : authorizes_or_receives
    PAYMENTS o|--o{ CREDIT_LOTS : funds
    SESSIONS o|--o{ CREDIT_LOTS : originates_refund
    CREDIT_ADJUSTMENTS o|--o{ CREDIT_LOTS : grants
    CREDIT_LOTS ||--o{ LEDGER_ENTRIES : records
    SESSIONS o|--o{ LEDGER_ENTRIES : explains
    PAYMENTS o|--o{ LEDGER_ENTRIES : explains
    CREDIT_ADJUSTMENTS o|--o{ LEDGER_ENTRIES : explains
    SESSIONS ||--o| SESSION_CREDIT_ALLOCATIONS : costs
    CREDIT_LOTS ||--o{ SESSION_CREDIT_ALLOCATIONS : supplies
    OUTBOX_EVENTS {
        uuid id PK
        text event_key UK
        jsonb payload
    }
```

### Booking and time

Recurring availability uses ISO weekday and local wall-clock times. A mentor's timezone comes from their user record. PostgreSQL validates zone names against its installed timezone database. Blockouts and sessions use absolute instants. The booking service will validate half-hour alignment in the mentor's local calendar and recheck availability under a mentor lock.

Two partial GiST exclusion constraints reject intersecting non-cancelled intervals for the same mentor or mentee, including writes on different connections. The second writer waits for an uncommitted conflict and fails with SQLSTATE `23P01` if the first commits. Half-open intervals allow adjacent sessions. Cancelling removes the interval from both indexes while retaining the historical row. A unique start time alone would miss partially overlapping intervals.

### Credits and audit

Each credit lot identifies one funding source by a typed foreign key to a payment, session or admin adjustment. Composite foreign keys ensure financial references belong to the same mentee. Generated role columns constrain the roles of mentors, mentees and administrators. Each MVP booking can allocate one unit from one lot. That allocation preserves the original source for a refund even when the source has expired.

The spendable wallet will sum signed ledger deltas and account for lot expiry. Rollover lots have an expiry instant and are consumed earliest-expiry first to preserve expiring value. Spending records the debit immediately, so expiry affects only the remaining quantity. The later booking service must serialize spending by the same mentee and commit the session, allocation and debit together. Exclusion constraints alone do not serialize two different non-overlapping bookings competing for a final credit.

Ledger corrections use compensating inserts. Runtime grants permit only SELECT and INSERT on the ledger, lots, allocations and adjustment requests. A statement trigger also rejects ledger UPDATE, DELETE and TRUNCATE by privileged ordinary writes. Database administrators control DDL and maintenance. Domain records use restrictive foreign keys to preserve audit references.

### Retry boundaries

Unique provider identifiers protect payment and event identity. The inbox stores signed payload bytes, receipt and processing metadata. A unique adjustment request can span multiple per-lot ledger entries. Ledger idempotency keys, outbox event keys and the partial pending-outbox index support later transactional handlers and workers. Outbox payloads carry event-specific references. Payment reconciliation, job execution and wallet policy are implemented in their respective stories.
