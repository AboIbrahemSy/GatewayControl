import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  masterKey: Buffer;
  secureCookie: boolean;
  sessionTtlHours: number;
  trustProxy: boolean;
  webRoot?: string;
  agentImage: string;
  traefikDynamicVolume: string;
  systemBackupLocalRoot: string;
  systemBackupNasRoot: string;
  systemBackupNasMarker: string;
  systemRestoreStageRoot: string;
  release: string;
  protectedProjects: string[];
}

const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function parseProtectedProjects(value: string | undefined): string[] {
  const projects = ['gateway-control', ...(value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [])];
  const unique = [...new Set(projects)];
  if (unique.length > 20 || unique.some((project) => !COMPOSE_PROJECT_PATTERN.test(project))) {
    throw new Error('GATEWAY_PROTECTED_PROJECTS must contain at most 20 valid comma-separated Compose project names.');
  }
  return unique;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function decodeMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[a-f\d]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('The configured master key must be 32 bytes encoded as base64 or hex.');
  }
  return key;
}

export function validateRestoreStageRoot(localRoot: string, stageRoot: string): string {
  const pathApi = localRoot.startsWith('/') ? posix : win32;
  if (!pathApi.isAbsolute(localRoot) || !pathApi.isAbsolute(stageRoot)) {
    throw new Error('GATEWAY_SYSTEM_BACKUP_LOCAL_ROOT and GATEWAY_SYSTEM_RESTORE_STAGE_ROOT must be absolute paths.');
  }
  const resolvedLocalRoot = pathApi.resolve(localRoot);
  const resolvedStageRoot = pathApi.resolve(stageRoot);
  const stageRelativePath = pathApi.relative(resolvedLocalRoot, resolvedStageRoot);
  if (!stageRelativePath || stageRelativePath === '..' || stageRelativePath.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(stageRelativePath)) {
    throw new Error('GATEWAY_SYSTEM_RESTORE_STAGE_ROOT must resolve inside GATEWAY_SYSTEM_BACKUP_LOCAL_ROOT and must not equal it.');
  }
  return resolvedStageRoot;
}

export function loadConfig(): Config {
  const keyFile = process.env.GATEWAY_CONTROL_MASTER_KEY_FILE?.trim();
  const encodedKey = keyFile ? readFileSync(keyFile, 'utf8') : required('GATEWAY_CONTROL_MASTER_KEY');
  const webRoot = process.env.WEB_ROOT?.trim();
  const systemBackupLocalRoot = process.env.GATEWAY_SYSTEM_BACKUP_LOCAL_ROOT?.trim() || '/opt/gateway-control/backups/system';
  const systemRestoreStageRoot = process.env.GATEWAY_SYSTEM_RESTORE_STAGE_ROOT?.trim() || '/opt/gateway-control/backups/system/.restore-stage';
  return {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: Number(process.env.PORT || 3000),
    databaseUrl: required('DATABASE_URL'),
    masterKey: decodeMasterKey(encodedKey),
    secureCookie: process.env.SESSION_COOKIE_SECURE !== 'false',
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 24),
    trustProxy: process.env.TRUST_PROXY === 'true',
    agentImage: process.env.GATEWAY_AGENT_IMAGE?.trim() || 'ghcr.io/gatewaycontrol/gateway-agent:latest',
    traefikDynamicVolume: process.env.GATEWAY_TRAEFIK_DYNAMIC_VOLUME?.trim() || 'gateway-traefik-dynamic',
    systemBackupLocalRoot,
    systemBackupNasRoot: process.env.GATEWAY_SYSTEM_BACKUP_NAS_ROOT?.trim() || '/mnt/gateway-control-backups',
    systemBackupNasMarker: process.env.GATEWAY_SYSTEM_BACKUP_NAS_MARKER?.trim() || '.gateway-control-nas',
    systemRestoreStageRoot: validateRestoreStageRoot(systemBackupLocalRoot, systemRestoreStageRoot),
    release: process.env.GATEWAY_CONTROL_RELEASE?.trim() || 'unknown',
    protectedProjects: parseProtectedProjects(process.env.GATEWAY_PROTECTED_PROJECTS),
    ...(webRoot ? { webRoot } : {}),
  };
}
