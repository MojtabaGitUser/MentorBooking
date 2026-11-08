import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { connectionOptions } from './config.cjs';

const mode = process.argv[2];
if (!['migrate', 'seed'].includes(mode)) throw Error('Expected migrate or seed');
if (mode === 'migrate' && process.env.EXTERNAL_API_CONFIGURED !== undefined &&
    Boolean(process.env.EXTERNAL_API_CONFIGURED) !== Boolean(process.env.DATABASE_URL)) {
  throw Error('Set both DATABASE_URL and MIGRATION_DATABASE_URL for an external database');
}
const db = new pg.Client(connectionOptions());
await db.connect();
try {
  await db.query('BEGIN');
  // Serialize bootstrap commands across concurrent starts of this application.
  await db.query('SELECT pg_advisory_xact_lock(924301)');
  if (mode === 'migrate') {
    // External installations provision their restricted login outside this runner.
    if (process.env.RUNTIME_PASSWORD_FILE && !process.env.DATABASE_URL) {
      const role = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'mentor_app'");
      if (!role.rowCount) {
        const password = (await readFile(process.env.RUNTIME_PASSWORD_FILE, 'utf8')).trim();
        const ddl = await db.query("SELECT format('CREATE ROLE mentor_app LOGIN PASSWORD %L', $1::text) AS sql", [password]);
        await db.query(ddl.rows[0].sql);
      }
    }
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
      const applied = await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (applied.rowCount) continue;
      try {
        await db.query(await readFile(new URL(name, directory), 'utf8'));
      } catch (error) {
        throw new Error(`Migration ${name} failed`, { cause: error });
      }
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    }
  } else {
    // Domain accounts arrive in US-03. For now seed verifies the bootstrap baseline.
    const baseline = await db.query("SELECT 1 FROM schema_migrations WHERE name = '0001_baseline.sql'");
    if (!baseline.rowCount) throw Error('Run migrations before seed');
  }
  await db.query('COMMIT');
  console.log(mode === 'seed' ? 'Seed ready: baseline verified; no domain fixtures yet.' : 'Migrations complete.');
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}
