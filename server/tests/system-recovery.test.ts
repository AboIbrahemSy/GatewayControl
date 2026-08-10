import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyStagedSystemRestore } from '../src/restore-system.js';
import { FileSystemRecoveryService, SystemRecoveryFailure, type ToolRunner } from '../src/system-recovery.js';
import { FakeStore } from './fake-store.js';

class PortableToolRunner implements ToolRunner {
  public readonly calls: Array<{ command: string; args: string[]; environment: NodeJS.ProcessEnv }> = [];

  public async run(command: string, args: string[], environment: NodeJS.ProcessEnv = {}): Promise<string> {
    this.calls.push({ command, args, environment });
    if (command === 'pg_dump') {
      await writeFile(args[args.indexOf('--file') + 1]!, 'portable database dump');
      return '';
    }
    if (command === 'pg_restore' && args[0] === '--list') {
      if (await readFile(args[1]!, 'utf8') !== 'portable database dump') throw new Error('invalid PostgreSQL archive');
      return 'TABLE public portable\n';
    }
    if (command !== 'tar') throw new Error(`Unexpected tool: ${command}`);
    if (args[0] === '-cf') {
      const directory = args[args.indexOf('-C') + 1]!;
      const names = args.slice(args.indexOf('-C') + 2);
      const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, (await readFile(join(directory, name))).toString('base64')])));
      await writeFile(args[1]!, JSON.stringify(files));
      return '';
    }
    const files = JSON.parse(await readFile(args[1]!, 'utf8')) as Record<string, string>;
    if (args[0] === '-tf') return `${Object.keys(files).join('\n')}\n`;
    if (args[0] === '-tvf') return `${Object.keys(files).map((name) => `-rw------- 0 owner group 1 Jan 01 00:00 ${name}`).join('\n')}\n`;
    if (args[0] === '-xf') {
      const directory = args[args.indexOf('-C') + 1]!;
      for (const name of args.slice(args.indexOf('-C') + 2)) await writeFile(join(directory, name), Buffer.from(files[name]!, 'base64'));
      return '';
    }
    throw new Error(`Unexpected tar arguments: ${args.join(' ')}`);
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gateway-recovery-test-'));
  roots.push(root);
  const localRoot = join(root, 'local');
  const nasRoot = join(root, 'nas');
  const stageRoot = join(root, 'stage');
  await mkdir(nasRoot);
  const store = new FakeStore();
  const runner = new PortableToolRunner();
  const service = new FileSystemRecoveryService({
    store,
    databaseUrl: 'postgresql://gateway:password@database:5432/gateway_control?sslmode=require',
    masterKey: Buffer.alloc(32, 7),
    localRoot,
    nasRoot,
    nasMarker: '.gateway-control-nas',
    stageRoot,
    toolRunner: runner,
  });
  return { root, localRoot, nasRoot, stageRoot, store, runner, service };
}

