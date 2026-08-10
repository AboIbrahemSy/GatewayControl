import { join } from 'node:path';
import { Client } from 'pg';
import { loadConfig } from './config.js';
import { discoverMigrations, runMigrations } from './migration-runner.js';

const config = loadConfig();
const client = new Client({ connectionString: config.databaseUrl });
const migrationsDirectory = process.env.MIGRATIONS_DIR?.trim() || join(process.cwd(), 'migrations');
const migrationLockId = 42_424_242;

await client.connect();
try {
  await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
  try {
    const migrations = await discoverMigrations(migrationsDirectory);
    await runMigrations(client, migrations);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]);
  }
} finally {
  await client.end();
}
