import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('system recovery service', () => {
  it('encrypts a backup, binds its record ID, and stages a backup-specific dump', async () => {
    const { service, store, runner, stageRoot } = await fixture();
    const backup = await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase: 'correct horse battery staple' });
    const result = await service.stageRestore({ backupId: backup.id, requestedByUserId: randomUUID(), passphrase: 'correct horse battery staple' });

    expect(result).toMatchObject({
      manualRestoreRequired: true,
      restoreCommand: 'sh docker/recover.sh',
    });
    const marker = JSON.parse(await readFile(join(stageRoot, 'restore.pending'), 'utf8')) as { version: number; restoreId: string; backupId: string; backupSizeBytes: number; backupChecksum: string; token: string; dump: string };
    expect(marker).toMatchObject({ version: 2, restoreId: result.restore.id, backupId: backup.id, backupSizeBytes: backup.sizeBytes, backupChecksum: backup.checksum });
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

  it('exports only a verified stored artifact and records bounded audit metadata', async () => {
    const { service, store } = await fixture();
    const actorId = randomUUID();
    const backup = await service.createBackup({ requestedByUserId: actorId, target: 'local', passphrase: 'correct horse battery staple' });
    const exported = await service.exportArtifact({ backupId: backup.id, requestedByUserId: actorId });

    expect(exported.filename).toBe(`gateway-control-system-${backup.id}.gcsb`);
    expect(await readStream(exported.stream)).toEqual(await readFile(store.systemBackups[0]!.artifactPath));
    expect(store.systemBackupTransferEvents[0]).toMatchObject({ operation: 'export', backupId: backup.id, requestedByUserId: actorId });
    store.systemBackups[0]!.sizeBytes! += 1;
    await expect(service.exportArtifact({ backupId: backup.id, requestedByUserId: actorId })).rejects.toMatchObject({ code: 'invalid_backup' });
  });

  it.runIf(process.platform !== 'win32')('rejects a stored symlink artifact without following it', async () => {
    const { service, store, root } = await fixture();
    const actorId = randomUUID();
    const backup = await service.createBackup({ requestedByUserId: actorId, target: 'local', passphrase: 'correct horse battery staple' });
    const artifactPath = store.systemBackups[0]!.artifactPath;
    const realPath = join(root, 'real-artifact.gcsb');
    await rename(artifactPath, realPath);
    await symlink(realPath, artifactPath, 'file');

    await expect(service.exportArtifact({ backupId: backup.id, requestedByUserId: actorId })).rejects.toMatchObject({ code: 'invalid_backup' });
  });

  it('streams from the verified descriptor when the pathname is replaced', async () => {
    const { service, store, root } = await fixture();
    const actorId = randomUUID();
    const backup = await service.createBackup({ requestedByUserId: actorId, target: 'local', passphrase: 'correct horse battery staple' });
    const artifactPath = store.systemBackups[0]!.artifactPath;
    const expected = await readFile(artifactPath);
    const exported = await service.exportArtifact({ backupId: backup.id, requestedByUserId: actorId });
    await rename(artifactPath, join(root, 'verified-open-artifact.gcsb'));
    await writeFile(artifactPath, 'replacement must not be streamed');

    expect(await readStream(exported.stream)).toEqual(expected);
  });

  it('closes the verified export descriptor when the stream is aborted', async () => {
    const { service, store, root } = await fixture();
    const actorId = randomUUID();
    const backup = await service.createBackup({ requestedByUserId: actorId, target: 'local', passphrase: 'correct horse battery staple' });
    const exported = await service.exportArtifact({ backupId: backup.id, requestedByUserId: actorId });
    const closed = new Promise<void>((resolve) => exported.stream.once('close', resolve));
    exported.stream.destroy();
    await closed;
    await expect(rename(store.systemBackups[0]!.artifactPath, join(root, 'closed-export.gcsb'))).resolves.toBeUndefined();
  });

  it('enforces declared and streaming import bounds and rejects truncation', async () => {
    const { root, store, runner } = await fixture();
    const service = new FileSystemRecoveryService({
      store, databaseUrl: 'postgresql://gateway:password@database:5432/gateway_control', masterKey: Buffer.alloc(32, 7),
      localRoot: join(root, 'bounded'), nasRoot: join(root, 'nas'), nasMarker: '.gateway-control-nas', stageRoot: join(root, 'bounded-stage'), toolRunner: runner, maxImportBytes: 8,
    });
    await expect(service.uploadImport({ requestedByUserId: randomUUID(), stream: Readable.from(Buffer.alloc(9)), contentLength: 9 })).rejects.toMatchObject({ code: 'import_too_large' });
    await expect(service.uploadImport({ requestedByUserId: randomUUID(), stream: Readable.from(Buffer.alloc(4)), contentLength: 8 })).rejects.toMatchObject({ code: 'invalid_import' });
    expect(store.systemBackupImports.at(-1)).toMatchObject({ status: 'rejected', error: 'invalid_import' });
  });

  it('streams an exported artifact through import and can stage the preserved backup ID', async () => {
    const source = await fixture();
    const passphrase = 'correct horse battery staple';
    const created = await source.service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase });
    const artifact = await readFile(source.store.systemBackups[0]!.artifactPath);

    const destinationRoot = await mkdtemp(join(tmpdir(), 'gateway-import-roundtrip-'));
    roots.push(destinationRoot);
    const destinationStore = new FakeStore();
    const destinationService = new FileSystemRecoveryService({
      store: destinationStore, databaseUrl: 'postgresql://gateway:password@database:5432/gateway_control', masterKey: Buffer.alloc(32, 7),
      localRoot: join(destinationRoot, 'local'), nasRoot: join(destinationRoot, 'nas'), nasMarker: '.gateway-control-nas', stageRoot: join(destinationRoot, 'stage'), toolRunner: new PortableToolRunner(),
    });
    const actorId = randomUUID();
    const uploaded = await destinationService.uploadImport({ requestedByUserId: actorId, stream: Readable.from(artifact), contentLength: artifact.length });
    const imported = await destinationService.validateImport({ importId: uploaded.id, requestedByUserId: actorId, passphrase });

    expect(imported.backup).toMatchObject({ id: created.id, source: 'imported', status: 'succeeded' });
    await expect(destinationService.stageRestore({ backupId: created.id, requestedByUserId: actorId, passphrase })).resolves.toMatchObject({ restore: { backupId: created.id, status: 'staged' } });
  });

  it('rejects wrong import passphrases and duplicate-ID checksum conflicts without exposing secrets', async () => {
    const { service, store } = await fixture();
    const passphrase = 'correct horse battery staple';
    await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase });
    const artifact = await readFile(store.systemBackups[0]!.artifactPath);
    const actorId = randomUUID();
    const uploaded = await service.uploadImport({ requestedByUserId: actorId, stream: Readable.from(artifact), contentLength: artifact.length });
    await expect(service.validateImport({ importId: uploaded.id, requestedByUserId: actorId, passphrase: 'incorrect import passphrase' })).rejects.toMatchObject({ code: 'incorrect_passphrase' });
    expect(JSON.stringify(store.systemBackupImports)).not.toContain('incorrect import passphrase');

    const second = await service.uploadImport({ requestedByUserId: actorId, stream: Readable.from(artifact), contentLength: artifact.length });
    store.systemBackups[0]!.checksum = '0'.repeat(64);
    await expect(service.validateImport({ importId: second.id, requestedByUserId: actorId, passphrase })).rejects.toMatchObject({ code: 'import_conflict' });
  });

  it('allows only one concurrent import validation claimant', async () => {
    const { service, store } = await fixture();
    const passphrase = 'correct horse battery staple';
    await service.createBackup({ requestedByUserId: randomUUID(), target: 'local', passphrase });
    const artifact = await readFile(store.systemBackups[0]!.artifactPath);
    const actorId = randomUUID();
    const uploaded = await service.uploadImport({ requestedByUserId: actorId, stream: Readable.from(artifact), contentLength: artifact.length });

    const outcomes = await Promise.allSettled([
      service.validateImport({ importId: uploaded.id, requestedByUserId: actorId, passphrase }),
      service.validateImport({ importId: uploaded.id, requestedByUserId: actorId, passphrase }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409, code: 'import_active' });
    expect(store.systemBackupImports[0]).toMatchObject({ status: 'imported', error: null, validationRevision: 1 });
  });

  it('publishes a signed fixed-schema apply request with no passphrase or path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-apply-request-'));
    roots.push(root);
    const store = new FakeStore();
    const service = new FileSystemRecoveryService({
      store, databaseUrl: 'postgresql://gateway:password@database:5432/gateway_control', masterKey: Buffer.alloc(32, 7),
      localRoot: join(root, 'local'), nasRoot: join(root, 'nas'), nasMarker: '.gateway-control-nas', stageRoot: join(root, 'stage'),
      toolRunner: new PortableToolRunner(), recoverySupervisorEnabled: true, recoveryRequestSecret: Buffer.alloc(32, 9),
    });
    const actorId = randomUUID();
    const passphrase = 'correct horse battery staple';
    const backup = await service.createBackup({ requestedByUserId: actorId, target: 'local', passphrase });
    const { restore } = await service.stageRestore({ backupId: backup.id, requestedByUserId: actorId, passphrase });
    await expect(service.requestApply({ restoreId: restore.id, requestedByUserId: actorId, confirmation: `APPLY ${restore.id}`, passphrase })).resolves.toEqual({ queued: true });
    const request = await readFile(join(root, 'local', '.recovery-requests', 'request.pending'), 'utf8');
    expect(JSON.parse(request)).toEqual({ version: 1, operation: 'apply-system-restore', restoreId: restore.id, signature: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(request).not.toContain(passphrase);
    expect(request).not.toContain(root);
    expect(store.systemRecoveryRequests).toEqual([expect.objectContaining({ status: 'published' })]);
  });

  it('does not publish when durable recovery-request audit creation fails', async () => {
    const { root, localRoot, nasRoot, stageRoot, store, runner } = await fixture();
    const service = new FileSystemRecoveryService({
      store, databaseUrl: 'postgresql://gateway:password@database:5432/gateway_control', masterKey: Buffer.alloc(32, 7),
      localRoot, nasRoot, nasMarker: '.gateway-control-nas', stageRoot, toolRunner: runner,
      recoverySupervisorEnabled: true, recoveryRequestSecret: Buffer.alloc(32, 9),
    });
    const actorId = randomUUID();
    const passphrase = 'correct horse battery staple';
    const backup = await service.createBackup({ requestedByUserId: actorId, target: 'local', passphrase });
    const { restore } = await service.stageRestore({ backupId: backup.id, requestedByUserId: actorId, passphrase });
    vi.spyOn(store, 'createSystemRecoveryRequest').mockRejectedValue(new Error('audit unavailable'));

    await expect(service.requestApply({ restoreId: restore.id, requestedByUserId: actorId, confirmation: `APPLY ${restore.id}`, passphrase })).rejects.toThrow('audit unavailable');
    expect(await lstat(join(root, 'local', '.recovery-requests', 'request.pending')).catch(() => null)).toBeNull();
  });

  it('marks the durable request failed when pending publication fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-apply-publication-failure-'));
    roots.push(root);
    const store = new FakeStore();
    const localRoot = join(root, 'local');
    const service = new FileSystemRecoveryService({
      store, databaseUrl: 'postgresql://gateway:password@database:5432/gateway_control', masterKey: Buffer.alloc(32, 7), localRoot,
      nasRoot: join(root, 'nas'), nasMarker: '.gateway-control-nas', stageRoot: join(root, 'stage'), toolRunner: new PortableToolRunner(),
      recoverySupervisorEnabled: true, recoveryRequestSecret: Buffer.alloc(32, 9),
    });
    const actorId = randomUUID();
    const passphrase = 'correct horse battery staple';
    const backup = await service.createBackup({ requestedByUserId: actorId, target: 'local', passphrase });
    const { restore } = await service.stageRestore({ backupId: backup.id, requestedByUserId: actorId, passphrase });
    await mkdir(join(localRoot, '.recovery-requests'));
    await writeFile(join(localRoot, '.recovery-requests', 'request.pending'), 'existing');

    await expect(service.requestApply({ restoreId: restore.id, requestedByUserId: actorId, confirmation: `APPLY ${restore.id}`, passphrase })).rejects.toMatchObject({ code: 'recovery_request_pending' });
    expect(store.systemRecoveryRequests).toEqual([expect.objectContaining({ status: 'failed', error: 'recovery_request_pending' })]);
    expect(await readFile(join(localRoot, '.recovery-requests', 'request.pending'), 'utf8')).toBe('existing');
  });

  it('reports queued after publication even if later audit writes fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-apply-post-publication-'));
    roots.push(root);
    const store = new FakeStore();
    const localRoot = join(root, 'local');
    const service = new FileSystemRecoveryService({
      store, databaseUrl: 'postgresql://gateway:password@database:5432/gateway_control', masterKey: Buffer.alloc(32, 7), localRoot,
      nasRoot: join(root, 'nas'), nasMarker: '.gateway-control-nas', stageRoot: join(root, 'stage'), toolRunner: new PortableToolRunner(),
      recoverySupervisorEnabled: true, recoveryRequestSecret: Buffer.alloc(32, 9),
    });
    const actorId = randomUUID();
    const passphrase = 'correct horse battery staple';
    const backup = await service.createBackup({ requestedByUserId: actorId, target: 'local', passphrase });
    const { restore } = await service.stageRestore({ backupId: backup.id, requestedByUserId: actorId, passphrase });
    vi.spyOn(store, 'finishSystemRecoveryRequest').mockRejectedValue(new Error('audit unavailable'));
    vi.spyOn(store, 'recordSystemBackupTransferEvent').mockRejectedValue(new Error('event unavailable'));

    await expect(service.requestApply({ restoreId: restore.id, requestedByUserId: actorId, confirmation: `APPLY ${restore.id}`, passphrase })).resolves.toEqual({ queued: true });
    expect(await lstat(join(localRoot, '.recovery-requests', 'request.pending'))).toMatchObject({});
  });
});

