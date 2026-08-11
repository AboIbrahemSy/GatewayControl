import { spawn } from 'node:child_process';
import { lstat, readFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { postgresEnvironment, type ToolRunner } from './system-recovery.js';
import { validateRestoreStageRoot } from './config.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TOOL_OUTPUT_BYTES = 8_192;

interface RestoreMarker {
  version: 1 | 2;
  restoreId: string;
  backupId: string;
  dump: string;
  token: string;
  backupSizeBytes?: number;
  backupChecksum?: string;
}

export async function applyStagedSystemRestore(options: {
  stageRoot: string;
  databaseUrl: string;
  toolRunner?: ToolRunner;
  finalizeBackup?: (databaseUrl: string, metadata: RestoreMarker) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  renameFile?: (source: string, destination: string) => Promise<void>;
}): Promise<boolean> {
  const stage = await lstat(options.stageRoot).catch(() => null);
  if (!stage) return false;
  if (!stage.isDirectory() || stage.isSymbolicLink()) throw new Error('The system restore staging root is invalid.');
  const markerNames = ['restore.pending', 'restore.applying', 'restore.applied'] as const;
  const markers = await Promise.all(markerNames.map(async (name) => ({ name, stat: await lstat(join(options.stageRoot, name)).catch(() => null) })));
  const activeMarkers = markers.filter(({ stat }) => stat !== null);
  if (activeMarkers.length === 0) return false;
  if (activeMarkers.length !== 1) throw new Error('The system restore staging area contains conflicting state markers.');
  const markerName = activeMarkers[0]!.name;
  let markerPath = join(options.stageRoot, markerName);
  const marker = activeMarkers[0]!.stat;
  if (!marker?.isFile() || marker.isSymbolicLink()) throw new Error('The staged system restore marker is invalid.');
  const metadata = JSON.parse(await readFile(markerPath, 'utf8')) as Partial<RestoreMarker>;
  if (![1, 2].includes(metadata.version as number) || typeof metadata.restoreId !== 'string' || !UUID_PATTERN.test(metadata.restoreId)
    || typeof metadata.backupId !== 'string' || !UUID_PATTERN.test(metadata.backupId)
    || typeof metadata.token !== 'string' || !UUID_PATTERN.test(metadata.token)
    || typeof metadata.dump !== 'string' || basename(metadata.dump) !== metadata.dump
    || (metadata.version === 2 && (!Number.isSafeInteger(metadata.backupSizeBytes) || Number(metadata.backupSizeBytes) < 1
      || typeof metadata.backupChecksum !== 'string' || !CHECKSUM_PATTERN.test(metadata.backupChecksum)))
    || metadata.dump !== `database-${metadata.backupId}-${metadata.token}.dump`) throw new Error('The staged system restore marker is unsupported.');
  const restoreMetadata = metadata as RestoreMarker;
  const dumpPath = join(options.stageRoot, metadata.dump);
  const lockPath = join(options.stageRoot, 'restore.lock');
  const lock = await lstat(lockPath).catch(() => null);
  if ((markerName !== 'restore.applied' || lock)
    && (!lock?.isFile() || lock.isSymbolicLink() || await readFile(lockPath, 'utf8') !== `${metadata.token}\n`)) {
    throw new Error('The staged system restore lock is invalid.');
  }
  const removeFile = options.removeFile ?? ((path: string) => rm(path));
  const renameFile = options.renameFile ?? rename;
  const dump = await lstat(dumpPath).catch(() => null);
  if (!dump?.isFile() || dump.isSymbolicLink()) throw new Error('The staged system restore database dump is invalid.');
  if (markerName !== 'restore.applied') {
    if (markerName === 'restore.pending') {
      const applyingPath = join(options.stageRoot, 'restore.applying');
      await renameFile(markerPath, applyingPath);
      markerPath = applyingPath;
    }
    const database = new URL(options.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
    const args = ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '--dbname', database.pathname.slice(1), dumpPath];
    const runner = options.toolRunner ?? { run: runRestoreTool };
    await runner.run('pg_restore', args, postgresEnvironment(database));
    if (restoreMetadata.version === 2) {
      await (options.finalizeBackup ?? finalizeRestoredBackup)(options.databaseUrl, restoreMetadata);
    }
    const appliedPath = join(options.stageRoot, 'restore.applied');
    await renameFile(markerPath, appliedPath);
    markerPath = appliedPath;
  }

  // Removing the lock first cannot strand staging. The applied marker continues to block
  // publication until it is removed, and the dump becomes unreferenced only afterwards.
  if (lock) await removeFile(lockPath);
  await removeFile(markerPath);
  await removeFile(dumpPath);
  return true;
}

async function finalizeRestoredBackup(databaseUrl: string, metadata: RestoreMarker): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `UPDATE system_backups
       SET status = 'succeeded', size_bytes = $2, checksum = $3, error = NULL, completed_at = now()
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
      [metadata.backupId, metadata.backupSizeBytes, metadata.backupChecksum],
    );
    if (result.rowCount !== 1) throw new Error('The restored system backup record could not be finalized.');
  } finally {
    await client.end();
  }
}

function runRestoreTool(command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (output.length < MAX_TOOL_OUTPUT_BYTES) output += chunk.slice(0, MAX_TOOL_OUTPUT_BYTES - output.length); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (errorOutput.length < MAX_TOOL_OUTPUT_BYTES) errorOutput += chunk.slice(0, MAX_TOOL_OUTPUT_BYTES - errorOutput.length); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`pg_restore failed with exit code ${code ?? 'unknown'}${errorOutput.trim() ? `: ${errorOutput.trim()}` : '.'}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const localRoot = process.env.GATEWAY_SYSTEM_BACKUP_LOCAL_ROOT?.trim() || '/opt/gateway-control/backups/system';
  const stageRoot = validateRestoreStageRoot(localRoot, process.env.GATEWAY_SYSTEM_RESTORE_STAGE_ROOT?.trim() || '/opt/gateway-control/backups/system/.restore-stage');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required to apply a staged system restore.');
  if (!await applyStagedSystemRestore({ stageRoot, databaseUrl })) throw new Error('No pending, applying, or applied system restore marker exists.');
  console.log('Staged GatewayControl system restore completed.');
}
