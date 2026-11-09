# System verification (US-19)

Run from the repository root with the bundled Compose PostgreSQL service and npm dependencies installed. Chromium is the browser exercised by this suite.

```sh
npm ci
npx playwright install chromium
docker compose config -q
docker compose up -d --build --wait
npm test
npm run test:integration
npm run test:e2e
npm run lint
npm run typecheck
npm run build
npm audit --omit=dev
```

## Coverage and commands

| Area | Focused command | Evidence |
|---|---|---|
| Booking | `npm run test:bookings` | Same slot, last credit, overlapping mentors, blockout edit, conflicting and identical retries. Assertions link the winning request to its wallet, allocation and receipt. |
| Money | `npm run test:wallet`, `npm run test:payments` | Immutable entries, expiring lots, debt, signed duplicate and reordered events, process death and durable recovery. |
| Cancellation and admin | `npm run test:cancellations`, `npm run test:mentor-admin` | Exact refund cutoff, competing actors, outbox atomicity, revoke versus booking, attributed receipts and rollback midway through a two-lot revoke. |
| Attendance and worker | `npm run test:lifecycle`, `npm run test:worker` | Early join, terminal races, 30-day award, reminder timing, SKIP LOCKED, crash recovery, batch limits and process shutdown. |
| Timezones | `npm test`, `npm run test:availability`, `npm run test:bookings` | London on March 29 and October 25, 2026, Kolkata to the previous Los Angeles date, half-hour alignment, stale slot after a mentor timezone change and stable UTC identity after a viewer timezone change. |
| Access and schema | `npm run test:auth`, `npm run test:schema`, `npm run test:directory` | Runtime login, owner and role checks, repeated seed, migrations, exclusion constraints and rejected ledger updates and deletes. |
| Browser | `npm run test:e2e` | Account picker to directory, booking, lost response, cancellation and linked wallet entries. Signed purchases, mentor and admin workflows, worker no-show and repeated tick. UI checks cover keyboard navigation, error states, light/dark themes and 375, 768, 1280 and 1440 px widths. |

The integration health probe reads the running API. Database-writing suites create named temporary databases, migrate them and exercise the restricted runtime login. Playwright starts dedicated API and web containers on ephemeral ports. The directory, booking and worker browser groups each get a fresh database. Run a group with `npm run test:e2e:booking -- --directory`, `npm run test:e2e:booking` or `npm run test:e2e:booking -- --worker-journey`. Rebuild the images after changing backend tests or application sources. Screenshots go under the ignored `test-results` directory.

## Reproduction and limits

Booking race tests hold a row lock on an independent connection, observe waiting transactions in PostgreSQL and then release them. Assertions accept either winner and check the committed rows. Repeat the focused commands in the table to exercise different lock acquisition orders. A sensitivity check removed the mentee row lock in a disposable migration container. The last-credit test observed two HTTP 201 responses where it requires one 201 and one 409.

Policy, DST and worker boundary cases pass explicit instants into existing service methods. The worker browser journey advances from early join to one millisecond before resolution and then to the grace boundary. A second tick at that same instant must leave one award. It runs inside its isolated API container. Browser booking requests still use the real database clock and future fixtures. Existing date-specific HTTP fixtures include 2030, so those dates will need advancing when they enter the past.

Delivery assertions cover the database outbox and delivery records. External messaging delivery, external payment networks, other browser engines and sustained load are outside this run.

## Verification record

On PostgreSQL 17.11 and Node 24.14.1, 51 unit tests, 152 integration tests and 34 Chromium tests passed. The booking, wallet, cancellation, mentor/admin, payment, lifecycle and worker suites passed three runs each on fresh databases (122 tests per round). The admin race fixture starts with enough credits for a revoke to succeed even when it wins the first lock. The auth suite now exercises reseeding in a disposable database.

Node's built-in unit-test coverage reported 66.33% of lines and 87.11% of branches in the loaded compiled API modules (dependencies excluded), and 100% of lines and 91.03% of branches in the four loaded web utility modules. The browser, database and worker-process runs are reported by scenario and assertion. These unit percentages cover only the modules loaded by their respective unit suites.

To reproduce the unit coverage after building the API, run these commands from the indicated workspace.

```sh
# apps/api
node --experimental-test-coverage "--test-coverage-include=**/dist/**/*.js" "--test-coverage-exclude=**/node_modules/**" --test "test/*.test.mjs"
# apps/web
node --experimental-test-coverage "--test-coverage-include=**/lib/*.ts" "--test-coverage-exclude=**/*.test.*" --test "lib/*.test.ts"
```
