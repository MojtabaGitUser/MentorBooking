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

`npm run dev` builds and starts the stack in the foreground. Re-run it after editing sources. Docker reads optional overrides from a root `.env`; [.env.example](.env.example) lists supported settings. The default setup generates its own local database password. The webhook secret is reserved for a later story.

See [bootstrap architecture](docs/bootstrap.md) for migration and networking conventions.
