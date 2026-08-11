import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream, createWriteStream, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import type { BackupTarget, Store, SystemBackup, SystemBackupImport, SystemRestore } from './types.js';

const MAGIC = Buffer.from('GCSYSBKP');
const FORMAT_VERSION = 1;
const HEADER_SIZE = MAGIC.length + 1 + 16 + 12;
const AUTH_TAG_SIZE = 16;
const MAX_TOOL_OUTPUT_BYTES = 8_192;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPECTED_ARCHIVE_FILES = ['manifest.json', 'database.dump', 'master.key'] as const;
export const SYSTEM_RESTORE_COMMAND = 'sh docker/recover.sh';

export type SystemRecoveryCode = 'incorrect_passphrase' | 'nas_unavailable' | 'restore_already_staged' | 'backup_mismatch' | 'invalid_backup' | 'import_active' | 'import_conflict' | 'import_too_large' | 'invalid_import' | 'recovery_supervisor_unavailable' | 'recovery_request_pending';

interface Manifest {
  format: 'gateway-control-system-backup';
  version: 1;
  backupId: string;
  createdAt: string;
  databaseDump: { file: 'database.dump'; sha256: string };
  masterKey: { file: 'master.key'; bytes: 32; sha256: string };
}

export interface ToolRunner {
  run(command: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<string>;
}

export interface SystemRecoveryService {
  createBackup(input: { requestedByUserId: string; target: BackupTarget; passphrase: string }): Promise<SystemBackup>;
  stageRestore(input: { backupId: string; requestedByUserId: string; passphrase: string }): Promise<{ restore: SystemRestore; manualRestoreRequired: true; restoreCommand: string }>;
  exportArtifact?(input: { backupId: string; requestedByUserId: string }): Promise<{ stream: Readable; size: number; filename: string }>;
  uploadImport?(input: { requestedByUserId: string; stream: Readable; contentLength: number }): Promise<SystemBackupImport>;
  validateImport?(input: { importId: string; requestedByUserId: string; passphrase: string }): Promise<{ importRecord: SystemBackupImport; backup: SystemBackup; idempotent: boolean }>;
  listImports?(): Promise<SystemBackupImport[]>;
  cleanupStaleImports?(): Promise<void>;
  requestApply?(input: { restoreId: string; requestedByUserId: string; confirmation: string; passphrase: string }): Promise<{ queued: true }>;
}

export class SystemRecoveryFailure extends Error {
  public constructor(public readonly statusCode: number, public readonly code: SystemRecoveryCode, message: string) {
    super(message);
    this.name = 'SystemRecoveryFailure';
  }
}

interface StagePublication {
  publish(restoreId: string): Promise<void>;
  rollback(): Promise<void>;
  release(): Promise<void>;
}

export class FileSystemRecoveryService implements SystemRecoveryService {
  private readonly toolRunner: ToolRunner;

  public constructor(private readonly options: {
    store: Store;
    databaseUrl: string;
    masterKey: Buffer;
    localRoot: string;
    nasRoot: string;
    nasMarker: string;
    stageRoot: string;
    maxImportBytes?: number;
    recoverySupervisorEnabled?: boolean;
    recoveryRequestSecret?: Buffer;
    toolRunner?: ToolRunner;
  }) {
    this.toolRunner = options.toolRunner ?? { run: runTool };
  }