describe('system recovery service', () => {
  it('encrypts a backup, binds its record ID, and stages a backup-specific dump', async () => {
    const { service, store, runner, stageRoot } = await fixture();
    const backup = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    const result = await service.stageRestore({ backupId: backup.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' });

    expect(result.restartRequired).toBe(true);
    const marker = JSON.parse(await readFile(join(stageRoot, 'restore.pending'), 'utf8')) as { restoreId: string; backupId: string; token: string; dump: string };
    expect(marker).toMatchObject({ restoreId: result.restore.id, backupId: backup.id });
    expect(marker.dump).toBe(`database-${backup.id}-${marker.token}.dump`);
    expect(await readFile(join(stageRoot, marker.dump), 'utf8')).toBe('portable database dump');
    expect(await readFile(join(stageRoot, 'restore.lock'), 'utf8')).toBe(`${marker.token}\n`);
    expect(store.systemRestores[0]).toMatchObject({ backupId: backup.id, status: 'staged' });
    expect(runner.calls.find((call) => call.command === 'pg_dump')?.environment).toMatchObject({ PGHOST: 'database', PGDATABASE: 'gateway_control', PGSSLMODE: 'require' });
    expect(runner.calls.every((call) => call.environment.DATABASE_URL === undefined)).toBe(true);
    const archiveValidation = runner.calls.find((call) => call.command === 'pg_restore' && call.args[0] === '--list');
    expect(archiveValidation?.environment.PATH).toBe(process.env.PATH);
    expect(archiveValidation?.environment).not.toHaveProperty('PGHOST');
    expect(archiveValidation?.environment).not.toHaveProperty('PGPASSWORD');
  });

  it('returns stable codes for a wrong passphrase and artifact metadata mismatch', async () => {
    const { service, store } = await fixture();
    const backup = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    await expect(service.stageRestore({ backupId: backup.id, requestedByUserId: randomUUID(), passphrase: 'this passphrase is incorrect' }))
      .rejects.toMatchObject({ code: 'incorrect_passphrase', statusCode: 400 });
    store.systemBackups[0]!.checksum = '0'.repeat(64);
    await expect(service.stageRestore({ backupId: backup.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'invalid_backup', statusCode: 400 });
  });

  it('rejects a manifest backup ID mismatch', async () => {
    const { service, store } = await fixture();
    await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    store.systemBackups[0]!.id = randomUUID();
    await expect(service.stageRestore({ backupId: store.systemBackups[0]!.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'backup_mismatch' });
  });

  it('keeps an existing pending stage untouched and rejects another publication', async () => {
    const { service, stageRoot } = await fixture();
    const first = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    await service.stageRestore({ backupId: first.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' });
    const marker = await readFile(join(stageRoot, 'restore.pending'), 'utf8');
    const second = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'another correct backup passphrase' });

    await expect(service.stageRestore({ backupId: second.id, requestedByUserId: randomUUID(), passphrase: 'another correct backup passphrase' }))
      .rejects.toMatchObject({ code: 'restore_already_staged', statusCode: 409 });
    expect(await readFile(join(stageRoot, 'restore.pending'), 'utf8')).toBe(marker);
  });

  it('honors an exclusive staging lock without removing its owner state', async () => {
    const { service, stageRoot } = await fixture();
    const backup = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, 'restore.lock'), 'another-attempt\n');

    await expect(service.stageRestore({ backupId: backup.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'restore_already_staged', statusCode: 409 });
    expect(await readFile(join(stageRoot, 'restore.lock'), 'utf8')).toBe('another-attempt\n');
  });

  it('removes only its publication when the staged audit insert fails', async () => {
    const { service, store, stageRoot } = await fixture();
    const backup = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    vi.spyOn(store, 'createSystemRestore').mockRejectedValue(new Error('store unavailable'));

    await expect(service.stageRestore({ backupId: backup.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' }))
      .rejects.toBeInstanceOf(SystemRecoveryFailure);
    expect(await readdir(stageRoot)).toEqual([]);
  });

  it('creates one staging audit before publishing the marker and transitions that row', async () => {
    const { service, store, stageRoot } = await fixture();
    const backup = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    const create = store.createSystemRestore.bind(store);
    vi.spyOn(store, 'createSystemRestore').mockImplementation(async (...args) => {
      expect(await lstat(join(stageRoot, 'restore.pending')).catch(() => null)).toBeNull();
      return await create(...args);
    });

    await service.stageRestore({ backupId: backup.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' });

    expect(store.systemRestores).toHaveLength(1);
    expect(store.systemRestores[0]).toMatchObject({ status: 'staged', error: null });
  });

  it('transitions the same audit row to failed when publication status cannot complete', async () => {
    const { service, store, stageRoot } = await fixture();
    const backup = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    const update = store.updateSystemRestore.bind(store);
    vi.spyOn(store, 'updateSystemRestore').mockImplementation(async (id, status, error) => {
      if (status === 'staged') throw new Error('store unavailable');
      return await update(id, status, error);
    });

    await expect(service.stageRestore({ backupId: backup.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'invalid_backup' });
    expect(store.systemRestores).toHaveLength(1);
    expect(store.systemRestores[0]).toMatchObject({ status: 'failed', error: 'invalid_backup' });
    expect(await readdir(stageRoot)).toEqual([]);
  });

  it('rejects a dump that pg_restore cannot read as a custom archive', async () => {
    const { service, store, runner } = await fixture();
    const backup = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    vi.spyOn(runner, 'run').mockImplementation(async (command, args, environment) => {
      if (command === 'pg_restore') throw new Error('not a PostgreSQL custom archive');
      return await PortableToolRunner.prototype.run.call(runner, command, args, environment);
    });

    await expect(service.stageRestore({ backupId: backup.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'invalid_backup' });
    expect(store.systemRestores).toHaveLength(1);
    expect(store.systemRestores[0]).toMatchObject({ status: 'failed', error: 'invalid_backup' });
  });

  it('accepts the documented regular NAS marker and rejects a missing marker', async () => {
    const { service, nasRoot } = await fixture();
    await writeFile(join(nasRoot, '.gateway-control-nas'), '');
    await expect(service.createBackup({ requestedByUserId: randomUUID(), target: 'nas', passphrase: 'correct horse battery staple' })).resolves.toMatchObject({ status: 'succeeded', target: 'nas' });
    await rm(join(nasRoot, '.gateway-control-nas'));
    await expect(service.createBackup({ requestedByUserId: randomUUID(), target: 'nas', passphrase: 'another correct backup passphrase' }))
      .rejects.toMatchObject({ code: 'nas_unavailable' });
  });
});

describe('startup system restore', () => {
  it('uses one transaction and removes marker and dump only after success', async () => {
    const { stageRoot } = await fixture();
    const restoreId = randomUUID();
    const backupId = randomUUID();
    const token = randomUUID();
    const dump = `database-${backupId}-${token}.dump`;
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, dump), 'dump');
    await writeFile(join(stageRoot, 'restore.pending'), JSON.stringify({ version: 1, restoreId, backupId, token, dump }));
    await writeFile(join(stageRoot, 'restore.lock'), `${token}\n`);
    const calls: string[] = [];
    const runner: ToolRunner = { run: vi.fn(async (_command, args, environment) => {
      expect(args).toContain('--single-transaction');
      expect(environment?.PATH).toBe(process.env.PATH);
      return '';
    }) };

    await expect(applyStagedSystemRestore({
      stageRoot,
      databaseUrl: 'postgresql://user:pass@db/app',
      toolRunner: runner,
      removeFile: async (path) => { calls.push(path); await rm(path); },
    })).resolves.toBe(true);
    expect(calls).toEqual([join(stageRoot, 'restore.pending'), join(stageRoot, dump), join(stageRoot, 'restore.lock')]);
    expect(await readdir(stageRoot)).toEqual([]);
  });

  it('retains marker and dump when pg_restore fails', async () => {
    const { stageRoot } = await fixture();
    const restoreId = randomUUID();
    const backupId = randomUUID();
    const token = randomUUID();
    const dump = `database-${backupId}-${token}.dump`;
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, dump), 'dump');
    await writeFile(join(stageRoot, 'restore.pending'), JSON.stringify({ version: 1, restoreId, backupId, token, dump }));
    await writeFile(join(stageRoot, 'restore.lock'), `${token}\n`);
    const runner: ToolRunner = { run: vi.fn(async () => { throw new Error('restore failed'); }) };

    await expect(applyStagedSystemRestore({ stageRoot, databaseUrl: 'postgresql://user:pass@db/app', toolRunner: runner })).rejects.toThrow('restore failed');
    expect(await readdir(stageRoot)).toEqual(expect.arrayContaining(['restore.pending', dump]));
  });

  it('keeps the dump and lock when marker cleanup fails', async () => {
    const { stageRoot } = await fixture();
    const restoreId = randomUUID();
    const backupId = randomUUID();
    const token = randomUUID();
    const dump = `database-${backupId}-${token}.dump`;
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, dump), 'dump');
    await writeFile(join(stageRoot, 'restore.pending'), JSON.stringify({ version: 1, restoreId, backupId, token, dump }));
    await writeFile(join(stageRoot, 'restore.lock'), `${token}\n`);
    const removals: string[] = [];

    await expect(applyStagedSystemRestore({
      stageRoot,
      databaseUrl: 'postgresql://user:pass@db/app',
      toolRunner: { run: vi.fn(async () => '') },
      removeFile: async (path) => { removals.push(path); throw new Error('marker delete failed'); },
    })).rejects.toThrow('marker delete failed');
    expect(removals).toEqual([join(stageRoot, 'restore.pending')]);
    expect(await readdir(stageRoot)).toEqual(expect.arrayContaining(['restore.pending', dump, 'restore.lock']));
  });
});
