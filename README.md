# Mentor Booking

US-01 provides a runnable NestJS, Next.js and PostgreSQL development stack. The home page reports the live API and database status.

## Start

Install Docker with Compose v2 or later. Run these commands from the repository root with ports 3000 and 3001 available.

```sh
docker compose up --build -d --wait
docker compose exec -T api node infra/db/bootstrap.mjs seed
```

The second command is safe to repeat. With npm installed, `npm run seed` is the same command. In US-01 it checks the applied bootstrap migration. Domain tables and sample accounts belong to US-02 and US-03 respectively.

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
