# Mentor Booking

US-01 provides a runnable NestJS, Next.js and PostgreSQL development stack. The home page reports the live API and database status.

## Start

For local demo identities, copy `.env.example` to `.env` (or set `DEMO_AUTH_ENABLED=true` in an existing local file). Compose reads this value when creating the API container.

Install Docker with Compose v2 or later. Run these commands from the repository root with ports 3000 and 3001 available.

```sh
docker compose up --build -d --wait
docker compose exec -T api node infra/db/bootstrap.mjs seed
```

The second command is safe to repeat. With npm installed, `npm run seed` is the same command. Seed inserts five fixed users and two mentor profiles in one transaction. Re-running seed preserves existing rows and their creation timestamps.

Compose runs the privileged `migrate` service after PostgreSQL is ready and starts the API with the restricted `mentor_app` login after migrations succeed. Existing US-01 installations can run the same startup command against their existing volumes. Inspect migration results with `docker compose logs migrate` or rerun with `docker compose run --rm migrate`. Numbered SQL files run in one transaction under the existing bootstrap lock. See the [schema and ERD](docs/design.md).

`npm run test:schema` tests the bundled PostgreSQL server through the migration container. Each run creates a uniquely named temporary database, runs the migrations, connects as the API login, and removes only that database afterward. `npm run test:integration` includes these tests, the live health check and the demo authentication suite (`npm run test:auth`). The auth suite seeds the local demo accounts and exercises test-only routes inside a separate Nest instance. Rebuild the images after changing SQL or schema tests.

