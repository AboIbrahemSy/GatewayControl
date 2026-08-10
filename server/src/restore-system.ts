import { spawn } from 'node:child_process';
import { lstat, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { postgresEnvironment, type ToolRunner } from './system-recovery.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TOOL_OUTPUT_BYTES = 8_192;

export async function applyStagedSystemRestore(options: {
  stageRoot: string;
  databaseUrl: string;
  toolRunner?: ToolRunner;
  removeFile?: (path: string) => Promise<void>;
}): Promise<boolean> {
  const stage = await lstat(options.stageRoot).catch(() => null);
  if (!stage) return false;
  if (!stage.isDirectory() || stage.isSymbolicLink()) throw new Error('The system restore staging root is invalid.');
  const markerPath = join(options.stageRoot, 'restore.pending');
  const marker = await lstat(markerPath).catch(() => null);
  if (!marker) return false;
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('The staged system restore marker is invalid.');
  const metadata = JSON.parse(await readFile(markerPath, 'utf8')) as { version?: unknown; restoreId?: unknown; backupId?: unknown; dump?: unknown; token?: unknown };
  if (metadata.version !== 1 || typeof metadata.restoreId !== 'string' || !UUID_PATTERN.test(metadata.restoreId)
    || typeof metadata.backupId !== 'string' || !UUID_PATTERN.test(metadata.backupId)
    || typeof metadata.token !== 'string' || !UUID_PATTERN.test(metadata.token)
    || typeof metadata.dump !== 'string' || basename(metadata.dump) !== metadata.dump
    || metadata.dump !== `database-${metadata.backupId}-${metadata.token}.dump`) throw new Error('The staged system restore marker is unsupported.');
  const dumpPath = join(options.stageRoot, metadata.dump);
  const dump = await lstat(dumpPath).catch(() => null);
  if (!dump?.isFile() || dump.isSymbolicLink()) throw new Error('The staged system restore database dump is invalid.');
  const lockPath = join(options.stageRoot, 'restore.lock');
  const lock = await lstat(lockPath).catch(() => null);
  if (!lock?.isFile() || lock.isSymbolicLink() || await readFile(lockPath, 'utf8') !== `${metadata.token}\n`) {
    throw new Error('The staged system restore lock is invalid.');
  }
  const database = new URL(options.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  const args = ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '--dbname', database.pathname.slice(1), dumpPath];
  const runner = options.toolRunner ?? { run: runRestoreTool };
  await runner.run('pg_restore', args, postgresEnvironment(database));
  const removeFile = options.removeFile ?? ((path: string) => rm(path));
  await removeFile(markerPath);
  await removeFile(dumpPath);
  await removeFile(lockPath);
  return true;
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
  const stageRoot = process.env.GATEWAY_SYSTEM_RESTORE_STAGE_ROOT?.trim() || '/opt/gateway-control/backups/system/.restore-stage';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required to apply a staged system restore.');
  if (await applyStagedSystemRestore({ stageRoot, databaseUrl })) console.log('Staged GatewayControl system restore completed.');
}