  public async createBackup(input: { requestedByUserId: string; target: BackupTarget; passphrase: string }): Promise<SystemBackup> {
    const root = input.target === 'nas' ? this.options.nasRoot : this.options.localRoot;
    const artifactPath = join(root, `system-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.gcsb`);
    const record = await this.options.store.createSystemBackup(input.requestedByUserId, input.target, artifactPath);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'gateway-control-backup-'));
    const temporaryArtifact = `${artifactPath}.${randomUUID()}.tmp`;
    try {
      await this.ensureTarget(root, input.target);
      const dumpPath = join(temporaryDirectory, 'database.dump');
      await this.runPostgresTool('pg_dump', ['--format=custom', '--file', dumpPath]);
      await requireRegularFile(dumpPath, 'The database dump is invalid.');
      await chmod(dumpPath, 0o600);
      const keyPath = join(temporaryDirectory, 'master.key');
      await writeFile(keyPath, this.options.masterKey, { mode: 0o600, flag: 'wx' });
      const manifest: Manifest = {
        format: 'gateway-control-system-backup', version: 1, backupId: record.id, createdAt: new Date().toISOString(),
        databaseDump: { file: 'database.dump', sha256: await sha256File(dumpPath) },
        masterKey: { file: 'master.key', bytes: 32, sha256: createHash('sha256').update(this.options.masterKey).digest('hex') },
      };
      await writeFile(join(temporaryDirectory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
      const bundlePath = join(temporaryDirectory, 'bundle.tar');
      await this.toolRunner.run('tar', ['-cf', bundlePath, '-C', temporaryDirectory, ...EXPECTED_ARCHIVE_FILES], toolEnvironment());
      await requireRegularFile(bundlePath, 'The backup archive is invalid.');
      await chmod(bundlePath, 0o600);
      await encryptFile(bundlePath, temporaryArtifact, input.passphrase);
      await chmod(temporaryArtifact, 0o600);
      await rename(temporaryArtifact, artifactPath);
      const artifact = await requireRegularFile(artifactPath, 'The encrypted backup artifact is invalid.');
      return await this.options.store.completeSystemBackup(record.id, artifact.size, await sha256File(artifactPath));
    } catch (error) {
      await rm(temporaryArtifact, { force: true }).catch(() => undefined);
      await this.options.store.failSystemBackup(record.id, 'System backup creation failed.').catch(() => undefined);
      if (error instanceof SystemRecoveryFailure) throw error;
      throw new SystemRecoveryFailure(500, 'invalid_backup', 'The system backup could not be created.');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  public async stageRestore(input: { backupId: string; requestedByUserId: string; passphrase: string }): Promise<{ restore: SystemRestore; manualRestoreRequired: true; restoreCommand: string }> {
    const backup = await this.options.store.getSystemBackup(input.backupId);
    if (!backup) throw new SystemRecoveryFailure(404, 'invalid_backup', 'The selected system backup is unavailable.');
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'gateway-control-restore-'));
    let publication: StagePublication | undefined;
    let restore: SystemRestore | undefined;
    try {
      const artifact = await requireRegularFile(backup.artifactPath, 'The encrypted backup artifact is invalid.');
      if (!backup.checksum || !/^[a-f0-9]{64}$/.test(backup.checksum) || artifact.size !== backup.sizeBytes || await sha256File(backup.artifactPath) !== backup.checksum) {
        throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
      }
      const bundlePath = join(temporaryDirectory, 'bundle.tar');
      await decryptFile(backup.artifactPath, bundlePath, input.passphrase);
      await this.validateArchive(bundlePath);
      await this.toolRunner.run('tar', ['-xf', bundlePath, '-C', temporaryDirectory, ...EXPECTED_ARCHIVE_FILES], toolEnvironment());
      await validateExtractedFiles(temporaryDirectory);
      const manifest = parseManifest(await readFile(join(temporaryDirectory, 'manifest.json'), 'utf8'));
      if (manifest.backupId !== input.backupId) throw new SystemRecoveryFailure(400, 'backup_mismatch', 'The selected backup does not match this recovery request.');
      const restoredKey = await readFile(join(temporaryDirectory, 'master.key'));
      if (restoredKey.length !== 32 || !timingSafeEqual(restoredKey, this.options.masterKey)) {
        throw new SystemRecoveryFailure(400, 'backup_mismatch', 'The selected backup belongs to a different GatewayControl instance.');
      }
      if (manifest.masterKey.sha256 !== createHash('sha256').update(restoredKey).digest('hex')
        || manifest.databaseDump.sha256 !== await sha256File(join(temporaryDirectory, 'database.dump'))) {
        throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
      }
      await this.toolRunner.run('pg_restore', ['--list', join(temporaryDirectory, 'database.dump')], toolEnvironment());
      publication = await this.prepareStage(join(temporaryDirectory, 'database.dump'), {
        id: input.backupId,
        sizeBytes: backup.sizeBytes,
        checksum: backup.checksum,
      });
      restore = await this.options.store.createSystemRestore(input.backupId, input.requestedByUserId, 'staging');
      await publication.publish(restore.id);
      restore = await this.options.store.updateSystemRestore(restore.id, 'staged');
      publication = undefined;
      return { restore, manualRestoreRequired: true, restoreCommand: SYSTEM_RESTORE_COMMAND };
    } catch (error) {
      const failure = recoveryFailure(error);
      if (publication) {
        await publication.rollback().catch(() => undefined);
        if (restore) await this.options.store.updateSystemRestore(restore.id, 'failed', failure.code).catch(() => undefined);
        await publication.release().catch(() => undefined);
      } else if (!restore) {
        await this.options.store.createSystemRestore(input.backupId, input.requestedByUserId, 'failed', failure.code).catch(() => undefined);
      }
      throw failure;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  public async exportArtifact(input: { backupId: string; requestedByUserId: string }): Promise<{ stream: Readable; size: number; filename: string }> {
    const backup = await this.options.store.getSystemBackup(input.backupId);
    if (!backup || !backup.checksum || backup.sizeBytes === null) throw new SystemRecoveryFailure(404, 'invalid_backup', 'The selected system backup is unavailable.');
    const root = backup.target === 'nas' ? this.options.nasRoot : this.options.localRoot;
    const handle = await openArtifactNoFollow(root, backup.artifactPath);
    try {
      const before = await handle.stat();
      const checksum = await sha256Handle(handle, before.size);
      const after = await handle.stat();
      if (!sameFile(before, after) || after.size !== backup.sizeBytes || checksum !== backup.checksum) {
        throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
      }
      await this.options.store.recordSystemBackupTransferEvent({ requestedByUserId: input.requestedByUserId, operation: 'export', backupId: backup.id, metadata: { sizeBytes: after.size, checksum: backup.checksum } });
      return { stream: handle.createReadStream({ autoClose: true, start: 0 }), size: after.size, filename: `gateway-control-system-${backup.id}.gcsb` };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  public async uploadImport(input: { requestedByUserId: string; stream: Readable; contentLength: number }): Promise<SystemBackupImport> {
    const maxBytes = this.options.maxImportBytes ?? 10 * 1024 ** 3;
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0 || input.contentLength > maxBytes) {
      throw new SystemRecoveryFailure(413, 'import_too_large', 'The system backup import exceeds the configured size limit.');
    }
    await this.ensureTarget(this.options.localRoot, 'local');
    const quarantineRoot = join(this.options.localRoot, '.imports');
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    const quarantineStat = await lstat(quarantineRoot);
    if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()) throw new SystemRecoveryFailure(400, 'invalid_import', 'The backup import quarantine is invalid.');
    const token = randomUUID();
    const partialPath = join(quarantineRoot, `${token}.partial`);
    const artifactPath = join(quarantineRoot, `${token}.gcsb`);
    const importRecord = await this.options.store.createSystemBackupImport(input.requestedByUserId, artifactPath);
    if (importRecord === 'active') throw new SystemRecoveryFailure(409, 'import_active', 'Another system backup import is active.');
    const hash = createHash('sha256');
    let size = 0;
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes || size > input.contentLength) return callback(new SystemRecoveryFailure(413, 'import_too_large', 'The system backup import exceeds the configured size limit.'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    try {
      await pipeline(input.stream, counter, createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }));
      if (size !== input.contentLength) throw new SystemRecoveryFailure(400, 'invalid_import', 'The system backup upload was truncated.');
      const handle = await open(partialPath, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(partialPath, artifactPath);
      await syncDirectory(quarantineRoot);
      return await this.options.store.updateSystemBackupImport(importRecord.id, 'uploaded', { sizeBytes: size, checksum: hash.digest('hex') });
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined);
      await rm(artifactPath, { force: true }).catch(() => undefined);
      await this.options.store.updateSystemBackupImport(importRecord.id, 'rejected', { error: error instanceof SystemRecoveryFailure ? error.code : 'upload_failed' }).catch(() => undefined);
      throw error;
    }
  }

  public async validateImport(input: { importId: string; requestedByUserId: string; passphrase: string }): Promise<{ importRecord: SystemBackupImport; backup: SystemBackup; idempotent: boolean }> {
    const claimed = await this.options.store.claimSystemBackupImport(input.importId, input.requestedByUserId);
    if (claimed === 'validating') throw new SystemRecoveryFailure(409, 'import_active', 'The system backup import is already being validated.');
    if (!claimed || claimed.sizeBytes === null || !claimed.checksum) throw new SystemRecoveryFailure(404, 'invalid_import', 'The system backup import is unavailable.');
    const importRecord = claimed;
    try {
      const artifact = await requireRegularFile(importRecord.quarantinePath, 'The imported backup artifact is invalid.');
      if (artifact.size !== importRecord.sizeBytes || await sha256File(importRecord.quarantinePath) !== importRecord.checksum) throw new SystemRecoveryFailure(400, 'invalid_import', 'The imported backup artifact is invalid.');
      const manifest = await this.inspectArtifact(importRecord.quarantinePath, input.passphrase);
      const existing = await this.options.store.getSystemBackup(manifest.backupId);
      if (existing) {
        if (existing.checksum !== importRecord.checksum || existing.sizeBytes !== importRecord.sizeBytes) throw new SystemRecoveryFailure(409, 'import_conflict', 'A different system backup already uses the authenticated backup identifier.');
        await rm(importRecord.quarantinePath, { force: true });
        const completed = await this.options.store.finishSystemBackupImport(importRecord.id, importRecord.validationRevision, 'imported', { backupId: existing.id });
        if (!completed) throw new Error('The system backup import validation claim was lost.');
        await this.options.store.recordSystemBackupTransferEvent({ requestedByUserId: input.requestedByUserId, operation: 'import', backupId: existing.id, importId: importRecord.id, metadata: { idempotent: true } });
        return { importRecord: completed, backup: existing, idempotent: true };
      }
      const destination = join(this.options.localRoot, `imported-${manifest.backupId}.gcsb`);
      if (await lstat(destination).catch(() => null)) throw new SystemRecoveryFailure(409, 'import_conflict', 'The imported backup destination is already occupied.');
      await rename(importRecord.quarantinePath, destination);
      await syncDirectory(this.options.localRoot);
      const result = await this.options.store.importSystemBackup({ id: manifest.backupId, requestedByUserId: input.requestedByUserId, artifactPath: destination, sizeBytes: importRecord.sizeBytes, checksum: importRecord.checksum, importId: importRecord.id });
      if (result === 'conflict') { await rm(destination, { force: true }); throw new SystemRecoveryFailure(409, 'import_conflict', 'A different system backup already uses the authenticated backup identifier.'); }
      if (result === 'idempotent') await rm(destination, { force: true });
      const backup = await this.options.store.getSystemBackup(manifest.backupId);
      if (!backup) throw new Error('The imported backup record could not be loaded.');
      const completed = await this.options.store.finishSystemBackupImport(importRecord.id, importRecord.validationRevision, 'imported', { backupId: backup.id });
      if (!completed) throw new Error('The system backup import validation claim was lost.');
      await this.options.store.recordSystemBackupTransferEvent({ requestedByUserId: input.requestedByUserId, operation: 'import', backupId: backup.id, importId: importRecord.id, metadata: { idempotent: result === 'idempotent' } });
      return { importRecord: completed, backup, idempotent: result === 'idempotent' };
    } catch (error) {
      await rm(importRecord.quarantinePath, { force: true }).catch(() => undefined);
      const failure = recoveryFailure(error);
      await this.options.store.finishSystemBackupImport(importRecord.id, importRecord.validationRevision, 'rejected', { error: failure.code }).catch(() => undefined);
      throw failure;
    }
  }

  public async listImports(): Promise<SystemBackupImport[]> { return this.options.store.listSystemBackupImports(); }

  public async cleanupStaleImports(): Promise<void> {
    for (const item of await this.options.store.rejectStaleSystemBackupImports(new Date(Date.now() - 24 * 60 * 60_000))) {
      await rm(item.quarantinePath, { force: true }).catch(() => undefined);
    }
    const quarantineRoot = join(this.options.localRoot, '.imports');
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const name of await readdir(quarantineRoot).catch(() => [])) {
      if (!UUID_PATTERN.test(name.replace(/\.partial$/, '')) || !name.endsWith('.partial')) continue;
      const path = join(quarantineRoot, name);
      const stat = await lstat(path).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) await rm(path, { force: true });
    }
  }