describe('host recovery supervisor', () => {
  it('uses only the fixed recovery wrapper without eval or request-selected arguments', async () => {
    const script = await readFile(join(process.cwd(), '..', 'docker', 'recovery-supervisor.sh'), 'utf8');
    expect(script).toContain('sh docker/recover.sh');
    expect(script).not.toMatch(/\beval\b/);
    expect(script).not.toContain('sh docker/recover.sh "$');
    expect(script).not.toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(script).toContain('flock -n 9');
    expect(script).toMatch(/if \[ ! -e "\$claimed" \].*\[ -e "\$pending" \].*mv "\$pending" "\$claimed".*fi\s+if \[ -e "\$claimed" \]/s);
    expect(script.indexOf('if [ -e "$claimed" ]')).toBeLessThan(script.indexOf('sh docker/recover.sh'));
  });

  it('resumes an interrupted claimed request independently of a pending request', async () => {
    const script = await readFile(join(process.cwd(), '..', 'docker', 'recovery-supervisor.sh'), 'utf8');
    const claimPending = script.indexOf('if [ ! -e "$claimed" ]');
    const resumeClaimed = script.indexOf('if [ -e "$claimed" ]');

    expect(claimPending).toBeGreaterThan(-1);
    expect(resumeClaimed).toBeGreaterThan(claimPending);
    expect(script.slice(resumeClaimed)).toContain('(cd "$project_root" && sh docker/recover.sh)');
  });
});

