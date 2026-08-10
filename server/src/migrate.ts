import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadConfig } from './config.js';

const config = loadConfig();
const client = new Client({ connectionString: config.databaseUrl });
const migrationsDirectory = process.env.MIGRATIONS_DIR?.trim() || join(process.cwd(), 'migrations');
const migrationLockId = 42_424_242;

await client.connect();
try {
  await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (existing.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(join(migrationsDirectory, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.info(`Applied migration ${file}.`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]);
  }
} finally {
  await client.end();
}