  public async requestApply(input: { restoreId: string; requestedByUserId: string; confirmation: string; passphrase: string }): Promise<{ queued: true }> {
    if (!this.options.recoverySupervisorEnabled || !this.options.recoveryRequestSecret) throw new SystemRecoveryFailure(409, 'recovery_supervisor_unavailable', 'Platform-assisted recovery is not configured.');
    if (input.confirmation !== `APPLY ${input.restoreId}`) throw new SystemRecoveryFailure(400, 'invalid_backup', 'The restore confirmation does not match.');
    const restore = await this.options.store.getSystemRestore(input.restoreId);
    if (!restore || restore.status !== 'staged') throw new SystemRecoveryFailure(404, 'invalid_backup', 'The staged system restore is unavailable.');
    const backup = await this.options.store.getSystemBackup(restore.backupId);
    if (!backup) throw new SystemRecoveryFailure(404, 'invalid_backup', 'The selected system backup is unavailable.');
    const artifact = await requireRegularFile(backup.artifactPath, 'The encrypted backup artifact is invalid.');
    if (!backup.checksum || backup.sizeBytes === null || artifact.size !== backup.sizeBytes || await sha256File(backup.artifactPath) !== backup.checksum) throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
    await this.inspectArtifact(backup.artifactPath, input.passphrase, backup.id);
    const requestRoot = join(this.options.localRoot, '.recovery-requests');
    await mkdir(requestRoot, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(requestRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new SystemRecoveryFailure(400, 'invalid_backup', 'The recovery request spool is invalid.');
    const unsigned = JSON.stringify({ version: 1, operation: 'apply-system-restore', restoreId: restore.id });
    const request = `${JSON.stringify({ version: 1, operation: 'apply-system-restore', restoreId: restore.id, signature: createHmac('sha256', this.options.recoveryRequestSecret).update(unsigned).digest('hex') })}\n`;
    const ownershipToken = randomUUID();
    const audit = await this.options.store.createSystemRecoveryRequest(restore.id, input.requestedByUserId, ownershipToken);
    if (audit === 'active') throw new SystemRecoveryFailure(409, 'recovery_request_pending', 'A platform recovery request is already pending.');
    let publishedOwnershipToken: string;
    try {
      publishedOwnershipToken = await publishRecoveryRequest(requestRoot, request, ownershipToken);
    } catch (error) {
      const failure = (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? new SystemRecoveryFailure(409, 'recovery_request_pending', 'A platform recovery request is already pending.')
        : recoveryFailure(error);
      await this.options.store.finishSystemRecoveryRequest(audit.id, ownershipToken, 'failed', failure.code).catch(() => undefined);
      throw failure;
    }
    await this.options.store.finishSystemRecoveryRequest(audit.id, publishedOwnershipToken, 'published').catch(() => false);
    await this.options.store.recordSystemBackupTransferEvent({ requestedByUserId: input.requestedByUserId, operation: 'restore_apply_requested', backupId: backup.id, restoreId: restore.id }).catch(() => undefined);
    return { queued: true };
  }

  private async inspectArtifact(path: string, passphrase: string, expectedBackupId?: string): Promise<Manifest> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'gateway-control-inspect-'));
    try {
      const bundlePath = join(temporaryDirectory, 'bundle.tar');
      await decryptFile(path, bundlePath, passphrase);
      await this.validateArchive(bundlePath);
      await this.toolRunner.run('tar', ['-xf', bundlePath, '-C', temporaryDirectory, ...EXPECTED_ARCHIVE_FILES], toolEnvironment());
      await validateExtractedFiles(temporaryDirectory);
      const manifest = parseManifest(await readFile(join(temporaryDirectory, 'manifest.json'), 'utf8'));
      if (expectedBackupId && manifest.backupId !== expectedBackupId) throw new SystemRecoveryFailure(400, 'backup_mismatch', 'The selected backup does not match this recovery request.');
      const restoredKey = await readFile(join(temporaryDirectory, 'master.key'));
      if (restoredKey.length !== 32 || !timingSafeEqual(restoredKey, this.options.masterKey)) throw new SystemRecoveryFailure(400, 'backup_mismatch', 'The selected backup belongs to a different GatewayControl instance.');
      if (manifest.masterKey.sha256 !== createHash('sha256').update(restoredKey).digest('hex') || manifest.databaseDump.sha256 !== await sha256File(join(temporaryDirectory, 'database.dump'))) throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
      await this.toolRunner.run('pg_restore', ['--list', join(temporaryDirectory, 'database.dump')], toolEnvironment());
      return manifest;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async validateArchive(bundlePath: string): Promise<void> {
    const names = splitToolLines(await this.toolRunner.run('tar', ['-tf', bundlePath], toolEnvironment()));
    const verbose = splitToolLines(await this.toolRunner.run('tar', ['-tvf', bundlePath], toolEnvironment()));
    if (names.length !== EXPECTED_ARCHIVE_FILES.length || verbose.length !== names.length || new Set(names).size !== names.length
      || names.some((name) => !EXPECTED_ARCHIVE_FILES.includes(name as typeof EXPECTED_ARCHIVE_FILES[number]))) {
      throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
    }
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      const detail = verbose[index]!;
      if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || detail[0] !== '-' || !detail.endsWith(name)) {
        throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
      }
    }
  }

