# Bootstrap architecture

npm workspaces share one lockfile. `apps/api` runs NestJS, `apps/web` runs the Next.js App Router, and `packages/shared` defines the TypeScript health response used across the boundary. Tailwind, shadcn/ui configuration and Lucide are ready for subsequent UI work.

PostgreSQL listens on port 5432 inside the Compose network. A one-shot service generates the local database password in a named volume on first startup. The API and database mount that volume read-only. The frontend fetches the API server-side through `API_BASE_URL`, which defaults to `http://api:3001` inside Compose. Browser requests use localhost. Only web and API ports are published, on loopback.

The API starts after PostgreSQL accepts connections. It runs the SQL files in `infra/db/migrations` in filename order, under a transaction-scoped advisory lock. The database commits migration effects and the migration history together. Add subsequent migrations as new, numbered files. The bootstrap seed checks the migration baseline and can be repeated.

The database client uses `pg` so later stories can use PostgreSQL transactions and constraints directly. The status check runs a bounded query on the pool per request. The initial stack has no dependency on external services after installation and image build.