Open the [status page](http://localhost:3000) or [API health endpoint](http://localhost:3001/health). The endpoint returns HTTP 200 with the application version and database status after a successful database query, or HTTP 503 when the query fails.

`docker compose ps` shows service health. Use `docker compose logs api web db` to inspect startup errors. Stop the project with `docker compose down`. The database and generated password persist in named volumes.

## Demo authentication

Header identity is suitable only for a trusted local demo: anyone who knows a seeded UUID can act as that user, including the administrator. The guard enables it only when `DEMO_AUTH_ENABLED` is exactly `true`. Leave it unset or false in production. Protected routes then return 401. The public health endpoint remains available.

```sh
curl -H "X-User-Id: 00000000-0000-4000-8000-000000000003" http://localhost:3001/me
```

`/me` returns the stored id, role, displayName and timezone. Missing, unknown or malformed IDs return `401 USER_NOT_FOUND`; an authenticated user lacking permission receives `403 FORBIDDEN`. The API reads roles from PostgreSQL on each request. For future protected handlers, use `@Roles(...)` and `@CurrentUser()`; for an existing private resource pass its database owner to `requireResourceAccess`. Admin ledger inspection is a separate permission from reading a user's private sessions or editing a mentor's schedule.

| Seed ID | Role | Display name | Timezone |
|---|---|---|---|
| `00000000-0000-4000-8000-000000000001` | mentor | Amelia Reed | Europe/London |
| `00000000-0000-4000-8000-000000000002` | mentor | Ravi Sen | Asia/Kolkata |
| `00000000-0000-4000-8000-000000000003` | mentee | Alex Chen | America/Vancouver |
| `00000000-0000-4000-8000-000000000004` | mentee | Sam Rivera | America/New_York |
| `00000000-0000-4000-8000-000000000005` | admin | Demo Admin | UTC |

## Development and verification

Use Node.js 24 and npm 11 for host-side tooling.

```sh
npm ci
npm run lint
npm run typecheck
npm run build
npm test
```

With the Compose stack running, exercise the live API and the status page in Chromium.

```sh
npm run test:integration
npx playwright install chromium
npm run test:e2e
```

`npm run dev` builds and starts the stack in the foreground. Re-run it after editing sources. Docker reads optional overrides from a root `.env`; [.env.example](.env.example) lists supported settings. Compose generates separate local secrets for PostgreSQL and webhook signing.

See [bootstrap architecture](docs/bootstrap.md) for migration and networking conventions.

### Dependency security

`npm audit --omit=dev` reports no vulnerabilities in runtime dependencies.

- **multer override.** `@nestjs/platform-express@11.2.8` (the last NestJS 11 release) pins `multer@2.4.0`, which is affected by [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) (high, denial of service). The root `overrides` entry replaces it with the patched `multer@2.5.0` for that exact NestJS version only. 2.5.0 is a compatible minor release with the same API and dependencies; NestJS 12 ships it upstream. Remove the override when upgrading `@nestjs/platform-express`. The API currently exposes no multipart routes.
- **Accepted dev-only finding.** `npm audit` still reports [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (moderate, 10 entries for one root cause) in `minimatch@10.2.6`. Only ESLint and typescript-eslint use it, and they match glob patterns from this repository's own `eslint.config.mjs`. The fix exists only in `minimatch@11`, outside the range declared by the latest ESLint (10.14.0). Forcing it via an override was tested but deferred because it is an unsupported major-version change. Exposure is low: the code runs only when linting and is never executed by the API or web servers. Revisit plan: when `eslint`, `@eslint/config-array` and `@typescript-eslint/typescript-estree` all officially accept a patched `minimatch` (>= 11.0.1), upgrade them with a normal compatible update, confirm `npm audit` is clean and lint output is unchanged. Do not run `npm audit fix --force`: it downgrades ESLint to 9.x.

## Mentee wallet

With demo authentication enabled, use a seeded mentee's UUID. Both read endpoints take the wallet owner from the authenticated user. Example requests for the Vancouver account:

```sh
curl -H "X-User-Id: 00000000-0000-4000-8000-000000000003" http://localhost:3001/wallet/me
curl -H "X-User-Id: 00000000-0000-4000-8000-000000000003" "http://localhost:3001/wallet/me/transactions?limit=20"
```

A freshly seeded wallet returns:

```json
{"normal":0,"rollover":0,"debt":0,"totalSpendable":0,"rolloverLots":[],"history":{"items":[],"nextCursor":null}}
```

The transactions endpoint returns the same page structure as `history`. Each item includes its ID, kind, signed delta, source IDs, lot type and expiry, reason, idempotency key and UTC timestamp. Pass the returned `nextCursor` unchanged as `cursor` to continue. Limits range from 1 to 100 (default 20); invalid, unknown and foreign cursors return `400 INVALID_PAGE`. A null cursor in a response marks the last page.

Run `npm test` for unit tests and `npm run test:wallet` for wallet integration tests on the bundled PostgreSQL server. The latter creates a disposable database, applies the existing migrations and uses the application's restricted login. The full `npm run test:integration` suite includes these checks.

## Credit pack purchases

The MVP offers one pack of four credits. Start the local Compose stack with demo authentication enabled and run seed. Create a pending order and inspect the wallet from PowerShell.

```powershell
$api = 'http://127.0.0.1:3001'
$headers = @{ 'X-User-Id' = '00000000-0000-4000-8000-000000000003' }
$order = Invoke-RestMethod "$api/payments/purchases" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"packCredits":4}'
$order
Invoke-RestMethod "$api/wallet/me" -Headers $headers
npm run payment:simulate -- --payment $order.providerPaymentId --event succeeded
Invoke-RestMethod "$api/wallet/me" -Headers $headers
```

The purchase returns HTTP 201 with `paymentId`, `providerPaymentId`, `status: PENDING` and `packCredits: 4`. Use the **providerPaymentId** for the simulator. It posts to `POST /webhooks/fake-payments` over the Compose network. The first success returns HTTP 200 and `{"status":"SUCCEEDED","duplicate":false}`. Further successes return `duplicate:true`. The wallet increases by four only once.

The CLI signs the exact UTF-8 event body containing `eventId`, `paymentId`, `type` and `occurredAt` with HMAC-SHA256. It sends `X-Webhook-Signature: sha256=<hex>` and prints the HTTP response. Compose provisions a local key automatically. Set `WEBHOOK_SECRET` to override it. For host-side simulation set the same secret and `PAYMENT_API_URL=http://localhost:3001`, then run `node apps/api/scripts/fake-provider.mjs --payment <providerPaymentId> --event succeeded`.

To simulate a full refund run `npm run payment:simulate -- --payment $order.providerPaymentId --event refunded`. The first refund returns HTTP 200 with `status: REFUNDED`. A refund before success closes the order without a grant. A refund after success reverses unspent credits from that purchase and records previously spent credits as signed debt. For example, spending one of four credits before the refund produces PAYMENT_REVERSAL -3 and DEBT -1. Use the wallet and transactions endpoints to inspect both entries.

Each CLI invocation creates a fresh provider event ID. To retry an identical delivery, send the same signed bytes and event ID. A processed replay returns the current payment status and `duplicate:true`. A different ID for an already satisfied transition is also acknowledged without another grant or reversal. Reusing an ID with different signed bytes returns HTTP 409 `EVENT_ID_CONFLICT`.

A verified receipt survives a crash before financial processing. Redelivery resumes it. To recover without waiting for the provider, run `npm run payment:recover` with the stack up, including after restarting the API. The command starts a fresh process and examines up to 100 pending events, least-attempted first. It reports examined/failed counts and exits nonzero if any failed. Repeat for additional batches or after resolving a transient error. An empty batch reports zero examined.

Run `npm test` for HMAC unit tests and `npm run test:payments` for CLI, concurrency and rollback tests on disposable PostgreSQL.

## Rollover expiry

With Compose running, execute `npm run credits:expire` from the repository root. This performs one expiry pass and prints the number of lots journaled. It is safe to rerun after interruption or alongside another pass. The wallet excludes expired credit immediately, including before this command runs. Only unspent rollover credit expires; prior allocations and future session reservations remain in place.

Run `npm test` for selection policy unit tests and `npm run test:wallet` for real PostgreSQL tests of expiry boundaries, debit/expiry races, rollback and reservation attribution. See the [integration contract](docs/design.md#rollover-selection-and-expiry) for the transaction and clock requirements.

### Mentor availability (US-05)

Use the seeded mentor's `X-User-Id` with the [scheduling OpenAPI contract and examples](docs/mentor-schedule.openapi.json). GET lists the signed-in mentor's records, POST creates, PATCH /:id changes only supplied fields, and DELETE /:id returns 204. Missing credentials return 401; the wrong role or owner receives 403.

- POST `/mentor/availability` with `{"weekday":1,"startLocal":"09:00","endLocal":"12:00"}`. ISO weekday 1 is Monday. Times must be ordered 24-hour HH:mm values. Active rules may touch but cannot overlap on one weekday (422). Reads include the current IANA timezone from the mentor's user record. Changing that zone preserves the stored local hours.
- POST `/mentor/blockouts` with `{"startsAt":"2030-10-26T23:30:00+01:00","endsAt":"2030-10-28T00:00:00Z","reason":"Away"}`. Both instants require an explicit offset or Z and a positive interval. PostgreSQL stores timestamptz and the API returns UTC with microsecond precision. PATCH accepts either or both boundaries and a nullable reason. Overlapping exclusions are allowed. A conflict with a non-cancelled session returns 409 and the affected session IDs. Failed edits preserve the original record.

US-06 should expand active weekly rules in the mentor's zone for the requested dates, then exclude slots intersecting any half-open blockout interval. For booking, take the mentee lock first, then lock the mentor_profiles row FOR UPDATE and recheck availability in the same READ COMMITTED transaction as the booking. Schedule edits already take this mentor lock.

Run `npm test` for input validation and `npm run test:availability` against the rebuilt Compose stack for the HTTP, PostgreSQL and concurrency cases. The latter also runs in `npm run test:integration`.

### Preview mentor slots (US-06)

A signed-in mentee can call `GET /mentors/:mentorId/slots?from=2099-01-05&to=2099-01-05&timezone=America/Los_Angeles`. Both dates are inclusive in the mentor's calendar. Results cover up to the first 31 days. Omit `timezone` to use the viewing mentee's saved IANA zone.

For a Kolkata mentor available from 09:00 to 09:30 that Monday, the response is:

```json
{
  "mentorTimezone": "Asia/Kolkata",
  "viewerTimezone": "America/Los_Angeles",
  "slots": [{
    "startsAt": "2099-01-05T03:30:00Z",
    "endsAt": "2099-01-05T04:00:00Z",
    "localStartsAt": "2099-01-04T19:30:00-08:00",
    "localEndsAt": "2099-01-04T20:00:00-08:00"
  }]
}
```

Invalid dates, reversed ranges and invalid viewer zones return 422. An unknown mentor returns 404. Empty availability returns 200 with an empty slots array. Run `npm test` for DST/calendar tests and `npm run test:availability` for PostgreSQL and endpoint tests. See the [slot preview design](docs/design.md#slot-preview).

### Book a session (US-11)

A signed-in mentee books one 30-minute slot for one credit. The mentee is always the authenticated user; the body never names one.

```sh
curl -X POST http://localhost:3001/sessions \
  -H "X-User-Id: 00000000-0000-4000-8000-000000000003" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 6f1c2d9e-booking-attempt" \
  -d '{"mentorId":"00000000-0000-4000-8000-000000000002","startsAt":"2099-01-05T03:30:00Z"}'
```

`startsAt` is an ISO-8601 instant with `Z` or an explicit offset (`2099-01-05T09:00:00+05:30` is the same slot). The server derives the 30-minute end and the cost. A new booking returns HTTP 201:

```json
{"sessionId":"…","mentorId":"00000000-0000-4000-8000-000000000002","status":"scheduled",
 "spentCreditType":"NORMAL","startsAt":"2099-01-05T03:30:00Z","endsAt":"2099-01-05T04:00:00Z"}
```

`Idempotency-Key` is optional (1–128 visible ASCII characters, scoped to the mentee). Create one per intended booking and reuse it on retries. A retry with the same key, mentor and instant returns HTTP 200 with the original booking and its current status, without another debit. The same key with a different mentor or start returns 409 `IDEMPOTENCY_CONFLICT`. A failed attempt stores no key, so the same key can be retried after fixing the cause.

| Status | `code` | When |
|---|---|---|
| 401 | `USER_NOT_FOUND` | No or unknown `X-User-Id` |
| 403 | `FORBIDDEN` | Caller is not a mentee |
| 404 | `MENTOR_NOT_FOUND` | Unknown mentor ID |
| 422 | `INVALID_BOOKING_REQUEST` | Malformed body, instant without offset, extra fields, bad key |
| 422 | `INVALID_SLOT` | Not on :00/:30 (and zero seconds) of the mentor's wall clock |
| 409 | `SLOT_UNAVAILABLE` | `details.reason`: `IN_PAST`, `OUTSIDE_AVAILABILITY`, `BLOCKED` or `BOOKED`. Message: "This time slot is no longer available. Please select another slot." |
| 409 | `SESSION_OVERLAP` | The mentee already has an overlapping non-cancelled session with any mentor |
| 409 | `INSUFFICIENT_CREDITS` | Spendable credit below one, after expiry and outstanding debt |
| 409 | `IDEMPOTENCY_CONFLICT` | Key reused for a different booking |
| 500 | `BOOKING_FAILED` | Unexpected failure; nothing was committed, safe to retry with the same key |

The slot preview is only a snapshot. Booking rechecks the slot, blockouts, sessions and credit inside its transaction. See [atomic booking](docs/design.md#atomic-booking-us-11). Run `npm test` for request, alignment and DST unit tests and `npm run test:bookings` (also part of `npm run test:integration`) for the PostgreSQL concurrency, idempotency and rollback tests. Rebuild the images first (`docker compose up -d --build --wait`) so the migrate container contains migration `0004` and the new tests.

### Cancel a session as the mentee (US-12)

Cancellation is two steps: show the outcome, then confirm exactly that outcome.

```sh
curl -H "X-User-Id: 00000000-0000-4000-8000-000000000003" http://localhost:3001/sessions/<sessionId>/cancellation-preview
curl -X POST -H "X-User-Id: 00000000-0000-4000-8000-000000000003" -H "Content-Type: application/json" \
  -d '{"expectedRefundableCredits":1}' http://localhost:3001/sessions/<sessionId>/cancel
```

The preview returns `sessionId`, `status`, `eligible`, `refundableCredits` (0 or 1), `refundType` (`FULL` or `NONE`), `reason`, `startsAt`, `cutoffAt` (start − 24h) and `serverNow`, all UTC. Send its `refundableCredits` as `expectedRefundableCredits`.

- More than 24 hours before the start (`now < cutoffAt`): one credit back (`MORE_THAN_24_HOURS_BEFORE_START`).
- Exactly 24 hours or less, but before the start: cancellable without refund (`WITHIN_24_HOURS_OF_START`).
- At or after the official start: not cancellable (`SESSION_STARTED`), even if the background job has not yet moved the session out of `scheduled`. An early join does not affect eligibility before the start.

A successful cancel returns 200 with `status: "cancelled"`, `cancelledAt`, `cancelledBy`, `alreadyCancelled: false`, `reason` and `refund: {credits, creditType, lotId}`. Repeating it returns 200 with `alreadyCancelled: true` and the recorded refund; no second refund is possible.

| Status | `code` | When |
|---|---|---|
| 401 / 403 | `USER_NOT_FOUND` / `FORBIDDEN` | No identity; caller is not a mentee or not the session's mentee |
| 404 | `SESSION_NOT_FOUND` | Unknown session ID |
| 422 | `INVALID_CANCELLATION_REQUEST` | Body is not exactly `{"expectedRefundableCredits":0|1}` |
| 409 | `CANCELLATION_POLICY_CHANGED` | The refund outcome differs from the confirmed one (e.g. the 24h cutoff passed). Nothing changed; `details.currentPreview` holds the new outcome to confirm again |
| 409 | `SESSION_NOT_CANCELLABLE` | Started, in progress or finished; `details.currentPreview` explains why |
| 500 | `CANCELLATION_FAILED` | Unexpected failure; nothing was changed, safe to retry |

Run `npm test` for the boundary unit tests and `npm run test:cancellations` (also in `npm run test:integration`) for PostgreSQL boundary, attribution, concurrency and rollback tests. Rebuild images first so migration `0005` is included. See [mentee cancellation](docs/design.md#mentee-cancellation-us-12).

### Mentor cancellation (US-13)

```sh
curl -X POST -H "X-User-Id: 00000000-0000-4000-8000-000000000002" -H "Content-Type: application/json" \
  -d '{"reason":"Unwell"}' http://localhost:3001/mentor/sessions/<sessionId>/cancel
```

The owning mentor may cancel a `scheduled` or `in_progress` session at any time, including within 24 hours, after an early join or after the official start. The mentee always gets the session's credit back (`MENTOR_REFUND`). The body is optional; `reason` is 1–500 characters. The response is 200 with `status`, `cancelledAt`, `cancelledBy: "mentor"`, `previousStatus`, `alreadyCancelled`, `refund: {credits, creditType, lotId}` and `notification.eventKey` (`mentor-cancelled:<sessionId>`). Repeating it returns the recorded result with `alreadyCancelled: true`.

Errors: 401/403 (not the session's mentor, or not a mentor), 404 `SESSION_NOT_FOUND`, 422 `INVALID_CANCELLATION_REQUEST`, 409 `SESSION_NOT_CANCELLABLE` when the session is completed, a no-show, or already cancelled by the mentee (`details.status`, `details.cancelledBy`), 500 `CANCELLATION_FAILED` with nothing changed.

### Admin ledger and credit adjustments (US-13)

```sh
curl -H "X-User-Id: 00000000-0000-4000-8000-000000000005" "http://localhost:3001/admin/users/<userId>/ledger?limit=20"
curl -X POST -H "X-User-Id: 00000000-0000-4000-8000-000000000005" -H "Content-Type: application/json" \
  -d '{"delta":2,"reason":"Goodwill for outage","idempotencyKey":"adj-2026-11-08-001"}' \
  http://localhost:3001/admin/users/<menteeId>/credits/adjust
```

The ledger view returns `user`, `balance` (mentees only; `null` for mentors and admins, who hold no credit), `items` and `nextCursor`. Items use the wallet history fields plus `adjustedBy` (the admin ID) for admin entries. Pagination is the wallet cursor (`limit` 1–100). Unknown users return 404 `TARGET_USER_NOT_FOUND`.

An adjustment needs a nonzero integer `delta` (at most ±1000), a nonblank `reason` and an `idempotencyKey`; the acting admin is taken from authentication. A grant creates a NORMAL lot and one `ADMIN_GRANT`. A revoke debits spendable credit in the spend order (rollover by earliest expiry, then normal), one `ADMIN_REVOKE` per lot, and is rejected with 409 `INSUFFICIENT_CREDITS` if it exceeds spendable credit, so it never creates debt or drives a lot negative. New adjustments return 201 with a receipt (`adjustmentId`, `menteeId`, `adjustedBy`, `delta`, `reason`, `idempotencyKey`, `createdAt`, `entries`); an identical retry returns 200 with the same receipt, and reusing the key with any other target, admin, delta or reason returns 409 `IDEMPOTENCY_CONFLICT`. Validation failures return 422 `INVALID_ADJUSTMENT`, and a non-mentee target returns 422 `TARGET_NOT_MENTEE`. Only admins can use these routes.

Run `npm test` for the policy and validation unit tests and `npm run test:mentor-admin` (also in `npm run test:integration`) for PostgreSQL concurrency, idempotency, rollback and authorization tests.

### Join, session lists and lifecycle (US-14)

`POST /sessions/:id/join` (mentor or mentee of that session, no body) records the caller's attendance with the server clock and returns `{sessionId, role, status, joinedAt, alreadyJoined, startsAt, endsAt}`. The role comes from the session row, never from the request. The window is from 5 minutes before the start until the end. An early join only records the timestamp; the session stays `scheduled`, so mentee cancellation is still possible until the official start. A join at or after the start also moves a still-`scheduled` session to `in_progress`. Retries keep the first timestamp. Errors: 401/403, 404 `SESSION_NOT_FOUND`, 409 `JOIN_WINDOW_NOT_OPEN` (`details.opensAt`), 409 `JOIN_WINDOW_CLOSED`, 409 `SESSION_NOT_JOINABLE` (cancelled or finished).

`GET /sessions/me?status=upcoming|past` (mentee) and `GET /mentor/sessions?status=upcoming|past` (mentor) list the caller's own sessions with the counterpart's name and timezone, UTC times, join timestamps and `cancelledBy`. Upcoming is `scheduled` or `in_progress` (soonest first); past is every terminal status (latest first).

Lifecycle transitions have no HTTP route. `LifecycleService` (`startDue`, `resolveDue`, `resolveSession`) is the transactional API for the US-15 worker. At end + 5 minutes a session resolves from its join timestamps: both joined → `completed`; only the mentor → `no_show_mentee` (credit kept); only the mentee → `no_show_mentor` (one new rollover credit valid 30 days); nobody → `no_show_mentee`. Run `npm test` and `npm run test:lifecycle` (also in `npm run test:integration`).
