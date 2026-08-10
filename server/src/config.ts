import { readFileSync } from 'node:fs';

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

export function loadConfig(): Config {
  const keyFile = process.env.GATEWAY_CONTROL_MASTER_KEY_FILE?.trim();
  const encodedKey = keyFile ? readFileSync(keyFile, 'utf8') : required('GATEWAY_CONTROL_MASTER_KEY');
  const webRoot = process.env.WEB_ROOT?.trim();
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
    systemBackupLocalRoot: process.env.GATEWAY_SYSTEM_BACKUP_LOCAL_ROOT?.trim() || '/opt/gateway-control/backups/system',
    systemBackupNasRoot: process.env.GATEWAY_SYSTEM_BACKUP_NAS_ROOT?.trim() || '/mnt/gateway-control-backups',
    systemBackupNasMarker: process.env.GATEWAY_SYSTEM_BACKUP_NAS_MARKER?.trim() || '.gateway-control-nas',
    systemRestoreStageRoot: process.env.GATEWAY_SYSTEM_RESTORE_STAGE_ROOT?.trim() || '/opt/gateway-control/backups/system/.restore-stage',
    ...(webRoot ? { webRoot } : {}),
  };
}