  private async ensureTarget(root: string, target: BackupTarget): Promise<void> {
    if (target === 'local') {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await lstat(root);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('The local backup root is invalid.');
      return;
    }
    const rootStat = await lstat(root).catch(() => null);
    const marker = await lstat(join(root, this.options.nasMarker)).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !marker?.isFile() || marker.isSymbolicLink()) {
      throw new SystemRecoveryFailure(409, 'nas_unavailable', 'The NAS backup target is unavailable.');
    }
  }

  private async prepareStage(sourceDump: string, backup: { id: string; sizeBytes: number; checksum: string }): Promise<StagePublication> {
    const backupId = backup.id;
    if (!UUID_PATTERN.test(backupId)) throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
    await mkdir(this.options.stageRoot, { recursive: true, mode: 0o700 });
    const stageRoot = await lstat(this.options.stageRoot).catch(() => null);
    if (!stageRoot?.isDirectory() || stageRoot.isSymbolicLink()) throw new SystemRecoveryFailure(400, 'invalid_backup', 'The restore staging area is invalid.');
    const token = randomUUID();
    const lockPath = join(this.options.stageRoot, 'restore.lock');
    try {
      await writeFile(lockPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SystemRecoveryFailure(409, 'restore_already_staged', 'A system restore is already staged or being staged.');
      throw error;
    }
    const markerPath = join(this.options.stageRoot, 'restore.pending');
    const dumpName = `database-${backupId}-${token}.dump`;
    const dumpPath = join(this.options.stageRoot, dumpName);
    const temporaryMarker = join(this.options.stageRoot, `restore.pending.${token}.tmp`);
    let dumpCreated = false;
    let markerPublished = false;
    const removeOwnedLock = async (): Promise<void> => {
      if ((await readFile(lockPath, 'utf8').catch(() => '')) === `${token}\n`) await rm(lockPath, { force: true });
    };
    const rollback = async (): Promise<void> => {
      if (markerPublished) {
        const markerValue = await readFile(markerPath, 'utf8').catch(() => '');
        try {
          const metadata = JSON.parse(markerValue) as { token?: unknown };
          if (metadata.token === token) await rm(markerPath, { force: true });
        } catch {
          // A marker not owned by this attempt is left untouched.
        }
      }
      await rm(temporaryMarker, { force: true });
      if (dumpCreated) await rm(dumpPath, { force: true });
    };
    try {
      const activeMarkers = ['restore.pending', 'restore.applying', 'restore.applied'];
      if ((await Promise.all(activeMarkers.map((name) => lstat(join(this.options.stageRoot, name)).then(() => true, () => false)))).some(Boolean)) {
        throw new SystemRecoveryFailure(409, 'restore_already_staged', 'A system restore is already staged or being staged.');
      }
      const dumpHandle = await open(dumpPath, 'wx', 0o600);
      dumpCreated = true;
      await pipeline(createReadStream(sourceDump), dumpHandle.createWriteStream());
      return {
        publish: async (restoreId: string): Promise<void> => {
          if (!UUID_PATTERN.test(restoreId)) throw new Error('The system restore audit record is invalid.');
          await writeFile(temporaryMarker, `${JSON.stringify({
            version: 2,
            restoreId,
            backupId,
            backupSizeBytes: backup.sizeBytes,
            backupChecksum: backup.checksum,
            dump: dumpName,
            token,
          })}\n`, { mode: 0o600, flag: 'wx' });
          await rename(temporaryMarker, markerPath);
          markerPublished = true;
        },
        rollback,
        release: removeOwnedLock,
      };
    } catch (error) {
      await rollback().catch(() => undefined);
      await removeOwnedLock().catch(() => undefined);
      throw error;
    }
  }

  private async runPostgresTool(command: string, args: string[]): Promise<string> {
    const database = new URL(this.options.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
    return await this.toolRunner.run(command, args, postgresEnvironment(database));
  }
}

async function encryptFile(source: string, destination: string, passphrase: string): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv]);
  const key = await deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    const output = createWriteStream(destination, { mode: 0o600, flags: 'wx' });
    output.write(header);
    await pipeline(createReadStream(source), cipher, output, { end: false });
    await new Promise<void>((resolve, reject) => output.end(cipher.getAuthTag(), (error?: Error | null) => error ? reject(error) : resolve()));
  } finally {
    key.fill(0);
  }
}

