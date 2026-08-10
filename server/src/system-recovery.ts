import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import type { BackupTarget, Store, SystemBackup, SystemRestore } from './types.js';

const MAGIC = Buffer.from('GCSYSBKP');
const FORMAT_VERSION = 1;
const HEADER_SIZE = MAGIC.length + 1 + 16 + 12;
const AUTH_TAG_SIZE = 16;
const MAX_TOOL_OUTPUT_BYTES = 8_192;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPECTED_ARCHIVE_FILES = ['manifest.json', 'database.dump', 'master.key'] as const;
export const SYSTEM_RESTORE_COMMAND = 'sh docker/recover.sh';

export type SystemRecoveryCode = 'incorrect_passphrase' | 'nas_unavailable' | 'restore_already_staged' | 'backup_mismatch' | 'invalid_backup';

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
      for (const name of EXPECTED_ARCHIVE_FILES) await requireRegularFile(join(temporaryDirectory, name), 'The backup archive is invalid.');
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
      publication = await this.prepareStage(join(temporaryDirectory, 'database.dump'), input.backupId);
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

  private async prepareStage(sourceDump: string, backupId: string): Promise<StagePublication> {
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
          await writeFile(temporaryMarker, `${JSON.stringify({ version: 1, restoreId, backupId, dump: dumpName, token })}\n`, { mode: 0o600, flag: 'wx' });
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
  if (parsed.format !== 'gateway-control-system-backup' || parsed.version !== 1 || !UUID_PATTERN.test(parsed.backupId ?? '')
    || parsed.databaseDump?.file !== 'database.dump' || !/^[a-f0-9]{64}$/.test(parsed.databaseDump.sha256 ?? '')
    || parsed.masterKey?.file !== 'master.key' || parsed.masterKey.bytes !== 32 || !/^[a-f0-9]{64}$/.test(parsed.masterKey.sha256 ?? '')) {
    throw new SystemRecoveryFailure(400, 'invalid_backup', 'The selected system backup is invalid.');
  }
  return parsed as Manifest;
}

function recoveryFailure(error: unknown): SystemRecoveryFailure {
  return error instanceof SystemRecoveryFailure
    ? error
    : new SystemRecoveryFailure(500, 'invalid_backup', 'The system restore could not be staged.');
}
