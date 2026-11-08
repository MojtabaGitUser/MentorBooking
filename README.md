# Mentor Booking

US-01 provides a runnable NestJS, Next.js and PostgreSQL development stack. The home page reports the live API and database status.

## Start

Install Docker with Compose v2 or later. Run these commands from the repository root with ports 3000 and 3001 available.

```sh
docker compose up --build -d --wait
docker compose exec -T api node infra/db/bootstrap.mjs seed
```

The second command is safe to repeat. With npm installed, `npm run seed` is the same command. Seed currently checks the bootstrap baseline. US-03 adds sample accounts.

Compose runs the privileged `migrate` service after PostgreSQL is ready and starts the API with the restricted `mentor_app` login after migrations succeed. Existing US-01 installations can run the same startup command against their existing volumes. Inspect migration results with `docker compose logs migrate` or rerun with `docker compose run --rm migrate`. Numbered SQL files run in one transaction under the existing bootstrap lock. See the [schema and ERD](docs/design.md).

`npm run test:schema` tests the bundled PostgreSQL server through the migration container. Each run creates a uniquely named temporary database, runs the migrations, connects as the API login, and removes only that database afterward. `npm run test:integration` includes these tests and the live health check. Rebuild the images after changing SQL or schema tests.

Open the [status page](http://localhost:3000) or [API health endpoint](http://localhost:3001/health). The endpoint returns HTTP 200 with the application version and database status after a successful database query, or HTTP 503 when the query fails.

`docker compose ps` shows service health. Use `docker compose logs api web db` to inspect startup errors. Stop the project with `docker compose down`. The database and generated password persist in named volumes.

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