async function decryptFile(source: string, destination: string, passphrase: string): Promise<void> {
  const sourceStat = await requireRegularFile(source, 'The encrypted backup artifact is invalid.');
  if (sourceStat.size <= HEADER_SIZE + AUTH_TAG_SIZE) throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
  const handle = await open(source, 'r');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    const tag = Buffer.alloc(AUTH_TAG_SIZE);
    await handle.read(header, 0, HEADER_SIZE, 0);
    await handle.read(tag, 0, AUTH_TAG_SIZE, sourceStat.size - AUTH_TAG_SIZE);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== FORMAT_VERSION) {
      throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
    }
    const key = await deriveKey(passphrase, header.subarray(MAGIC.length + 1, MAGIC.length + 17));
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length + 17));
      decipher.setAAD(header);
      decipher.setAuthTag(tag);
      await pipeline(createReadStream(source, { start: HEADER_SIZE, end: sourceStat.size - AUTH_TAG_SIZE - 1 }), decipher, createWriteStream(destination, { mode: 0o600, flags: 'wx' }));
    } finally {
      key.fill(0);
    }
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    if (error instanceof Error && /authenticate|auth tag/i.test(error.message)) {
      throw new SystemRecoveryFailure(400, 'incorrect_passphrase', 'The backup passphrase is incorrect.');
    }
    throw error;
  } finally {
    await handle.close();
  }
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function openArtifactNoFollow(root: string, artifactPath: string): Promise<FileHandle> {
  try {
    const resolvedRoot = await realpath(resolve(root));
    const resolvedParent = await realpath(dirname(resolve(artifactPath)));
    const parentRelative = relative(resolvedRoot, resolvedParent);
    if (parentRelative === '..' || parentRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(parentRelative)) throw new Error('outside root');
    const handle = await open(join(resolvedParent, basename(artifactPath)), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      throw new Error('not regular');
    }
    return handle;
  } catch {
    throw new SystemRecoveryFailure(400, 'invalid_backup', 'The encrypted backup artifact is invalid.');
  }
}

