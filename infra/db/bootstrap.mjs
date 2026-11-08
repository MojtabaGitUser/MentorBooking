import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { connectionOptions } from './config.cjs';

const mode = process.argv[2];
if (!['migrate', 'seed'].includes(mode)) throw Error('Expected migrate or seed');
const db = new pg.Client(connectionOptions());
await db.connect();
try {
  await db.query('BEGIN');
  // Serialize bootstrap commands across concurrent starts of this application.
  await db.query('SELECT pg_advisory_xact_lock(924301)');
  if (mode === 'migrate') {
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
      const applied = await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (applied.rowCount) continue;
      await db.query(await readFile(new URL(name, directory), 'utf8'));
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
