import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QueryResult } from 'pg';

const MIGRATION_NAME_PATTERN = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
export const HISTORICAL_MIGRATION_CHECKSUMS: Readonly<Record<string, string>> = Object.freeze({
  '001_initial.sql': '800d8d999c6d4c7d9dbc33f0de37d0c36f7720ecdf384b28e55268fbf2ea3965',
  '002_assign_connectors_to_agents.sql': '853509dcf5f4e74cfcce211b26a88f56d66ce4355f3b10542bd970574141e585',
  '003_managed_stacks_and_routes.sql': 'd2bd51a8609fe5afeb44dd6ecea535e71ba6da7b766e1da8069f2b2d83290fc3',
  '004_operations_observability_backups.sql': '0f7730d360c63e0b5e11d9f08f16841f0e2e5081d18df20e0f36e04001f4d9eb',
  '005_cloudflare_management.sql': '2ce7613b553f1489406550af0f0e3f697f9bbd04a54ed2c1da1c2de7e49ca88a',
  '006_agent_archival.sql': '79f51386d8f6fbe7ecd192c9ec31aa3b422a9a6ac9e335860104b8974ff1d22d',
  '007_agent_connector_health.sql': '404bdc2596c71309702ca9becd91a7b364edf678556b86995f84b0606fb54446',
  '008_postgres_backup_config.sql': '6dda0acdf31a3f10fa488bc1fbd8e60818e412f6965779261470c3702a9db6e5',
  '009_system_recovery.sql': '0907ac73ac867a68751aa543eed5dcd5abbeae8d5809200b4fa80b47e7ce23ee',
  '010_system_restore_staging.sql': '8cde57df53d64862cb6cb5cc83e5be5a04680396fd9a1c5cdb51bbe915ebcc5a',
  '011_runtime_control.sql': '140e14f9108728ff9c4548cf69d68adeb8f7691ac3d052be70e22fd00e9c9e01',
  '012_domain_access.sql': '511a53d77b90d5dd83e19ee6a10d2a5379147f486b8956024e053a1238d71780',
});

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string | null;
}

interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export async function discoverMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => /\.sql$/i.test(name)).sort();
  const sequenceNumbers = new Set<string>();
  for (const name of names) {
    const match = MIGRATION_NAME_PATTERN.exec(name);
    if (!match) throw new Error(`Invalid migration filename: ${name}. Expected NNN_description.sql.`);
    if (sequenceNumbers.has(match[1]!)) throw new Error(`Duplicate migration sequence: ${match[1]}.`);
    sequenceNumbers.add(match[1]!);
  }
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export function validateAppliedMigrations(migrations: Migration[], applied: AppliedMigration[]): void {
  const available = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const [index, row] of applied.entries()) {
    const migration = available.get(row.name);
    if (!migration) throw new Error(`Applied migration is missing from the release: ${row.name}.`);
    if (migrations[index]?.name !== row.name) throw new Error(`Applied migrations must form a contiguous prefix; found a gap before ${row.name}.`);
    if (row.checksum === null) {
      const baseline = HISTORICAL_MIGRATION_CHECKSUMS[row.name];
      if (!baseline) throw new Error(`No reviewed historical checksum exists for migration: ${row.name}.`);
      if (migration.checksum !== baseline) throw new Error(`Historical migration checksum mismatch: ${row.name}. Refusing to baseline edited content.`);
    }
    if (row.checksum !== null && row.checksum !== migration.checksum) {
      throw new Error(`Migration checksum mismatch: ${row.name}. Applied migrations must never be edited.`);
    }
  }
}

export async function runMigrations(client: MigrationClient, migrations: Migration[]): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    checksum text
  )`);
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
  const appliedResult = await client.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
  const applied = appliedResult.rows as AppliedMigration[];
  validateAppliedMigrations(migrations, applied);

  const appliedNames = new Set(applied.map((row) => row.name));
  for (const row of applied) {
    if (row.checksum !== null) continue;
    const checksum = HISTORICAL_MIGRATION_CHECKSUMS[row.name]!;
    const baseline = await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL', [row.name, checksum]);
    if (baseline.rowCount !== 1) throw new Error(`Could not baseline migration checksum: ${row.name}.`);
  }

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) continue;
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
      await client.query('COMMIT');
      console.info(`Applied migration ${migration.name}.`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  await client.query('ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL');
}