async function sha256Handle(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead === 0) throw new SystemRecoveryFailure(400, 'invalid_backup', 'The encrypted backup artifact changed during verification.');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function publishRecoveryRequest(requestRoot: string, request: string, ownershipToken: string): Promise<string> {
  const temporaryPath = join(requestRoot, `request.${ownershipToken}.partial`);
  const pendingPath = join(requestRoot, 'request.pending');
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try { await handle.writeFile(request); await handle.sync(); } finally { await handle.close(); }
    await link(temporaryPath, pendingPath);
    await rm(temporaryPath);
    await syncDirectory(requestRoot);
    return ownershipToken;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  } finally {
    await handle.close();
  }
}

async function requireRegularFile(path: string, message: string): Promise<import('node:fs').Stats> {
  const value = await lstat(path).catch(() => null);
  if (!value?.isFile() || value.isSymbolicLink()) throw new SystemRecoveryFailure(400, 'invalid_backup', message);
  return value;
}

function splitToolLines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}

function toolEnvironment(): NodeJS.ProcessEnv {
  return allowlistedEnvironment(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']);
}

export function postgresEnvironment(database: URL): NodeJS.ProcessEnv {
  return {
    ...toolEnvironment(),
    PGHOST: database.hostname,
    PGPORT: database.port || '5432',
    PGDATABASE: database.pathname.slice(1),
    PGUSER: decodeURIComponent(database.username),
    PGPASSWORD: decodeURIComponent(database.password),
    ...(database.searchParams.get('sslmode') ? { PGSSLMODE: database.searchParams.get('sslmode')! } : {}),
  };
}

function allowlistedEnvironment(names: string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

function runTool(command: string, args: string[], environment: NodeJS.ProcessEnv = toolEnvironment()): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (output.length < MAX_TOOL_OUTPUT_BYTES) output += chunk.slice(0, MAX_TOOL_OUTPUT_BYTES - output.length); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (errorOutput.length < MAX_TOOL_OUTPUT_BYTES) errorOutput += chunk.slice(0, MAX_TOOL_OUTPUT_BYTES - errorOutput.length); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${basename(command)} failed${errorOutput.trim() ? `: ${errorOutput.trim()}` : '.'}`)));
  });
}

function parseManifest(value: string): Manifest {
  let parsed: Partial<Manifest>;
  try {
    parsed = JSON.parse(value) as Partial<Manifest>;
  } catch {
    throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
  }
  if (!hasExactKeys(parsed, ['format', 'version', 'backupId', 'createdAt', 'databaseDump', 'masterKey'])
    || !hasExactKeys(parsed.databaseDump, ['file', 'sha256']) || !hasExactKeys(parsed.masterKey, ['file', 'bytes', 'sha256'])
    || parsed.format !== 'gateway-control-system-backup' || parsed.version !== 1 || !UUID_PATTERN.test(parsed.backupId ?? '')
    || typeof parsed.createdAt !== 'string' || !isCanonicalTimestamp(parsed.createdAt)
    || parsed.databaseDump?.file !== 'database.dump' || !/^[a-f0-9]{64}$/.test(parsed.databaseDump.sha256 ?? '')
    || parsed.masterKey?.file !== 'master.key' || parsed.masterKey.bytes !== 32 || !/^[a-f0-9]{64}$/.test(parsed.masterKey.sha256 ?? '')) {
    throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
  }
  return parsed as Manifest;
}

function hasExactKeys(value: unknown, keys: string[]): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

async function validateExtractedFiles(directory: string): Promise<void> {
  const manifest = await requireRegularFile(join(directory, 'manifest.json'), 'The backup archive is invalid.');
  const database = await requireRegularFile(join(directory, 'database.dump'), 'The backup archive is invalid.');
  const masterKey = await requireRegularFile(join(directory, 'master.key'), 'The backup archive is invalid.');
  if (manifest.size < 2 || manifest.size > 16_384 || database.size < 1 || masterKey.size !== 32) throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
}

function recoveryFailure(error: unknown): SystemRecoveryFailure {
  return error instanceof SystemRecoveryFailure
    ? error
    : new SystemRecoveryFailure(500, 'invalid_backup', 'The system restore could not be staged.');
}