describe('startup system restore', () => {
  it('finalizes the self-referential backup record after restoring a version 2 marker', async () => {
    const { stageRoot } = await fixture();
    const restoreId = randomUUID();
    const backupId = randomUUID();
    const token = randomUUID();
    const dump = `database-${backupId}-${token}.dump`;
    const backupChecksum = 'a'.repeat(64);
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, dump), 'dump');
    await writeFile(join(stageRoot, 'restore.pending'), JSON.stringify({ version: 2, restoreId, backupId, backupSizeBytes: 1234, backupChecksum, token, dump }));
    await writeFile(join(stageRoot, 'restore.lock'), `${token}\n`);
    const finalizeBackup = vi.fn(async () => undefined);

    await expect(applyStagedSystemRestore({
      stageRoot,
      databaseUrl: 'postgresql://user:pass@db/app',
      toolRunner: { run: vi.fn(async () => '') },
      finalizeBackup,
    })).resolves.toBe(true);
    expect(finalizeBackup).toHaveBeenCalledWith('postgresql://user:pass@db/app', expect.objectContaining({ backupId, backupSizeBytes: 1234, backupChecksum }));
  });

  it('atomically transitions pending through applied and cleans marker last among active files', async () => {
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
    const renames: string[] = [];
    const runner: ToolRunner = { run: vi.fn(async (_command, args, environment) => {
      expect(args).toContain('--single-transaction');
      expect(environment?.PATH).toBe(process.env.PATH);
      return '';
    }) };

    await expect(applyStagedSystemRestore({
      stageRoot,
      databaseUrl: 'postgresql://user:pass@db/app',
      toolRunner: runner,
      renameFile: async (source, destination) => { renames.push(`${source}->${destination}`); await rename(source, destination); },
      removeFile: async (path) => { removals.push(path); await rm(path); },
    })).resolves.toBe(true);
    expect(renames).toEqual([
      `${join(stageRoot, 'restore.pending')}->${join(stageRoot, 'restore.applying')}`,
      `${join(stageRoot, 'restore.applying')}->${join(stageRoot, 'restore.applied')}`,
    ]);
    expect(removals).toEqual([join(stageRoot, 'restore.lock'), join(stageRoot, 'restore.applied'), join(stageRoot, dump)]);
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
    expect(await readdir(stageRoot)).toEqual(expect.arrayContaining(['restore.applying', dump, 'restore.lock']));
  });

  it('resumes applying while the wrapper keeps the writer stopped', async () => {
    const { stageRoot } = await fixture();
    const restoreId = randomUUID();
    const backupId = randomUUID();
    const token = randomUUID();
    const dump = `database-${backupId}-${token}.dump`;
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, dump), 'dump');
    await writeFile(join(stageRoot, 'restore.applying'), JSON.stringify({ version: 1, restoreId, backupId, token, dump }));
    await writeFile(join(stageRoot, 'restore.lock'), `${token}\n`);
    const runner: ToolRunner = { run: vi.fn(async () => '') };

    await expect(applyStagedSystemRestore({ stageRoot, databaseUrl: 'postgresql://user:pass@db/app', toolRunner: runner })).resolves.toBe(true);
    expect(runner.run).toHaveBeenCalledOnce();
    expect(await readdir(stageRoot)).toEqual([]);
  });

  it('treats applied as cleanup-only and can retry after marker cleanup fails', async () => {
    const { stageRoot } = await fixture();
    const restoreId = randomUUID();
    const backupId = randomUUID();
    const token = randomUUID();
    const dump = `database-${backupId}-${token}.dump`;
    const appliedPath = join(stageRoot, 'restore.applied');
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, dump), 'dump');
    await writeFile(appliedPath, JSON.stringify({ version: 1, restoreId, backupId, token, dump }));
    await writeFile(join(stageRoot, 'restore.lock'), `${token}\n`);
    const runner: ToolRunner = { run: vi.fn(async () => { throw new Error('must not run'); }) };

    await expect(applyStagedSystemRestore({
      stageRoot,
      databaseUrl: 'postgresql://user:pass@db/app',
      toolRunner: runner,
      removeFile: async (path) => {
        if (path === appliedPath) throw new Error('marker delete failed');
        await rm(path);
      },
    })).rejects.toThrow('marker delete failed');
    expect(runner.run).not.toHaveBeenCalled();
    expect(await readdir(stageRoot)).toEqual(expect.arrayContaining(['restore.applied', dump]));
    expect(await lstat(join(stageRoot, 'restore.lock')).catch(() => null)).toBeNull();

    await expect(applyStagedSystemRestore({ stageRoot, databaseUrl: 'postgresql://user:pass@db/app', toolRunner: runner })).resolves.toBe(true);
    expect(runner.run).not.toHaveBeenCalled();
    expect(await readdir(stageRoot)).toEqual([]);
  });

  it('leaves pending intact when the first atomic transition fails', async () => {
    const { stageRoot } = await fixture();
    const restoreId = randomUUID();
    const backupId = randomUUID();
    const token = randomUUID();
    const dump = `database-${backupId}-${token}.dump`;
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, dump), 'dump');
    await writeFile(join(stageRoot, 'restore.pending'), JSON.stringify({ version: 1, restoreId, backupId, token, dump }));
    await writeFile(join(stageRoot, 'restore.lock'), `${token}\n`);

    await expect(applyStagedSystemRestore({
      stageRoot,
      databaseUrl: 'postgresql://user:pass@db/app',
      renameFile: async () => { throw new Error('rename failed'); },
    })).rejects.toThrow('rename failed');
    expect(await readdir(stageRoot)).toEqual(expect.arrayContaining(['restore.pending', dump, 'restore.lock']));
  });

  it('leaves applying durable when publishing applied fails after pg_restore', async () => {
    const { stageRoot } = await fixture();
    const restoreId = randomUUID();
    const backupId = randomUUID();
    const token = randomUUID();
    const dump = `database-${backupId}-${token}.dump`;
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, dump), 'dump');
    await writeFile(join(stageRoot, 'restore.pending'), JSON.stringify({ version: 1, restoreId, backupId, token, dump }));
    await writeFile(join(stageRoot, 'restore.lock'), `${token}\n`);
    let transitions = 0;

    await expect(applyStagedSystemRestore({
      stageRoot,
      databaseUrl: 'postgresql://user:pass@db/app',
      toolRunner: { run: vi.fn(async () => '') },
      renameFile: async (source, destination) => {
        transitions += 1;
        if (transitions === 2) throw new Error('applied marker rename failed');
        await rename(source, destination);
      },
    })).rejects.toThrow('applied marker rename failed');
    expect(await readdir(stageRoot)).toEqual(expect.arrayContaining(['restore.applying', dump, 'restore.lock']));
  });

  it('retains the complete applied state when lock cleanup fails', async () => {
    const { stageRoot } = await fixture();
    const restoreId = randomUUID();
    const backupId = randomUUID();
    const token = randomUUID();
    const dump = `database-${backupId}-${token}.dump`;
    await mkdir(stageRoot);
    await writeFile(join(stageRoot, dump), 'dump');
    await writeFile(join(stageRoot, 'restore.applied'), JSON.stringify({ version: 1, restoreId, backupId, token, dump }));
    await writeFile(join(stageRoot, 'restore.lock'), `${token}\n`);

    await expect(applyStagedSystemRestore({
      stageRoot,
      databaseUrl: 'postgresql://user:pass@db/app',
      removeFile: async () => { throw new Error('lock delete failed'); },
    })).rejects.toThrow('lock delete failed');
    expect(await readdir(stageRoot)).toEqual(expect.arrayContaining(['restore.applied', dump, 'restore.lock']));
  });

  it('returns false when normal startup has no restore marker', async () => {
    const { stageRoot } = await fixture();
    await mkdir(stageRoot);
    await expect(applyStagedSystemRestore({ stageRoot, databaseUrl: 'postgresql://user:pass@db/app' })).resolves.toBe(false);
  });
});
