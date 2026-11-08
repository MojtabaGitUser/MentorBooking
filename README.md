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
