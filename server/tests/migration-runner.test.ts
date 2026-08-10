import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverMigrations, HISTORICAL_MIGRATION_CHECKSUMS, validateAppliedMigrations } from '../src/migration-runner.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function migrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-migrations-'));
  directories.push(directory);
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(join(directory, name), contents)));
  return directory;
}

describe('migration integrity', () => {
  it('rejects a changed checksum for an applied migration', async () => {
    const migrations = await discoverMigrations(await migrationDirectory({ '001_initial.sql': 'SELECT 1;\n' }));
    expect(() => validateAppliedMigrations(migrations, [{ name: '001_initial.sql', checksum: '0'.repeat(64) }]))
      .toThrow('Migration checksum mismatch');
    expect(() => validateAppliedMigrations(migrations, [{ name: '001_initial.sql', checksum: null }]))
      .toThrow('Historical migration checksum mismatch');
  });

  it.each(['1_bad.sql', '001-Bad.sql', '001_description.SQL'])('rejects invalid migration filename %s', async (name) => {
    await expect(discoverMigrations(await migrationDirectory({ [name]: 'SELECT 1;' }))).rejects.toThrow('Invalid migration filename');
  });

  it('rejects duplicate migration sequence numbers', async () => {
    await expect(discoverMigrations(await migrationDirectory({ '001_first.sql': '', '001_second.sql': '' }))).rejects.toThrow('Duplicate migration sequence');
  });

  it('accepts only the fixed reviewed checksum when baselining historical rows', () => {
    const checksum = HISTORICAL_MIGRATION_CHECKSUMS['001_initial.sql']!;
    expect(() => validateAppliedMigrations([{ name: '001_initial.sql', sql: '', checksum }], [{ name: '001_initial.sql', checksum: null }])).not.toThrow();
  });

  it('rejects applied migration gaps and newer migrations applied before older ones', () => {
    const migrations = [
      { name: '001_initial.sql', sql: '', checksum: HISTORICAL_MIGRATION_CHECKSUMS['001_initial.sql']! },
      { name: '002_assign_connectors_to_agents.sql', sql: '', checksum: HISTORICAL_MIGRATION_CHECKSUMS['002_assign_connectors_to_agents.sql']! },
    ];
    expect(() => validateAppliedMigrations(migrations, [{ name: migrations[1]!.name, checksum: migrations[1]!.checksum }]))
      .toThrow('contiguous prefix');
  });
});
