import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { SecretBox, hashPassword, hashToken, randomToken, verifyPassword } from './crypto.js';
import { CloudflareClient, CloudflareClientError, type CloudflareDnsRecord, type CloudflareIngressRule } from './cloudflare-client.js';
import { CloudflareTunnelTokenError, parseCloudflareTunnelToken, type ParsedCloudflareTunnelToken } from './cloudflare-tunnel-token.js';
import { NotificationDispatcher } from './notification-dispatcher.js';
import { SystemRecoveryFailure, type SystemRecoveryService } from './system-recovery.js';
import { OPERATIONAL_EVENT_TYPES, type Agent, type AgentCommand, type Role, type StackBackup, type StackRestore, type Store, type SystemBackup, type SystemRestore, type User } from './types.js';

const SESSION_COOKIE = 'gateway_control_session';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$/i;
const USER_COMMAND_TYPES = new Set(['ping', 'docker.info', 'agent.diagnostics.run']);
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DOCKER_VOLUME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/;
const MAX_TELEMETRY_BYTES = 512 * 1024;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EVENT_TYPES = new Set<string>(OPERATIONAL_EVENT_TYPES);
const CLOUDFLARE_IDENTIFIER_PATTERN = /^[a-f0-9]{32}$/i;
const TUNNEL_SERVICE = 'http://traefik:80';
const TUNNEL_CATCH_ALL_SERVICE = 'http_status:404';

class ApiError extends Error {
  public constructor(public readonly statusCode: number, message: string, public readonly code?: string) {
    super(message);
  }
}

interface AuthenticatedRequest extends FastifyRequest {
  authenticatedUser: User;
}

interface AgentRequest extends FastifyRequest {
  authenticatedAgent: Agent;
}

export interface BuildAppOptions {
  store: Store;
  masterKey: Buffer;
  secureCookie?: boolean;
  sessionTtlHours?: number;
  trustProxy?: boolean;
  fetch?: typeof globalThis.fetch;
  webRoot?: string;
  defaultAgentImage?: string;
  traefikDynamicVolume?: string;
  systemBackupNasRoot?: string;
  systemBackupNasMarker?: string;
  notificationIntervalMs?: number;
  offlineAfterMs?: number;
  commandStaleAfterMs?: number;
  connectorIdentityIntervalMs?: number;
  systemRecoveryService?: SystemRecoveryService;
  readinessCheck?: () => Promise<void>;
  release?: string;
  protectedProjects?: string[];
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'A JSON object request body is required.');
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string, min = 1, max = 255): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ApiError(400, `${field} must be a string between ${min} and ${max} characters.`);
  }
  return value.trim();
}

function opaqueStringField(body: Record<string, unknown>, field: string, min = 1, max = 4096): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ApiError(400, `${field} must be a string between ${min} and ${max} characters.`);
  }
  return value;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  if (body[field] === undefined) return undefined;
  if (typeof body[field] !== 'boolean') throw new ApiError(400, `${field} must be a boolean.`);
  return body[field];
}

function optionalUuid(body: Record<string, unknown>, field: string): string | undefined {
  if (body[field] === undefined) return undefined;
  const value = stringField(body, field, 36, 36);
  if (!UUID_PATTERN.test(value)) throw new ApiError(400, `${field} must be a valid UUID.`);
  return value;
}

function cloudflareIdentifier(body: Record<string, unknown>, field: string): string {
  const value = stringField(body, field, 32, 32);
  if (!CLOUDFLARE_IDENTIFIER_PATTERN.test(value)) throw new ApiError(400, `${field} must be a 32-character Cloudflare identifier.`);
  return value;
}

function idParameter(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new ApiError(400, 'A valid UUID is required.');
  return id;
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  return token.length >= 32 ? token : null;
}

function publicUser(user: User): Omit<User, 'passwordHash'> {
  return { id: user.id, email: user.email, role: user.role };
}

function canAccess(actual: Role, required: Role): boolean {
  const rank: Record<Role, number> = { viewer: 1, operator: 2, owner: 3 };
  return rank[actual] >= rank[required];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function enrollmentCommand(baseUrl: string, image: string, enrollmentToken: string, agentId: string, agentName: string, traefikDynamicVolume: string, nasRoot: string, nasMarker: string, protectedProjects: string[]): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ApiError(400, 'baseUrl must be a valid absolute HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ApiError(400, 'baseUrl must be a valid absolute HTTP or HTTPS URL without credentials.');
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    url.hostname = 'host.docker.internal';
  }
  if (!IMAGE_PATTERN.test(image)) throw new ApiError(400, 'image is not a valid container image reference.');
  if (!DOCKER_VOLUME_PATTERN.test(traefikDynamicVolume)) throw new ApiError(500, 'The configured Traefik dynamic volume name is invalid.');
  if (!nasRoot.startsWith('/') || nasRoot.includes(':') || /[\r\n]/.test(nasRoot)) throw new ApiError(500, 'The configured NAS backup root is invalid.');
  if (!/^[A-Za-z0-9._-]+$/.test(nasMarker) || nasMarker === '.' || nasMarker === '..') throw new ApiError(500, 'The configured NAS marker is invalid.');
  const normalizedUrl = url.toString().replace(/\/$/, '');
  const containerName = `gateway-agent-${agentId.slice(0, 8)}`;
  const stateVolume = `${containerName}-state`;
  const insecureHttpOption = url.protocol === 'http:' ? '-e GATEWAY_ALLOW_INSECURE_HTTP=true' : '';
  const pullPolicy = image.endsWith(':local') ? '--pull never' : '--pull always';
  const imagePreflight = image.endsWith(':local')
    ? `docker image inspect ${shellQuote(image)} >/dev/null 2>&1 || { printf '%s\n' ${shellQuote(`Local Agent image ${image} was not found. Build or load it on this host before enrollment.`)} >&2; false; }`
    : '';

  const initializeWritableMounts = [
    'docker run --rm',
    pullPolicy,
    '--entrypoint /bin/sh',
    '--user root',
    '-v /opt/gateway-control/stacks:/opt/gateway-control/stacks',
    '-v /opt/gateway-control/backups/local:/opt/gateway-control/backups/local',
    `-v ${shellQuote(traefikDynamicVolume)}:/srv/traefik-dynamic`,
    shellQuote(image),
    '-c',
    shellQuote('chown 10001:10001 /opt/gateway-control/stacks /opt/gateway-control/backups/local /srv/traefik-dynamic && chmod 0755 /opt/gateway-control/stacks /opt/gateway-control/backups/local /srv/traefik-dynamic'),
  ].join(' ');
  const startAgent = [
    'docker run -d',
    '--pull never',
    `--name ${shellQuote(containerName)}`,
    '--restart unless-stopped',
    '--add-host host.docker.internal:host-gateway',
    `--group-add "$(stat -c '%g' /var/run/docker.sock)"`,
    `-e GATEWAY_CONTROL_URL=${shellQuote(normalizedUrl)}`,
    `-e GATEWAY_ENROLLMENT_TOKEN=${shellQuote(enrollmentToken)}`,
    `-e GATEWAY_AGENT_NAME=${shellQuote(agentName)}`,
    `-e GATEWAY_AGENT_IMAGE=${shellQuote(image)}`,
    insecureHttpOption,
    '-e GATEWAY_STATE_DIR=/var/lib/gateway-agent',
    `-e GATEWAY_STATE_VOLUME=${shellQuote(stateVolume)}`,
    '-e GATEWAY_STACKS_ROOT=/opt/gateway-control/stacks',
    '-e GATEWAY_HOST_STACKS_ROOT=/opt/gateway-control/stacks',
    '-e GATEWAY_HOST_PROC_ROOT=/host/proc',
    '-e GATEWAY_LOCAL_BACKUP_ROOT=/opt/gateway-control/backups/local',
    '-e GATEWAY_HOST_LOCAL_BACKUP_ROOT=/opt/gateway-control/backups/local',
    `-e GATEWAY_NAS_BACKUP_ROOT=${shellQuote(nasRoot)}`,
    `-e GATEWAY_HOST_NAS_BACKUP_ROOT=${shellQuote(nasRoot)}`,
    `-e GATEWAY_NAS_MARKER=${shellQuote(nasMarker)}`,
    `-e GATEWAY_PROTECTED_PROJECTS=${shellQuote(protectedProjects.join(','))}`,
    '-e GATEWAY_TRAEFIK_DYNAMIC_ROOT=/srv/traefik-dynamic',
    `-e GATEWAY_TRAEFIK_DYNAMIC_VOLUME=${shellQuote(traefikDynamicVolume)}`,
    '-v /var/run/docker.sock:/var/run/docker.sock',
    '-v /proc:/host/proc:ro',
    `-v ${shellQuote(stateVolume)}:/var/lib/gateway-agent`,
    '-v /opt/gateway-control/stacks:/opt/gateway-control/stacks',
    '-v /opt/gateway-control/backups/local:/opt/gateway-control/backups/local',
    `-v ${shellQuote(`${nasRoot}:${nasRoot}`)}`,
    `-v ${shellQuote(traefikDynamicVolume)}:/srv/traefik-dynamic`,
    shellQuote(image),
  ].filter(Boolean).join(' ');
  return [imagePreflight, initializeWritableMounts, startAgent].filter(Boolean).join(' && ');
}

function agentCleanupCommand(agentId: string): string {
  const containerName = `gateway-agent-${agentId.slice(0, 8)}`;
  const stateVolume = `${containerName}-state`;
  return `docker rm -f ${shellQuote(containerName)} 2>/dev/null || true; docker volume rm ${shellQuote(stateVolume)} 2>/dev/null || true`;
}

function validateResourceName(value: string, field = 'name'): string {
  if (!RESOURCE_NAME_PATTERN.test(value)) throw new ApiError(400, `${field} contains unsupported characters.`);
  return value;
}

function validateHostname(value: string): string {
  const hostname = value.toLowerCase();
  if (hostname.length > 253 || !/^[\x21-\x7e]+$/.test(hostname) || hostname.includes('..')) throw new ApiError(400, 'hostname must be an IDNA-safe ASCII DNS hostname.');
  const labels = hostname.split('.');
  if (labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new ApiError(400, 'hostname must be an IDNA-safe ASCII DNS hostname.');
  }
  return hostname;
}

function canonicalIp(value: unknown, version: 4 | 6): string {
  if (typeof value !== 'string' || isIP(value.trim()) !== version) throw new ApiError(400, `Each public IPv${version} address must be valid.`, 'invalid_public_ip');
  const input = value.trim().toLowerCase();
  if (version === 4) {
    const octets = input.split('.').map(Number);
    const numeric = octets.reduce((result, octet) => result * 256 + octet, 0);
    const inRange = (base: number, prefix: number): boolean => Math.floor(numeric / 2 ** (32 - prefix)) === Math.floor(base / 2 ** (32 - prefix));
    const reserved = [
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
      [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc01fc400, 24], [0xc034c100, 24],
      [0xc0586300, 24], [0xc0af3000, 24], [0xc0a80000, 16],
      [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
    ].some(([base, prefix]) => inRange(base!, prefix!));
    if (reserved) throw new ApiError(400, 'Public IP addresses must be globally routable unicast addresses.', 'non_global_public_ip');
    return octets.join('.');
  }
  const expanded = expandIpv6(input);
  const explicitlyExcluded = (expanded[0] === 0x3fff && (expanded[1]! & 0xf000) === 0)
    || (expanded.slice(0, 5).every((part) => part === 0) && expanded[5] === 0xffff)
    || (expanded[0] === 0x0064 && expanded[1] === 0xff9b);
  const specialIpv6 = (expanded[0] === 0x2001 && (
    expanded[1] === 0 || (expanded[1] === 2 && expanded[2] === 0)
    || (expanded[1]! & 0xfff0) === 0x0010 || (expanded[1]! & 0xfff0) === 0x0020 || expanded[1] === 0x0db8
  )) || expanded[0] === 0x2002;
  // Product policy is intentionally narrower than the full IPv6 global-unicast allocation.
  if ((expanded[0]! & 0xe000) !== 0x2000 || specialIpv6 || explicitlyExcluded) {
    throw new ApiError(400, 'Public IP addresses must be globally routable unicast addresses.', 'non_global_public_ip');
  }
  let bestStart = -1; let bestLength = 0;
  for (let index = 0; index < expanded.length;) {
    if (expanded[index] !== 0) { index += 1; continue; }
    let end = index; while (end < expanded.length && expanded[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  if (bestStart < 0) return expanded.map((part) => part.toString(16)).join(':');
  const left = expanded.slice(0, bestStart).map((part) => part.toString(16)).join(':');
  const right = expanded.slice(bestStart + bestLength).map((part) => part.toString(16)).join(':');
  return `${left}::${right}`;
}

function expandIpv6(value: string): number[] {
  const [leftValue, rightValue = ''] = value.split('::');
  const parse = (part: string): number[] => part ? part.split(':').flatMap((token) => {
    if (!token.includes('.')) return [Number.parseInt(token, 16)];
    const octets = token.split('.').map(Number);
    return [octets[0]! * 256 + octets[1]!, octets[2]! * 256 + octets[3]!];
  }) : [];
  const left = parse(leftValue!); const right = parse(rightValue);
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill(0), ...right];
}

function publicIpArray(body: Record<string, unknown>, field: 'publicIpv4' | 'publicIpv6', version: 4 | 6): string[] {
  const value = body[field] ?? [];
  if (!Array.isArray(value) || value.length > 4) throw new ApiError(400, `${field} must contain at most 4 addresses.`, 'invalid_public_ip');
  const canonical = value.map((address) => canonicalIp(address, version));
  if (new Set(canonical).size !== canonical.length) throw new ApiError(400, `${field} must not contain duplicate addresses.`, 'duplicate_public_ip');
  return canonical;
}

function validateBackends(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new ApiError(400, 'backends must contain between 1 and 20 URLs.');
  return value.map((backend) => {
    if (typeof backend !== 'string' || /[\u0000-\u001f\u007f]/.test(backend)) throw new ApiError(400, 'Each backend must be a valid HTTP or HTTPS URL.');
    let url: URL;
    try {
      url = new URL(backend);
    } catch {
      throw new ApiError(400, 'Each backend must be a valid HTTP or HTTPS URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname) {
      throw new ApiError(400, 'Each backend must be an absolute HTTP or HTTPS URL without credentials or fragments.');
    }
    return url.toString();
  });
}

function optionalPostgresBackupConfig(body: Record<string, unknown>): { service: string; database: string; user: string } | null | undefined {
  if (body.postgresBackupConfig === undefined) return undefined;
  if (body.postgresBackupConfig === null) return null;
  const config = objectBody(body.postgresBackupConfig);
  const service = stringField(config, 'service', 1, 128);
  const database = stringField(config, 'database', 1, 128);
  const user = stringField(config, 'user', 1, 128);
  if (!SERVICE_NAME_PATTERN.test(service) || !/^[A-Za-z0-9_.-]+$/.test(database) || !/^[A-Za-z0-9_.-]+$/.test(user) || Object.keys(config).some((key) => !['service', 'database', 'user'].includes(key))) {
    throw new ApiError(400, 'postgresBackupConfig contains invalid service, database, or user values.');
  }
  return { service, database, user };
}

function validateTelemetryObject(value: unknown, field: string, maxKeys: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > maxKeys) throw new ApiError(400, `${field} must be a bounded object.`);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new ApiError(400, `${field} contains an invalid field name.`);
    if (typeof item === 'number' && (!Number.isFinite(item) || Math.abs(item) > 1_000_000_000_000_000)) throw new ApiError(400, `${field} contains an out-of-range number.`);
    if (typeof item === 'string' && item.length > 2048) throw new ApiError(400, `${field} contains an oversized string.`);
    if (key.endsWith('At') && item !== null && (typeof item !== 'string' || !RFC3339_PATTERN.test(item) || !Number.isFinite(Date.parse(item)))) throw new ApiError(400, `${field}.${key} must be an RFC3339 timestamp.`);
    if (Array.isArray(item) && item.length > 64) throw new ApiError(400, `${field} contains an oversized array.`);
    if (item && typeof item === 'object' && !Array.isArray(item)) validateTelemetryObject(item, `${field}.${key}`, 32);
  }
  return value as Record<string, unknown>;
}

function validateTelemetry(body: Record<string, unknown>): { observedAt: string; node: Record<string, unknown>; services: Array<Record<string, unknown>> } {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_TELEMETRY_BYTES) throw new ApiError(400, 'Telemetry must not exceed 512 KiB.');
  const observedAt = stringField(body, 'observedAt', 20, 40);
  const observedTime = Date.parse(observedAt);
  if (!RFC3339_PATTERN.test(observedAt) || !Number.isFinite(observedTime) || observedTime > Date.now() + 5 * 60_000 || observedTime < Date.now() - 7 * 86_400_000) throw new ApiError(400, 'observedAt must be a recent RFC3339 timestamp.');
  const node = validateTelemetryObject(body.node, 'node', 64);
  if (!Array.isArray(body.services) || body.services.length > 250) throw new ApiError(400, 'services must contain at most 250 entries.');
  const services = body.services.map((service, index) => {
    const validated = validateTelemetryObject(service, `services[${index}]`, 32);
    if (typeof validated.projectName !== 'string' || !PROJECT_NAME_PATTERN.test(validated.projectName)) throw new ApiError(400, `services[${index}].projectName is invalid.`);
    if (typeof validated.serviceName !== 'string' || !SERVICE_NAME_PATTERN.test(validated.serviceName)) throw new ApiError(400, `services[${index}].serviceName is invalid.`);
    if (typeof validated.name !== 'string' || validated.name !== `${validated.projectName}/${validated.serviceName}`) throw new ApiError(400, `services[${index}].name is invalid.`);
    if (typeof validated.status !== 'string' || !['healthy', 'unhealthy', 'starting', 'completed', 'stopped', 'unknown'].includes(validated.status)) throw new ApiError(400, `services[${index}].status is invalid.`);
    for (const count of ['total', 'running', 'healthy', 'unhealthy', 'starting', 'stopped', 'completed']) {
      if (!Number.isInteger(validated[count]) || Number(validated[count]) < 0 || Number(validated[count]) > 250) throw new ApiError(400, `services[${index}].${count} is invalid.`);
    }
    if (Number(validated.total) < 1 || Number(validated.running) + Number(validated.stopped) + Number(validated.completed) !== Number(validated.total)) throw new ApiError(400, `services[${index}] counts are inconsistent.`);
    return validated;
  });
  if (new Set(services.map((service) => `${service.projectName}\u0000${service.serviceName}`)).size !== services.length) throw new ApiError(400, 'services must have unique project and service identities.');
  return { observedAt: new Date(observedTime).toISOString(), node, services };
}

function operationResult(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result) return null;
  const allowed = ['sizeBytes', 'fileCount', 'durationMs', 'checksum', 'startedAt', 'completedAt', 'message'];
  const sanitized = Object.fromEntries(allowed.filter((key) => ['string', 'number', 'boolean'].includes(typeof result[key])).map((key) => [key, result[key]]));
  if (!sanitized.message && typeof result.error === 'string') sanitized.message = result.error.slice(0, 500);
  if (Array.isArray(result.artifacts)) {
    sanitized.artifacts = result.artifacts.slice(0, 100).flatMap((artifact) => {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return [];
      const value = artifact as Record<string, unknown>;
      if (!['volume_archive', 'postgres_dump'].includes(String(value.type)) || typeof value.name !== 'string' || value.name.length > 128 || typeof value.sizeBytes !== 'number' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) return [];
      return [{ type: value.type, name: value.name, sizeBytes: value.sizeBytes, sha256: value.sha256 }];
    });
  }
  return sanitized;
}

function publicBackup(item: StackBackup): Record<string, unknown> {
  return {
    id: item.id, stackId: item.stackId, agentId: item.agentId, commandId: item.commandId, target: item.target,
    stackRevision: item.stackRevision, status: item.status, result: operationResult(item.result),
    createdAt: item.createdAt, updatedAt: item.updatedAt, completedAt: item.completedAt,
  };
}

function publicRestore(item: StackRestore): Record<string, unknown> {
  return {
    id: item.id, stackId: item.stackId, backupId: item.backupId, agentId: item.agentId, commandId: item.commandId,
    status: item.status, result: operationResult(item.result), createdAt: item.createdAt, updatedAt: item.updatedAt, completedAt: item.completedAt,
  };
}

function publicSystemBackup(item: SystemBackup): Record<string, unknown> {
  return {
    id: item.id, target: item.target, status: item.status, sizeBytes: item.sizeBytes, checksum: item.checksum,
    error: item.error, createdAt: item.createdAt, completedAt: item.completedAt,
  };
}

function publicSystemRestore(item: SystemRestore): Record<string, unknown> {
  return {
    id: item.id, backupId: item.backupId, status: item.status, error: item.error,
    createdAt: item.createdAt, completedAt: item.completedAt,
  };
}

function publicRuntimeOperation(item: Awaited<ReturnType<Store['getRuntimeOperation']>> extends infer T ? Exclude<T, null> : never): Record<string, unknown> {
  return { id: item.id, agentId: item.agentId, action: item.action, scope: item.scope, projectName: item.projectName, serviceName: item.serviceName, status: item.status, result: item.result, error: item.error, createdAt: item.createdAt, updatedAt: item.updatedAt, completedAt: item.completedAt };
}

function publicRuntimeLogRequest(item: Awaited<ReturnType<Store['getRuntimeLogRequest']>> extends infer T ? Exclude<T, null> : never): Record<string, unknown> {
  return { id: item.id, agentId: item.agentId, projectName: item.projectName, serviceName: item.serviceName, tail: item.tail, since: item.since, status: item.status, result: item.result, error: item.error, createdAt: item.createdAt, updatedAt: item.updatedAt, completedAt: item.completedAt };
}

function runtimeProjects(inventory: Awaited<ReturnType<Store['getLatestRuntimeInventory']>>, protectedProjects: ReadonlySet<string>): Record<string, unknown>[] {
  return inventory.flatMap(({ agent, latest }) => {
    if (!latest) return [];
    const stale = Date.now() - Date.parse(latest.receivedAt) > 90_000;
    const projects = new Map<string, Array<Record<string, unknown>>>();
    for (const service of latest.services) {
      if (typeof service.projectName !== 'string' || typeof service.serviceName !== 'string') continue;
      const list = projects.get(service.projectName) ?? [];
      list.push({
        name: service.serviceName, status: service.status, total: service.total, running: service.running,
        healthy: service.healthy, unhealthy: service.unhealthy, starting: service.starting,
        stopped: service.stopped, completed: service.completed,
      });
      projects.set(service.projectName, list);
    }
    return [...projects.entries()].map(([projectName, services]) => {
      const protectedProject = protectedProjects.has(projectName);
      const actionable = agent.enabled && agent.healthStatus === 'connected' && !stale && !protectedProject;
      const statuses = services.map((service) => String(service.status));
      const status = statuses.includes('unhealthy') ? 'unhealthy' : statuses.includes('starting') ? 'starting'
        : statuses.every((value) => value === 'completed') ? 'completed' : statuses.includes('stopped') ? 'stopped'
          : statuses.every((value) => value === 'healthy') ? 'healthy' : 'unknown';
      return { agentId: agent.id, agentName: agent.name, projectName, observedAt: latest.observedAt, receivedAt: latest.receivedAt, stale, protected: protectedProject, actionable, status, services };
    });
  });
}

function exactKeys(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new ApiError(400, 'The request contains unsupported fields.', 'invalid_payload');
}

function safeCloudflareError(error: unknown): string {
  return error instanceof CloudflareClientError ? error.message.slice(0, 500) : 'Cloudflare reconciliation failed.';
}

function enabledIngress(ingress: CloudflareIngressRule[], hostname: string): CloudflareIngressRule[] {
  const retained = ingress.filter((rule) => rule.hostname?.toLowerCase() !== hostname);
  const namedRules = retained.filter((rule) => rule.hostname !== undefined);
  const catchAllRules = retained.filter((rule) => rule.hostname === undefined);
  return [...namedRules, { hostname, service: TUNNEL_SERVICE }, ...(catchAllRules.length > 0 ? catchAllRules : [{ service: TUNNEL_CATCH_ALL_SERVICE }])];
}

function disabledIngress(ingress: CloudflareIngressRule[], hostname: string): CloudflareIngressRule[] {
  const retained = ingress.filter((rule) => rule.hostname?.toLowerCase() !== hostname);
  const namedRules = retained.filter((rule) => rule.hostname !== undefined);
  const catchAllRules = retained.filter((rule) => rule.hostname === undefined);
  return [...namedRules, ...(catchAllRules.length > 0 ? catchAllRules : [{ service: TUNNEL_CATCH_ALL_SERVICE }])];
}

function hostnameWithinZone(hostname: string, zone: string): boolean {
  return hostname.toLowerCase() === zone.toLowerCase() || hostname.toLowerCase().endsWith(`.${zone.toLowerCase()}`);
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    trustProxy: options.trustProxy ?? false,
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'body.password', 'body.passphrase', 'body.token', 'body.apiToken', 'body.botToken', 'body.groupId', 'body.enrollmentToken'],
    },
    bodyLimit: 1_048_576,
  });
  const secretBox = new SecretBox(options.masterKey);
  const httpFetch = options.fetch ?? globalThis.fetch;
  const secureCookie = options.secureCookie ?? true;
  const sessionTtlHours = options.sessionTtlHours ?? 24;
  const protectedProjects = new Set(['gateway-control', ...(options.protectedProjects ?? [])]);
  const notificationDispatcher = new NotificationDispatcher({
    store: options.store, secretBox, fetch: httpFetch, logger: app.log,
    ...(options.notificationIntervalMs !== undefined ? { intervalMs: options.notificationIntervalMs } : {}),
    ...(options.offlineAfterMs !== undefined ? { offlineAfterMs: options.offlineAfterMs } : {}),
    ...(options.commandStaleAfterMs !== undefined ? { commandStaleAfterMs: options.commandStaleAfterMs } : {}),
  });
  let connectorIdentityTimer: NodeJS.Timeout | undefined;
  let connectorIdentityStartupTimer: NodeJS.Timeout | undefined;
  let connectorIdentityRunning = false;

  async function verifyParsedConnectorIdentity(parsed: ParsedCloudflareTunnelToken): Promise<{ accountId: string; accountIdentifier: string; tunnelId: string }> {
    const account = await options.store.getCloudflareAccountSecretByIdentifier(parsed.accountIdentifier);
    if (!account) throw new ApiError(409, 'No enabled Cloudflare account matches the connector token.', 'connector_account_unlinked');
    let apiToken: string;
    try {
      apiToken = secretBox.decrypt(account.encryptedApiToken);
    } catch {
      throw new ApiError(503, 'Cloudflare connector identity verification is temporarily unavailable.', 'connector_identity_verification_failed');
    }
    const client = new CloudflareClient(apiToken, httpFetch, parsed.endpoint === 'fed' ? 'fed' : 'standard');
    let remoteParsed: ParsedCloudflareTunnelToken | null = null;
    try {
      const metadata = await client.getTunnelMetadata(parsed.accountIdentifier, parsed.tunnelId);
      if (metadata.deleted) throw new ApiError(409, 'The Cloudflare tunnel has been deleted.', 'connector_tunnel_deleted');
      if (metadata.accountIdentifier !== parsed.accountIdentifier || metadata.id !== parsed.tunnelId) {
        throw new ApiError(409, 'The connector token does not match the Cloudflare tunnel.', 'connector_identity_mismatch');
      }
      remoteParsed = parseCloudflareTunnelToken(await client.getTunnelToken(parsed.accountIdentifier, parsed.tunnelId));
      const identityMatches = remoteParsed.accountIdentifier === parsed.accountIdentifier && remoteParsed.tunnelId === parsed.tunnelId && remoteParsed.endpoint === parsed.endpoint;
      const secretMatches = remoteParsed.secretMaterial.length === parsed.secretMaterial.length
        && timingSafeEqual(remoteParsed.secretMaterial, parsed.secretMaterial);
      if (!identityMatches || !secretMatches) throw new ApiError(409, 'The connector token is not the current Cloudflare tunnel token.', 'connector_token_mismatch');
      return { accountId: account.id, accountIdentifier: parsed.accountIdentifier, tunnelId: parsed.tunnelId };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof CloudflareClientError && error.isExplicitNotFound()) {
        throw new ApiError(409, 'The Cloudflare tunnel was not found.', 'connector_tunnel_not_found');
      }
      throw new ApiError(503, 'Cloudflare connector identity verification is temporarily unavailable.', 'connector_identity_verification_failed');
    } finally {
      remoteParsed?.secretMaterial.fill(0);
    }
  }

  async function verifyConnectorToken(token: string): Promise<{ accountId: string; accountIdentifier: string; tunnelId: string }> {
    let parsed: ParsedCloudflareTunnelToken;
    try {
      parsed = parseCloudflareTunnelToken(token);
    } catch (error) {
      if (error instanceof CloudflareTunnelTokenError) throw new ApiError(400, 'The Cloudflare tunnel connector token is invalid.', 'invalid_connector_token');
      throw error;
    }
    try {
      return await verifyParsedConnectorIdentity(parsed);
    } finally {
      parsed.secretMaterial.fill(0);
    }
  }

  async function verifyStoredConnector(connectorId: string): Promise<unknown> {
    const deployment = await options.store.getConnectorDeployment(connectorId);
    if (!deployment) throw new ApiError(404, 'Connector not found.', 'connector_not_found');
    const expected = { desiredRevision: deployment.desiredRevision, encryptedToken: deployment.encryptedToken };
    let token: string;
    try {
      token = secretBox.decrypt(deployment.encryptedToken);
    } catch {
      return options.store.markConnectorIdentity(connectorId, expected, { status: 'failed', error: 'connector_credentials_unavailable' });
    }
    let parsed: ParsedCloudflareTunnelToken;
    try {
      parsed = parseCloudflareTunnelToken(token);
    } catch {
      const invalid = await options.store.markConnectorIdentity(connectorId, expected, { status: 'invalid', error: 'invalid_connector_token' });
      if (!invalid) return null;
      throw new ApiError(400, 'The Cloudflare tunnel connector token is invalid.', 'invalid_connector_token');
    }
    const parsedIdentity = { accountIdentifier: parsed.accountIdentifier, tunnelId: parsed.tunnelId };
    if (!await options.store.markConnectorIdentity(connectorId, expected, { status: 'parsed', ...parsedIdentity })) {
      parsed.secretMaterial.fill(0);
      return null;
    }
    try {
      let identity: { accountId: string; accountIdentifier: string; tunnelId: string };
      try {
        identity = await verifyParsedConnectorIdentity(parsed);
      } catch (error) {
        const apiError = error instanceof ApiError ? error : new ApiError(503, 'Cloudflare connector identity verification is temporarily unavailable.', 'connector_identity_verification_failed');
        const status = apiError.code === 'connector_account_unlinked' ? 'unmatched'
          : apiError.code === 'connector_identity_verification_failed' ? 'pending' : 'mismatch';
        const marked = await options.store.markConnectorIdentity(connectorId, expected, { status, ...parsedIdentity, error: apiError.code ?? 'connector_identity_verification_failed' });
        if (!marked) return null;
        throw apiError;
      }
      const verified = await options.store.markConnectorIdentity(connectorId, expected, { status: 'verified', ...identity });
      if (!verified) return null;
      if (verified.identityStatus === 'mismatch') {
        throw new ApiError(409, 'The connector token identity does not match its persisted topology.', 'connector_identity_mismatch');
      }
      return verified;
    } finally {
      parsed.secretMaterial.fill(0);
    }
  }

  async function reconcileConnectorIdentities(): Promise<void> {
    if (connectorIdentityRunning) return;
    connectorIdentityRunning = true;
    try {
      for (const connector of await options.store.listConnectorIdentityDeployments(20)) {
        try {
          await verifyStoredConnector(connector.connectorId);
        } catch {
          // The persisted identity status is the bounded, non-secret diagnostic.
        }
      }
    } catch {
      app.log.error('Connector identity reconciliation iteration failed.');
    } finally {
      connectorIdentityRunning = false;
    }
  }

  async function cloudflareClientForAccount(id: string): Promise<{ client: CloudflareClient; accountIdentifier: string }> {
    const account = await options.store.getCloudflareAccountSecret(id);
    if (!account) throw new ApiError(404, 'Cloudflare account not found.');
    let apiToken: string;
    try {
      apiToken = secretBox.decrypt(account.encryptedApiToken);
    } catch {
      throw new ApiError(500, 'Cloudflare account credentials could not be decrypted.');
    }
    return { client: new CloudflareClient(apiToken, httpFetch), accountIdentifier: account.accountIdentifier };
  }

  async function reconcileDomainAccess(id: string): Promise<unknown> {
    return options.store.withDomainAccessLock(id, async () => {
      const deployment = await options.store.getCloudflareDomainAccessDeployment(id);
      if (!deployment) throw new ApiError(404, 'Cloudflare domain access was not found.', 'domain_access_not_found');
      const revision = deployment.revision;
      const ownershipMarker = `gateway-control:domain-access:${deployment.id}`;
      const superseded = (): ApiError => new ApiError(409, 'A newer domain access change superseded this operation.', 'domain_access_superseded');
      const outcome = async (status: 'active' | 'failed' | 'disabled', lastError: string | null = null): Promise<unknown> => {
        const saved = await options.store.markDomainAccessOutcome(id, revision, { status, lastError });
        if (!saved) throw superseded();
        return saved;
      };

      if (deployment.enabled) {
        const expectedExposure = deployment.accessMethod === 'tunnel' ? 'tunnel' : 'public';
        const tunnelTopologyValid = deployment.accessMethod !== 'tunnel' || (
          deployment.connectorId !== null && deployment.connectorEnabled === true && deployment.tunnelId !== null
          && deployment.connectorIdentityStatus === 'verified'
          && deployment.connectorTokenAccountIdentifier?.toLowerCase() === deployment.accountIdentifier.toLowerCase()
          && deployment.connectorTokenTunnelId?.toLowerCase() === deployment.tunnelId.toLowerCase()
          && deployment.connectorAccountId === deployment.cloudflareAccountId && deployment.connectorAgentId === deployment.routeAgentId
        );
        if (!deployment.accountEnabled || deployment.zoneStatus !== 'active' || deployment.zoneAccountId !== deployment.cloudflareAccountId
          || deployment.routeExposure !== expectedExposure || !deployment.routeEnabled || deployment.routeStatus !== 'active'
          || deployment.routeHostname.toLowerCase() !== deployment.hostname.toLowerCase()
          || !hostnameWithinZone(deployment.hostname, deployment.zoneName) || !tunnelTopologyValid) {
          const message = 'Cloudflare domain access topology or active route requirements are no longer valid.';
          await outcome('failed', message);
          throw new ApiError(409, message, 'domain_access_topology_invalid');
        }
      }

      let apiToken: string;
      try {
        apiToken = secretBox.decrypt(deployment.encryptedApiToken);
      } catch {
        await outcome('failed', 'Cloudflare account credentials could not be decrypted.');
        throw new ApiError(500, 'Cloudflare account credentials could not be decrypted.');
      }
      const client = new CloudflareClient(apiToken, httpFetch);
      const owned = deployment.ownedDnsRecords.filter((record) => record.status !== 'deleted');
      const createdThisAttempt: string[] = [];
      let originalIngress: CloudflareIngressRule[] | null = null;
      const deleteOwnedRecord = async (recordId: string): Promise<void> => {
        try {
          await client.deleteDnsRecord(deployment.zoneIdentifier, recordId);
          if (!(await options.store.markDomainAccessDnsRecordStatus(id, revision, recordId, 'deleted'))) throw superseded();
        } catch (error) {
          if (error instanceof CloudflareClientError && error.isExplicitNotFound()) {
            if (!(await options.store.markDomainAccessDnsRecordStatus(id, revision, recordId, 'deleted'))) throw superseded();
            return;
          }
          const cleanupError = safeCloudflareError(error);
          await options.store.markDomainAccessDnsRecordStatus(id, revision, recordId, 'cleanup_pending', cleanupError);
          throw error;
        }
      };

      try {
        if (!deployment.enabled) {
          for (const record of owned) await deleteOwnedRecord(record.cloudflareRecordId);
          const recoverableDesired: Array<{ type: CloudflareDnsRecord['type']; content: string }> = deployment.accessMethod === 'tunnel'
            ? deployment.tunnelId ? [{ type: 'CNAME', content: `${deployment.tunnelId}.cfargotunnel.com` }] : []
            : [...deployment.publicIpv4.map((content) => ({ type: 'A' as const, content })), ...deployment.publicIpv6.map((content) => ({ type: 'AAAA' as const, content }))];
          const recoverable = (await client.listDnsRecordsExact(deployment.zoneIdentifier, deployment.hostname)).filter((record) =>
            record.comment === ownershipMarker && record.proxied === deployment.proxied
            && recoverableDesired.some((item) => item.type === record.type && item.content.toLowerCase() === record.content.toLowerCase()),
          );
          for (const record of recoverable) {
            const expected = recoverableDesired.find((item) => item.type === record.type && item.content.toLowerCase() === record.content.toLowerCase())!;
            if (!(await options.store.saveDomainAccessDnsRecord(id, revision, { type: expected.type, content: expected.content, cloudflareRecordId: record.id, ownershipMarker }))) throw superseded();
            await deleteOwnedRecord(record.id);
          }
          if (deployment.accessMethod === 'tunnel' && deployment.tunnelId) {
            originalIngress = await client.getTunnelConfig(deployment.accountIdentifier, deployment.tunnelId);
            await client.putTunnelConfig(deployment.accountIdentifier, deployment.tunnelId, disabledIngress(originalIngress, deployment.hostname));
          }
          return await outcome('disabled');
        }

        const desired: Array<{ type: CloudflareDnsRecord['type']; content: string }> = deployment.accessMethod === 'tunnel'
          ? [{ type: 'CNAME', content: `${deployment.tunnelId}.cfargotunnel.com` }]
          : [...deployment.publicIpv4.map((content) => ({ type: 'A' as const, content })), ...deployment.publicIpv6.map((content) => ({ type: 'AAAA' as const, content }))];
        let remote = await client.listDnsRecordsExact(deployment.zoneIdentifier, deployment.hostname);
        const ownedIds = new Set(owned.map((record) => record.cloudflareRecordId));
        for (const record of remote) {
          const expected = desired.find((item) => item.type === record.type && item.content.toLowerCase() === record.content.toLowerCase());
          if (!ownedIds.has(record.id) && expected && record.proxied === deployment.proxied && record.comment === ownershipMarker) {
            const adopted = await options.store.saveDomainAccessDnsRecord(id, revision, { type: expected.type, content: expected.content, cloudflareRecordId: record.id, ownershipMarker });
            if (!adopted) throw superseded();
            owned.push({ type: expected.type, content: expected.content, cloudflareRecordId: record.id, ownershipMarker, status: 'active', lastError: null });
            ownedIds.add(record.id);
          }
        }
        if (remote.some((record) => desired.some((item) => item.type === record.type) && !ownedIds.has(record.id))) {
          throw new ApiError(409, 'A DNS record with this hostname and type already exists and is not owned by GatewayControl.', 'dns_record_conflict');
        }
        for (const record of [...owned]) {
          const expected = desired.some((item) => item.type === record.type && item.content.toLowerCase() === record.content.toLowerCase());
          const actual = remote.find((item) => item.id === record.cloudflareRecordId);
          if (!expected || !actual || actual.content.toLowerCase() !== record.content.toLowerCase() || actual.proxied !== deployment.proxied || actual.comment !== ownershipMarker) {
            await deleteOwnedRecord(record.cloudflareRecordId);
            owned.splice(owned.indexOf(record), 1);
            ownedIds.delete(record.cloudflareRecordId);
          }
        }
        if (deployment.accessMethod === 'tunnel') {
          originalIngress = await client.getTunnelConfig(deployment.accountIdentifier, deployment.tunnelId!);
          await client.putTunnelConfig(deployment.accountIdentifier, deployment.tunnelId!, enabledIngress(originalIngress, deployment.hostname));
        }
        for (const item of desired) {
          if (owned.some((record) => record.type === item.type && record.content.toLowerCase() === item.content.toLowerCase()
            && remote.some((actual) => actual.id === record.cloudflareRecordId && actual.proxied === deployment.proxied && actual.comment === ownershipMarker))) continue;
          let created: CloudflareDnsRecord;
          try {
            created = item.type === 'CNAME'
              ? await client.createDnsCname(deployment.zoneIdentifier, deployment.hostname, deployment.tunnelId!, deployment.proxied, ownershipMarker)
              : await client.createDnsAddress(deployment.zoneIdentifier, item.type, deployment.hostname, item.content, deployment.proxied, ownershipMarker);
          } catch (error) {
            remote = await client.listDnsRecordsExact(deployment.zoneIdentifier, deployment.hostname);
            const recovered = remote.find((record) => record.type === item.type && record.content.toLowerCase() === item.content.toLowerCase()
              && record.proxied === deployment.proxied && record.comment === ownershipMarker);
            if (!recovered) throw error;
            created = recovered;
          }
          createdThisAttempt.push(created.id);
          if (!(await options.store.saveDomainAccessDnsRecord(id, revision, { type: item.type, content: item.content, cloudflareRecordId: created.id, ownershipMarker }))) throw superseded();
          const readBack = await client.getDnsRecord(deployment.zoneIdentifier, created.id, deployment.hostname);
          if (readBack.type !== item.type || readBack.content.toLowerCase() !== item.content.toLowerCase()
            || readBack.proxied !== deployment.proxied || readBack.comment !== ownershipMarker) {
            throw new CloudflareClientError('Cloudflare DNS record read-back did not match the requested ownership metadata.', 502);
          }
        }
        return await outcome('active');
      } catch (error) {
        for (const recordId of createdThisAttempt) {
          try {
            await client.deleteDnsRecord(deployment.zoneIdentifier, recordId);
            await options.store.markDomainAccessDnsRecordStatus(id, revision, recordId, 'deleted');
          } catch (cleanupError) {
            if (cleanupError instanceof CloudflareClientError && cleanupError.isExplicitNotFound()) {
              await options.store.markDomainAccessDnsRecordStatus(id, revision, recordId, 'deleted');
            } else {
              await options.store.markDomainAccessDnsRecordStatus(id, revision, recordId, 'cleanup_pending', safeCloudflareError(cleanupError));
            }
          }
        }
        if (originalIngress && deployment.accessMethod === 'tunnel' && deployment.enabled && deployment.tunnelId) {
          try { await client.putTunnelConfig(deployment.accountIdentifier, deployment.tunnelId, originalIngress); } catch { /* Preserve the primary reconciliation failure. */ }
        }
        const safeError = error instanceof ApiError ? error.message.slice(0, 500) : safeCloudflareError(error);
        if (!(error instanceof ApiError && error.code === 'domain_access_superseded')) await options.store.markDomainAccessOutcome(id, revision, { status: 'failed', lastError: safeError });
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, safeError, 'cloudflare_reconciliation_failed');
      }
    });
  }

  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  if (options.webRoot) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      prefix: '/',
      wildcard: false,
      maxAge: '1h',
      immutable: false,
    });
  }
  app.addHook('onReady', async () => {
    notificationDispatcher.start();
    connectorIdentityStartupTimer = setTimeout(() => void reconcileConnectorIdentities(), 0);
    connectorIdentityStartupTimer.unref();
    connectorIdentityTimer = setInterval(() => void reconcileConnectorIdentities(), options.connectorIdentityIntervalMs ?? 5 * 60_000);
    connectorIdentityTimer.unref();
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (request.url.startsWith('/api/') || request.url === '/health' || request.url === '/ready') {
      reply.header('cache-control', 'no-store');
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    } else {
      reply.header('content-security-policy', "default-src 'self'; connect-src 'self'; font-src 'self' data:; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    if ((error as { code?: string; message?: string }).code === 'P0001' && (error as { message?: string }).message === 'domain_access_dependency_enabled') {
      return reply.code(409).send({ error: 'Disable linked domain access before changing this dependency.', code: 'domain_access_dependency_enabled' });
    }
    if ((error as { statusCode?: number }).statusCode === 413) return reply.code(413).send({ error: 'Request body is too large.' });
    if ((error as { code?: string }).code === '23505') return reply.code(409).send({ error: 'A record with that value already exists.' });
    if ((error as { statusCode?: number }).statusCode === 429) return reply.code(429).send({ error: 'Too many requests. Try again later.' });
    app.log.error({ err: error }, 'Request failed.');
    return reply.code(500).send({ error: 'An internal server error occurred.' });
  });

  async function requireUser(request: FastifyRequest, _reply: FastifyReply, role: Role = 'viewer'): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    const authenticatedUser = token ? await options.store.findSessionUser(hashToken(token)) : null;
    if (!authenticatedUser) throw new ApiError(401, 'Authentication is required.');
    if (!canAccess(authenticatedUser.role, role)) throw new ApiError(403, 'You do not have permission to perform this action.');
    (request as AuthenticatedRequest).authenticatedUser = authenticatedUser;
  }

  async function requireAgent(request: FastifyRequest): Promise<void> {
    const token = bearerToken(request);
    const authenticatedAgent = token ? await options.store.authenticateAgent(hashToken(token)) : null;
    if (!authenticatedAgent) throw new ApiError(401, 'A valid agent bearer credential is required.');
    (request as AgentRequest).authenticatedAgent = authenticatedAgent;
  }

  const release = options.release ?? 'unknown';
  app.get('/health', async () => ({ status: 'ok', release }));
  app.get('/ready', async (_request, reply) => {
    try {
      await (options.readinessCheck ?? (() => options.store.checkReady()))();
      return { status: 'ready', release };
    } catch {
      return reply.code(503).send({ status: 'unavailable', release });
    }
  });

  app.get('/api/setup/status', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => ({ setupComplete: await options.store.isSetupComplete() }));

  app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = objectBody(request.body);
    const email = stringField(body, 'email', 3, 254).toLowerCase();
    const password = opaqueStringField(body, 'password', 12, 1024);
    if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'email must be a valid email address.');
    if (await options.store.isSetupComplete()) throw new ApiError(409, 'Initial setup has already been completed.');
    const owner = await options.store.createOwner(email, await hashPassword(password));
    if (!owner) throw new ApiError(409, 'Initial setup has already been completed.');
    return reply.code(201).send({ user: publicUser(owner) });
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = objectBody(request.body);
    const email = stringField(body, 'email', 3, 254).toLowerCase();
    const password = opaqueStringField(body, 'password', 1, 1024);
    const user = await options.store.findUserByEmail(email);
    if (!user || !(await verifyPassword(user.passwordHash, password))) throw new ApiError(401, 'The email or password is incorrect.');
    const token = randomToken();
    const expiresAt = new Date(Date.now() + sessionTtlHours * 3_600_000);
    await options.store.createSession(user.id, hashToken(token), expiresAt);
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, secure: secureCookie && request.protocol === 'https', sameSite: 'strict', expires: expiresAt });
    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', { preHandler: (request, reply) => requireUser(request, reply) }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await options.store.deleteSession(hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: secureCookie && request.protocol === 'https', sameSite: 'strict' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: (request, reply) => requireUser(request, reply) }, async (request) => ({ user: publicUser((request as AuthenticatedRequest).authenticatedUser) }));
  app.get('/api/configuration', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({
    agentImage: options.defaultAgentImage ?? 'ghcr.io/gatewaycontrol/gateway-agent:latest',
  }));

  app.get('/api/users', { preHandler: (request, reply) => requireUser(request, reply, 'owner') }, async () => ({ users: await options.store.listUsers() }));
  app.post('/api/users', { preHandler: (request, reply) => requireUser(request, reply, 'owner') }, async (request, reply) => {
    const body = objectBody(request.body);
    const email = stringField(body, 'email', 3, 254).toLowerCase();
    const password = opaqueStringField(body, 'password', 12, 1024);
    const role = stringField(body, 'role') as Role;
    if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'email must be a valid email address.');
    if (!['operator', 'viewer'].includes(role)) throw new ApiError(400, 'role must be operator or viewer.');
    const user = await options.store.createUser(email, await hashPassword(password), role as 'operator' | 'viewer');
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.get('/api/connectors', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ connectors: await options.store.listConnectors() }));
  app.post('/api/connectors', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const body = objectBody(request.body);
    exactKeys(body, ['name', 'token', 'enabled', 'agentId', 'cloudflareAccountId', 'tunnelId']);
    const name = stringField(body, 'name', 1, 120);
    const token = opaqueStringField(body, 'token', 20, 4096);
    const enabled = optionalBoolean(body, 'enabled') ?? true;
    const agentId = stringField(body, 'agentId', 36, 36);
    if (!UUID_PATTERN.test(agentId)) throw new ApiError(400, 'agentId must be a valid UUID.');
    const submittedAccountId = optionalUuid(body, 'cloudflareAccountId');
    const submittedTunnelId = optionalUuid(body, 'tunnelId');
    const identity = await verifyConnectorToken(token);
    if ((submittedAccountId && submittedAccountId !== identity.accountId) || (submittedTunnelId && submittedTunnelId.toLowerCase() !== identity.tunnelId)) {
      throw new ApiError(409, 'Submitted connector binding does not match the token identity.', 'connector_submitted_identity_mismatch');
    }
    const connector = await options.store.createConnector({ name, encryptedToken: secretBox.encrypt(token), enabled, agentId, ...identity });
    if (!connector) throw new ApiError(409, 'An enabled, enrolled agent and matching Cloudflare account are required.', 'connector_target_unavailable');
    return reply.code(201).send({ connector });
  });
  app.patch('/api/connectors/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const id = idParameter(request);
    const body = objectBody(request.body);
    exactKeys(body, ['name', 'token', 'enabled', 'agentId', 'cloudflareAccountId', 'tunnelId']);
    const name = body.name === undefined ? undefined : stringField(body, 'name', 1, 120);
    const token = body.token === undefined ? undefined : opaqueStringField(body, 'token', 20, 4096);
    const enabled = optionalBoolean(body, 'enabled');
    const agentId = body.agentId === undefined ? undefined : stringField(body, 'agentId', 36, 36);
    if (agentId !== undefined && !UUID_PATTERN.test(agentId)) throw new ApiError(400, 'agentId must be a valid UUID.');
    const submittedAccountId = optionalUuid(body, 'cloudflareAccountId');
    const submittedTunnelId = optionalUuid(body, 'tunnelId');
    if (name === undefined && token === undefined && enabled === undefined && agentId === undefined && submittedAccountId === undefined && submittedTunnelId === undefined) throw new ApiError(400, 'At least one editable field is required.');
    const current = (await options.store.listConnectors()).find((connector) => connector.id === id);
    if (!current) throw new ApiError(404, 'Connector not found.');
    if ((enabled === false || agentId !== undefined || token !== undefined || submittedAccountId !== undefined || submittedTunnelId !== undefined)
      && await options.store.hasEnabledDomainAccessDependency('connector', id)) {
      throw new ApiError(409, 'Disable linked domain access before changing this connector.', 'domain_access_dependency_enabled');
    }
    const identity = token === undefined ? undefined : await verifyConnectorToken(token);
    if ((submittedAccountId && submittedAccountId !== (identity?.accountId ?? current.cloudflareAccountId))
      || (submittedTunnelId && submittedTunnelId.toLowerCase() !== (identity?.tunnelId ?? current.tokenTunnelId))) {
      throw new ApiError(409, 'Submitted connector binding does not match the token identity.', 'connector_submitted_identity_mismatch');
    }
    if (enabled === true && !identity && current.identityStatus !== 'verified') {
      throw new ApiError(409, 'The connector identity must be verified before it can be enabled.', 'connector_identity_unverified');
    }
    const connector = await options.store.updateConnector(id, {
      ...(name !== undefined ? { name } : {}),
      ...(token !== undefined ? { encryptedToken: secretBox.encrypt(token) } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(identity ?? {}),
    });
    if (!connector) throw new ApiError(404, 'Connector not found.');
    return { connector };
  });
  app.post('/api/connectors/:id/verify', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => ({ connector: await verifyStoredConnector(idParameter(request)) }));

  app.get('/api/cloudflare/accounts', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ accounts: await options.store.listCloudflareAccounts() }));
  app.post('/api/cloudflare/accounts', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const body = objectBody(request.body);
    const account = await options.store.createCloudflareAccount({
      name: stringField(body, 'name', 1, 120),
      accountIdentifier: cloudflareIdentifier(body, 'accountIdentifier'),
      encryptedApiToken: secretBox.encrypt(opaqueStringField(body, 'apiToken', 20, 4096)),
      enabled: optionalBoolean(body, 'enabled') ?? true,
    });
    return reply.code(201).send({ account });
  });
  app.patch('/api/cloudflare/accounts/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const id = idParameter(request);
    const body = objectBody(request.body);
    const name = body.name === undefined ? undefined : stringField(body, 'name', 1, 120);
    const accountIdentifier = body.accountIdentifier === undefined ? undefined : cloudflareIdentifier(body, 'accountIdentifier');
    const apiToken = body.apiToken === undefined ? undefined : opaqueStringField(body, 'apiToken', 20, 4096);
    const enabled = optionalBoolean(body, 'enabled');
    if (name === undefined && accountIdentifier === undefined && apiToken === undefined && enabled === undefined) throw new ApiError(400, 'At least one editable field is required.');
    if ((enabled === false || accountIdentifier !== undefined || apiToken !== undefined)
      && await options.store.hasEnabledDomainAccessDependency('account', id)) {
      throw new ApiError(409, 'Disable linked domain access before changing this Cloudflare account.', 'domain_access_dependency_enabled');
    }
    const account = await options.store.updateCloudflareAccount(id, {
      ...(name !== undefined ? { name } : {}), ...(accountIdentifier !== undefined ? { accountIdentifier } : {}),
      ...(apiToken !== undefined ? { encryptedApiToken: secretBox.encrypt(apiToken) } : {}), ...(enabled !== undefined ? { enabled } : {}),
    });
    if (!account) throw new ApiError(404, 'Cloudflare account not found.');
    return { account };
  });
  app.post('/api/cloudflare/accounts/:id/test', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const { client } = await cloudflareClientForAccount(idParameter(request));
    try {
      await client.verifyToken();
    } catch (error) {
      throw new ApiError(502, safeCloudflareError(error));
    }
    return { verified: true };
  });
  app.post('/api/cloudflare/accounts/:id/sync', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const id = idParameter(request);
    const { client, accountIdentifier } = await cloudflareClientForAccount(id);
    try {
      await client.verifyToken();
      const zones = await client.listZones(accountIdentifier);
      const stored = await options.store.syncCloudflareZones(id, zones.map((zone) => ({ zoneIdentifier: zone.id, name: zone.name, status: zone.status })));
      if (!stored) throw new ApiError(404, 'Cloudflare account not found.');
      return { zones: stored };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const safeError = safeCloudflareError(error);
      await options.store.syncCloudflareZones(id, [], safeError);
      throw new ApiError(502, safeError);
    }
  });
  app.get('/api/cloudflare/accounts/:id/zones', { preHandler: (request, reply) => requireUser(request, reply) }, async (request) => {
    const zones = await options.store.listCloudflareZones(idParameter(request));
    if (!zones) throw new ApiError(404, 'Cloudflare account not found.');
    return { zones };
  });
  const createDomainAccess = async (request: FastifyRequest, reply: FastifyReply, legacy = false): Promise<unknown> => {
    const body = objectBody(request.body);
    exactKeys(body, legacy ? ['zoneId', 'connectorId', 'routeId', 'proxied'] : ['accountId', 'zoneId', 'routeId', 'accessMethod', 'connectorId', 'publicIpv4', 'publicIpv6', 'proxied']);
    const zoneId = optionalUuid(body, 'zoneId') ?? (() => { throw new ApiError(400, 'zoneId is required.', 'invalid_payload'); })();
    const routeId = optionalUuid(body, 'routeId') ?? (() => { throw new ApiError(400, 'routeId is required.', 'invalid_payload'); })();
    const connectorId = optionalUuid(body, 'connectorId');
    const accessMethod = legacy ? 'tunnel' : stringField(body, 'accessMethod') as 'tunnel' | 'public_ip';
    if (!['tunnel', 'public_ip'].includes(accessMethod)) throw new ApiError(400, 'accessMethod must be tunnel or public_ip.', 'invalid_access_method');
    const connectors = await options.store.listConnectors();
    const connector = connectorId ? connectors.find((item) => item.id === connectorId) : undefined;
    const accountId = legacy ? connector?.cloudflareAccountId ?? undefined : optionalUuid(body, 'accountId');
    if (!accountId) throw new ApiError(400, 'accountId is required.', 'invalid_payload');
    const publicIpv4 = legacy ? [] : publicIpArray(body, 'publicIpv4', 4);
    const publicIpv6 = legacy ? [] : publicIpArray(body, 'publicIpv6', 6);
    if (accessMethod === 'tunnel' && (!connectorId || body.publicIpv4 !== undefined || body.publicIpv6 !== undefined)) throw new ApiError(400, 'Tunnel access requires connectorId and does not accept public IP addresses.', 'invalid_access_configuration');
    if (accessMethod === 'public_ip' && (connectorId || publicIpv4.length + publicIpv6.length === 0)) throw new ApiError(400, 'Public IP access requires at least one IP address and does not accept connectorId.', 'invalid_access_configuration');
    const account = (await options.store.listCloudflareAccounts()).find((item) => item.id === accountId);
    if (!account?.enabled) throw new ApiError(409, 'The Cloudflare account is missing or disabled.', 'cloudflare_account_unavailable');
    const zone = (await options.store.listCloudflareZones(accountId))?.find((item) => item.id === zoneId);
    if (!zone || zone.status !== 'active') throw new ApiError(409, 'The Cloudflare zone is not active or does not belong to the selected account.', 'cloudflare_zone_invalid');
    const route = (await options.store.listRoutes()).find((item) => item.id === routeId);
    const expectedExposure = accessMethod === 'tunnel' ? 'tunnel' : 'public';
    if (!route?.enabled || route.status !== 'active' || route.exposure !== expectedExposure || !hostnameWithinZone(route.hostname, zone.name)) throw new ApiError(409, 'The route must be active, enabled, match the access method, and have a hostname in the selected zone.', 'domain_access_route_invalid');
    if (accessMethod === 'tunnel' && (!connector?.enabled || connector.identityStatus !== 'verified' || !connector.tokenTunnelId
      || connector.tokenAccountIdentifier?.toLowerCase() !== account.accountIdentifier.toLowerCase()
      || connector.tunnelId?.toLowerCase() !== connector.tokenTunnelId.toLowerCase()
      || connector.cloudflareAccountId !== accountId || connector.agentId !== route.gatewayAgentId)) {
      throw new ApiError(409, 'The tunnel connector must have a verified identity, use the same account, and be assigned to the route agent.', 'tunnel_topology_mismatch');
    }
    if ((await options.store.listCloudflareDomainAccess()).some((item) => item.routeId === routeId || item.hostname.toLowerCase() === route.hostname.toLowerCase())) throw new ApiError(409, 'This route or hostname is already managed.', 'domain_access_duplicate');
    const created = await options.store.createPendingDomainAccess({ accountId, zoneId, routeId, accessMethod, ...(connectorId ? { connectorId } : {}), publicIpv4, publicIpv6, proxied: optionalBoolean(body, 'proxied') ?? true });
    if (!created) throw new ApiError(409, 'Domain access relationships changed or are already managed.', 'domain_access_invalid');
    const reconciled = await reconcileDomainAccess(created.id);
    return reply.code(201).send(legacy ? { publicHostname: reconciled } : { domainAccess: reconciled });
  };
  const updateDomainAccess = async (request: FastifyRequest, legacy = false): Promise<unknown> => {
    const body = objectBody(request.body);
    const enabled = optionalBoolean(body, 'enabled');
    if (enabled === undefined || Object.keys(body).some((key) => key !== 'enabled')) throw new ApiError(400, 'Only enabled may be updated.');
    const current = (await options.store.listCloudflareDomainAccess()).find((item) => item.id === idParameter(request));
    if (!current) throw new ApiError(404, 'Cloudflare domain access was not found.', 'domain_access_not_found');
    if (current.enabled === enabled && ((enabled && current.status === 'active') || (!enabled && current.status === 'disabled'))) return legacy ? { publicHostname: current } : { domainAccess: current };
    const pending = await options.store.setDomainAccessPending(current.id, enabled);
    const reconciled = await reconcileDomainAccess(pending!.id);
    return legacy ? { publicHostname: reconciled } : { domainAccess: reconciled };
  };
  app.get('/api/cloudflare/domain-access', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ domainAccess: await options.store.listCloudflareDomainAccess() }));
  app.post('/api/cloudflare/domain-access', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => createDomainAccess(request, reply));
  app.patch('/api/cloudflare/domain-access/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => updateDomainAccess(request));
  app.post('/api/cloudflare/domain-access/:id/reconcile', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const pending = await options.store.setDomainAccessPending(idParameter(request));
    if (!pending) throw new ApiError(404, 'Cloudflare domain access was not found.', 'domain_access_not_found');
    return { domainAccess: await reconcileDomainAccess(pending.id) };
  });
  app.get('/api/cloudflare/public-hostnames', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ publicHostnames: await options.store.listCloudflareDomainAccess() }));
  app.post('/api/cloudflare/public-hostnames', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => createDomainAccess(request, reply, true));
  app.patch('/api/cloudflare/public-hostnames/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => updateDomainAccess(request, true));

  app.get('/api/runtime-projects', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ projects: runtimeProjects(await options.store.getLatestRuntimeInventory(), protectedProjects) }));
  app.get('/api/runtime-operations', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ operations: (await options.store.listRuntimeOperations()).map(publicRuntimeOperation) }));
  app.post('/api/runtime-actions', { preHandler: (request, reply) => requireUser(request, reply, 'operator'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = objectBody(request.body); exactKeys(body, ['agentId', 'projectName', 'serviceName', 'action', 'scope']);
    const agentId = stringField(body, 'agentId', 36, 36); const projectName = stringField(body, 'projectName', 1, 63);
    const scope = stringField(body, 'scope') as 'project' | 'service'; const action = stringField(body, 'action') as 'start' | 'stop' | 'restart';
    if (!UUID_PATTERN.test(agentId) || !PROJECT_NAME_PATTERN.test(projectName) || !['project', 'service'].includes(scope) || !['start', 'stop', 'restart'].includes(action)) throw new ApiError(400, 'Runtime action fields are invalid.', 'invalid_target');
    const serviceName = scope === 'service' ? stringField(body, 'serviceName', 1, 128) : undefined;
    if ((scope === 'service' && !SERVICE_NAME_PATTERN.test(serviceName!)) || (scope === 'project' && body.serviceName !== undefined)) throw new ApiError(400, 'serviceName must match the selected scope.', 'invalid_target');
    const inventory = await options.store.getLatestRuntimeInventory(); const target = inventory.find((item) => item.agent.id === agentId);
    if (!target) throw new ApiError(404, 'Agent not found.', 'agent_not_found');
    if (!target.agent.enabled || !target.agent.enrolledAt || target.agent.healthStatus !== 'connected') throw new ApiError(409, 'The assigned agent is offline or disabled.', 'agent_unavailable');
    if (!target.latest || Date.now() - Date.parse(target.latest.receivedAt) > 90_000) throw new ApiError(409, 'Runtime discovery is stale.', 'telemetry_stale');
    const service = target.latest.services.find((item) => item.projectName === projectName && (scope === 'project' || item.serviceName === serviceName));
    if (!service) throw new ApiError(404, 'Runtime project or service was not discovered.', 'target_not_found');
    if (protectedProjects.has(projectName)) throw new ApiError(403, 'This runtime project is protected.', 'project_protected');
    const operation = await options.store.createRuntimeOperation({ requestedByUserId: (request as AuthenticatedRequest).authenticatedUser.id, agentId, projectName, action, scope, ...(serviceName ? { serviceName } : {}) });
    if (operation === 'active') throw new ApiError(409, 'An action is already active for this target.', 'operation_active');
    if (!operation) throw new ApiError(409, 'The assigned agent is unavailable.', 'agent_unavailable');
    return reply.code(202).send({ operation: publicRuntimeOperation(operation) });
  });
  app.post('/api/runtime-log-requests', { preHandler: (request, reply) => requireUser(request, reply, 'operator'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = objectBody(request.body); exactKeys(body, ['agentId', 'projectName', 'serviceName', 'tail', 'since']);
    const agentId = stringField(body, 'agentId', 36, 36); const projectName = stringField(body, 'projectName', 1, 63); const serviceName = stringField(body, 'serviceName', 1, 128);
    const tail = body.tail; if (!UUID_PATTERN.test(agentId) || !PROJECT_NAME_PATTERN.test(projectName) || !SERVICE_NAME_PATTERN.test(serviceName) || !Number.isInteger(tail) || Number(tail) < 1 || Number(tail) > 1000) throw new ApiError(400, 'Runtime log request fields are invalid.', 'invalid_target');
    let since: string | undefined; if (body.since !== undefined) { since = stringField(body, 'since', 20, 40); const time = Date.parse(since); if (!RFC3339_PATTERN.test(since) || !Number.isFinite(time) || time > Date.now() || time < Date.now() - 86_400_000) throw new ApiError(400, 'since must be within the last 24 hours.', 'invalid_since'); since = new Date(time).toISOString(); }
    const inventory = await options.store.getLatestRuntimeInventory(); const target = inventory.find((item) => item.agent.id === agentId);
    if (!target || !target.agent.enabled || !target.agent.enrolledAt || target.agent.healthStatus !== 'connected') throw new ApiError(409, 'The assigned agent is offline or disabled.', 'agent_unavailable');
    if (!target.latest || Date.now() - Date.parse(target.latest.receivedAt) > 90_000) throw new ApiError(409, 'Runtime discovery is stale.', 'telemetry_stale');
    if (!target.latest.services.some((item) => item.projectName === projectName && item.serviceName === serviceName)) throw new ApiError(404, 'Runtime service was not discovered.', 'target_not_found');
    if (protectedProjects.has(projectName) && (request as AuthenticatedRequest).authenticatedUser.role !== 'owner') throw new ApiError(403, 'Only an Owner may request logs for a protected runtime project.', 'protected_logs_owner_required');
    const created = await options.store.createRuntimeLogRequest({ requestedByUserId: (request as AuthenticatedRequest).authenticatedUser.id, agentId, projectName, serviceName, tail: Number(tail), ...(since ? { since } : {}) });
    if (!created) throw new ApiError(409, 'The assigned agent is unavailable.', 'agent_unavailable');
    return reply.code(202).send({ request: publicRuntimeLogRequest(created) });
  });
  app.get('/api/runtime-log-requests/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const item = await options.store.getRuntimeLogRequest(idParameter(request), (request as AuthenticatedRequest).authenticatedUser.id);
    if (!item) throw new ApiError(404, 'Runtime log request not found.', 'log_request_not_found');
    if (protectedProjects.has(item.projectName) && (request as AuthenticatedRequest).authenticatedUser.role !== 'owner') throw new ApiError(403, 'Only an Owner may view logs for a protected runtime project.', 'protected_logs_owner_required');
    return { request: publicRuntimeLogRequest(item) };
  });

  app.get('/api/stacks', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ stacks: await options.store.listStacks() }));
  const legacyStackMutation = async (): Promise<never> => { throw new ApiError(410, 'Managed stack deployment is no longer available.', 'legacy_stack_mutation_disabled'); };
  app.post('/api/stacks', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, legacyStackMutation);
  app.patch('/api/stacks/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, legacyStackMutation);
  app.post('/api/stacks/:id/restart', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, legacyStackMutation);
  app.post('/api/stacks/:id/stop', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, legacyStackMutation);
  app.post('/api/stacks/:id/logs', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, legacyStackMutation);
  app.post('/api/stacks/:id/backups', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const body = objectBody(request.body);
    const target = stringField(body, 'target') as 'local' | 'nas';
    if (!['local', 'nas'].includes(target)) throw new ApiError(400, 'target must be local or nas.');
    const created = await options.store.createBackup(idParameter(request), (request as AuthenticatedRequest).authenticatedUser.id, target);
    if (created === 'active') throw new ApiError(409, 'This stack already has an active backup or restore operation.');
    if (!created) throw new ApiError(404, 'Enabled stack or agent not found.');
    return reply.code(202).send({ backup: publicBackup(created) });
  });

  app.get('/api/routes', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ routes: await options.store.listRoutes() }));
  app.post('/api/routes', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const body = objectBody(request.body);
    const gatewayAgentId = stringField(body, 'gatewayAgentId', 36, 36);
    if (!UUID_PATTERN.test(gatewayAgentId)) throw new ApiError(400, 'gatewayAgentId must be a valid UUID.');
    const exposure = stringField(body, 'exposure') as 'tunnel' | 'public';
    if (!['tunnel', 'public'].includes(exposure)) throw new ApiError(400, 'exposure must be tunnel or public.');
    const route = await options.store.createRoute({
      gatewayAgentId,
      name: validateResourceName(stringField(body, 'name', 1, 63)),
      hostname: validateHostname(stringField(body, 'hostname', 1, 253)),
      exposure,
      backends: validateBackends(body.backends),
      enabled: optionalBoolean(body, 'enabled') ?? true,
    });
    if (!route) throw new ApiError(404, 'Enabled gateway agent not found.');
    return reply.code(201).send({ route });
  });
  app.patch('/api/routes/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const id = idParameter(request);
    const body = objectBody(request.body);
    const gatewayAgentId = body.gatewayAgentId === undefined ? undefined : stringField(body, 'gatewayAgentId', 36, 36);
    if (gatewayAgentId !== undefined && !UUID_PATTERN.test(gatewayAgentId)) throw new ApiError(400, 'gatewayAgentId must be a valid UUID.');
    const name = body.name === undefined ? undefined : validateResourceName(stringField(body, 'name', 1, 63));
    const hostname = body.hostname === undefined ? undefined : validateHostname(stringField(body, 'hostname', 1, 253));
    const exposure = body.exposure === undefined ? undefined : stringField(body, 'exposure') as 'tunnel' | 'public';
    if (exposure !== undefined && !['tunnel', 'public'].includes(exposure)) throw new ApiError(400, 'exposure must be tunnel or public.');
    const backends = body.backends === undefined ? undefined : validateBackends(body.backends);
    const enabled = optionalBoolean(body, 'enabled');
    if (gatewayAgentId === undefined && name === undefined && hostname === undefined && exposure === undefined && backends === undefined && enabled === undefined) throw new ApiError(400, 'At least one editable field is required.');
    if ((enabled === false || gatewayAgentId !== undefined || hostname !== undefined || exposure !== undefined)
      && await options.store.hasEnabledDomainAccessDependency('route', id)) {
      throw new ApiError(409, 'Disable linked domain access before changing this route.', 'domain_access_dependency_enabled');
    }
    const route = await options.store.updateRoute(id, {
      ...(gatewayAgentId !== undefined ? { gatewayAgentId } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(hostname !== undefined ? { hostname } : {}),
      ...(exposure !== undefined ? { exposure } : {}),
      ...(backends !== undefined ? { backends } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
    if (!route) throw new ApiError(404, 'Route or enabled gateway agent not found.');
    return { route };
  });

  app.get('/api/notifications/telegram', { preHandler: (request, reply) => requireUser(request, reply) }, async () => await options.store.getNotificationSettings());
  app.put('/api/notifications/telegram', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const body = objectBody(request.body);
    if (!Array.isArray(body.selectedEvents) || body.selectedEvents.length > OPERATIONAL_EVENT_TYPES.length || body.selectedEvents.some((event) => typeof event !== 'string' || !EVENT_TYPES.has(event))) {
      throw new ApiError(400, 'selectedEvents contains an unsupported operational event.');
    }
    const selectedEvents = [...new Set(body.selectedEvents as string[])];
    const hasBotToken = body.botToken !== undefined;
    const hasGroupId = body.groupId !== undefined;
    if (hasBotToken !== hasGroupId) throw new ApiError(400, 'botToken and groupId must be provided together.');
    let secrets = await options.store.getNotificationSecrets();
    if (hasBotToken) {
      const botToken = opaqueStringField(body, 'botToken', 20, 512);
      const groupId = opaqueStringField(body, 'groupId', 1, 128);
      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new ApiError(400, 'botToken is not a valid Telegram bot token.');
      secrets = { botTokenEncrypted: secretBox.encrypt(botToken), groupIdEncrypted: secretBox.encrypt(groupId) };
    }
    if (!secrets) throw new ApiError(409, 'Telegram credentials must be configured before updating selected events.');
    await options.store.saveNotificationSettings(secrets.botTokenEncrypted, secrets.groupIdEncrypted, selectedEvents);
    return { configured: true, selectedEvents };
  });
  app.post('/api/notifications/telegram/test', { preHandler: (request, reply) => requireUser(request, reply, 'operator'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async () => {
    const secrets = await options.store.getNotificationSecrets();
    if (!secrets) throw new ApiError(409, 'Telegram notifications are not configured.');
    const botToken = secretBox.decrypt(secrets.botTokenEncrypted);
    const groupId = secretBox.decrypt(secrets.groupIdEncrypted);
    let response: Response;
    try {
      response = await httpFetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: groupId, text: 'Gateway Control test notification.' }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError(502, 'Telegram could not be reached.');
    }
    if (!response.ok) throw new ApiError(502, `Telegram rejected the test message with HTTP ${response.status}.`);
    return { sent: true };
  });

  app.get('/api/agents', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ agents: await options.store.listAgents() }));
  app.post('/api/agents', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const body = objectBody(request.body);
    const name = stringField(body, 'name', 1, 120);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const agent = await options.store.createAgent(name, hashToken(token), expiresAt);
    const response: Record<string, unknown> = { agent, enrollmentToken: token, enrollmentExpiresAt: expiresAt.toISOString() };
    if (body.baseUrl !== undefined || body.image !== undefined) {
      response.enrollmentCommand = enrollmentCommand(
        stringField(body, 'baseUrl', 8, 2048),
        stringField(body, 'image', 1, 512),
        token,
        agent.id,
        agent.name,
        options.traefikDynamicVolume ?? 'gateway-traefik-dynamic',
        options.systemBackupNasRoot ?? '/mnt/gateway-control-backups',
        options.systemBackupNasMarker ?? '.gateway-control-nas',
        [...protectedProjects],
      );
    }
    return reply.code(201).send(response);
  });
  app.delete('/api/agents/:id', { preHandler: (request, reply) => requireUser(request, reply, 'owner') }, async (request) => {
    const id = idParameter(request);
    const result = await options.store.removeAgent(id);
    if (result === 'missing') throw new ApiError(404, 'Agent not found.');
    if (result === 'blocked') throw new ApiError(409, 'Reassign or remove the Agent dependencies and wait for active commands to finish before removing it.');
    return { mode: result, cleanupCommand: agentCleanupCommand(id) };
  });
  app.post('/api/agents/enrollment-command', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const body = objectBody(request.body);
    const agentId = stringField(body, 'agentId', 36, 36);
    if (!UUID_PATTERN.test(agentId)) throw new ApiError(400, 'agentId must be a valid UUID.');
    return {
      command: enrollmentCommand(
        stringField(body, 'baseUrl', 8, 2048),
        stringField(body, 'image', 1, 512),
        opaqueStringField(body, 'enrollmentToken', 32, 512),
        agentId,
        stringField(body, 'agentName', 1, 120),
        options.traefikDynamicVolume ?? 'gateway-traefik-dynamic',
        options.systemBackupNasRoot ?? '/mnt/gateway-control-backups',
        options.systemBackupNasMarker ?? '.gateway-control-nas',
        [...protectedProjects],
      ),
    };
  });

  app.post('/api/agent/enroll', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
    const body = objectBody(request.body);
    const enrollmentToken = opaqueStringField(body, 'enrollmentToken', 32, 512);
    const credential = randomToken(48);
    const agent = await options.store.enrollAgent(hashToken(enrollmentToken), hashToken(credential));
    if (!agent) throw new ApiError(401, 'The enrollment token is invalid, expired, or already used.');
    return { agent: { id: agent.id, name: agent.name }, credential };
  });
  app.post('/api/agent/heartbeat', { preHandler: requireAgent }, async (request) => {
    const metadata = request.body === undefined ? {} : objectBody(request.body);
    if (JSON.stringify(metadata).length > 16_384) throw new ApiError(400, 'Heartbeat metadata is too large.');
    await options.store.heartbeatAgent((request as AgentRequest).authenticatedAgent.id, metadata);
    return { accepted: true, serverTime: new Date().toISOString() };
  });
  app.post('/api/agent/telemetry', { preHandler: requireAgent, bodyLimit: MAX_TELEMETRY_BYTES }, async (request) => {
    const snapshot = validateTelemetry(objectBody(request.body));
    await options.store.recordTelemetry((request as AgentRequest).authenticatedAgent.id, snapshot);
    return { accepted: true };
  });
  app.get('/api/agent/commands', { preHandler: requireAgent }, async (request) => {
    const agent = (request as AgentRequest).authenticatedAgent;
    const claimedCommands = await options.store.claimCommands(agent.id, 1);
    const commands: AgentCommand[] = [];
    for (const command of claimedCommands) {
      if (command.type === 'compose.stack.sync') {
        await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Legacy managed stack deployment is disabled.' });
        continue;
      }
      if (command.type === 'compose.runtime.action') {
        const operationId = command.payload.operationId;
        const operation = typeof operationId === 'string' ? await options.store.getRuntimeOperation(operationId) : null;
        if (!operation || operation.agentId !== agent.id || operation.commandId !== command.id) {
          await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Runtime action is unavailable for this agent.' });
          continue;
        }
        commands.push({ ...command, payload: { operationId, projectName: operation.projectName, ...(operation.serviceName ? { serviceName: operation.serviceName } : {}), action: operation.action, scope: operation.scope } });
        continue;
      }
      if (command.type === 'compose.runtime.logs') {
        const requestId = command.payload.requestId;
        const logRequest = typeof requestId === 'string' ? await options.store.getRuntimeLogRequest(requestId) : null;
        if (!logRequest || logRequest.agentId !== agent.id || logRequest.commandId !== command.id) {
          await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Runtime log request is unavailable for this agent.' });
          continue;
        }
        commands.push({ ...command, payload: { requestId, projectName: logRequest.projectName, serviceName: logRequest.serviceName, tail: logRequest.tail, ...(logRequest.since ? { since: logRequest.since } : {}) } });
        continue;
      }
      if (command.type === 'traefik.route.sync') {
        const routeId = command.payload.routeId;
        const deployment = typeof routeId === 'string' && UUID_PATTERN.test(routeId) ? await options.store.getRouteDeployment(routeId) : null;
        if (!deployment || deployment.gatewayAgentId !== agent.id) {
          await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Route deployment is unavailable for this agent.' });
          continue;
        }
        commands.push({
          ...command,
          payload: {
            routeId: deployment.id,
            name: deployment.name,
            hostname: deployment.hostname,
            exposure: deployment.exposure,
            backends: deployment.backends,
            enabled: deployment.enabled,
            revision: deployment.revision,
          },
        });
        continue;
      }
      if (command.type === 'service.logs.read') {
        const stackId = command.payload.stackId;
        const deployment = typeof stackId === 'string' ? await options.store.getStackDeployment(stackId) : null;
        if (!deployment || deployment.agentId !== agent.id) {
          await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Stack logs are unavailable for this agent.' });
          continue;
        }
        commands.push({ ...command, payload: {
          stackId, service: command.payload.service, tail: command.payload.tail, ...(command.payload.since ? { since: command.payload.since } : {}),
          projectName: deployment.projectName, stackPath: deployment.id, composePath: `${deployment.id}/compose.yaml`,
        } });
        continue;
      }
      if (command.type === 'stack.backup.create') {
        const backupId = command.payload.backupId;
        const deployment = typeof backupId === 'string' ? await options.store.getBackupDeployment(backupId) : null;
        if (!deployment || deployment.stack.agentId !== agent.id) {
          await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Stack backup is unavailable for this agent.' });
          continue;
        }
        commands.push({ ...command, payload: {
          backupId, stackId: deployment.stack.id, projectName: deployment.stack.projectName, revision: deployment.backup.stackRevision,
          target: deployment.backup.target, stackPath: deployment.stack.id, composePath: `${deployment.stack.id}/compose.yaml`,
          ...(deployment.stack.postgresBackupConfig ? { postgres: deployment.stack.postgresBackupConfig } : {}),
        } });
        continue;
      }
      if (command.type === 'stack.restore.apply') {
        const restoreId = command.payload.restoreId;
        const deployment = typeof restoreId === 'string' ? await options.store.getRestoreDeployment(restoreId) : null;
        if (!deployment || deployment.stack.agentId !== agent.id) {
          await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Stack restore is unavailable for this agent.' });
          continue;
        }
        commands.push({ ...command, payload: {
          restoreId, backupId: deployment.backup.id, stackId: deployment.stack.id, projectName: deployment.stack.projectName,
          revision: deployment.backup.stackRevision, target: deployment.backup.target,
          stackPath: deployment.stack.id, composePath: `${deployment.stack.id}/compose.yaml`,
          ...(deployment.stack.postgresBackupConfig ? { postgres: deployment.stack.postgresBackupConfig } : {}),
        } });
        continue;
      }
      if (command.type === 'cloudflare.connector.remove') {
        const connectorId = command.payload.connectorId;
        const revision = command.payload.revision;
        if (typeof connectorId !== 'string' || !UUID_PATTERN.test(connectorId) || typeof revision !== 'number') {
          await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Connector cleanup payload is invalid.' });
          continue;
        }
        commands.push({ ...command, payload: { connectorId, revision } });
        continue;
      }
      if (command.type !== 'cloudflare.connector.sync') {
        commands.push(command);
        continue;
      }
      const connectorId = command.payload.connectorId;
      const deployment = typeof connectorId === 'string' && UUID_PATTERN.test(connectorId)
        ? await options.store.getConnectorDeployment(connectorId)
        : null;
      const revision = command.payload.revision;
      if (!deployment || deployment.agentId !== agent.id || typeof revision !== 'number' || deployment.desiredRevision !== revision) {
        await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Connector deployment is unavailable for this agent.' });
        continue;
      }
      if (!deployment.enabled) {
        commands.push({ ...command, payload: { connectorId: deployment.connectorId, revision, enabled: false } });
        continue;
      }
      if (deployment.identityStatus !== 'verified') {
        await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Connector identity is not verified.' });
        continue;
      }
      let token: string;
      try {
        token = secretBox.decrypt(deployment.encryptedToken);
      } catch {
        await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Connector credentials could not be decrypted.' });
        continue;
      }
      commands.push({
        ...command,
        payload: { connectorId: deployment.connectorId, revision, name: deployment.name, enabled: true, token },
      });
    }
    return { commands };
  });
  app.post('/api/agent/commands/:id/result', { preHandler: requireAgent }, async (request) => {
    const body = objectBody(request.body);
    const status = stringField(body, 'status') as 'succeeded' | 'failed';
    if (!['succeeded', 'failed'].includes(status)) throw new ApiError(400, 'status must be succeeded or failed.');
    const result = body.result === undefined ? {} : objectBody(body.result);
    if (JSON.stringify(result).length > 262_144) throw new ApiError(400, 'Command result is too large.');
    const outcome = await options.store.completeCommand((request as AgentRequest).authenticatedAgent.id, idParameter(request), status, result);
    if (outcome === 'missing') throw new ApiError(404, 'Command not found.');
    if (outcome === 'conflict') throw new ApiError(409, 'The command is not in a claimable completion state.');
    return { accepted: true, idempotent: outcome === 'idempotent' };
  });

  app.get('/api/commands', { preHandler: (request, reply) => requireUser(request, reply) }, async (request) => {
    const agentId = (request.query as { agentId?: unknown }).agentId;
    if (agentId !== undefined && (typeof agentId !== 'string' || !UUID_PATTERN.test(agentId))) throw new ApiError(400, 'agentId must be a valid UUID.');
    const commands = await options.store.listCommands(agentId as string | undefined);
    return {
      commands: commands.map((command) => {
        if (!['cloudflare.connector.sync', 'compose.stack.sync', 'compose.runtime.logs', 'traefik.route.sync'].includes(command.type)) return command;
        const { result: _sensitiveResult, ...publicCommand } = command;
        return publicCommand;
      }),
    };
  });
  app.get('/api/commands/:id', { preHandler: (request, reply) => requireUser(request, reply) }, async (request) => {
    const command = await options.store.getCommand(idParameter(request));
    if (!command) throw new ApiError(404, 'Command not found.');
    if (command.type !== 'agent.diagnostics.run') return { command: { id: command.id, status: command.status, type: command.type } };
    return { command };
  });
  app.post('/api/agents/:id/diagnostics', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const command = await options.store.createCommand(idParameter(request), 'agent.diagnostics.run', {});
    if (!command) throw new ApiError(404, 'Enabled Agent not found.');
    return reply.code(202).send({ command });
  });
  app.get('/api/log-requests/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const command = await options.store.getLogRequest(idParameter(request), (request as AuthenticatedRequest).authenticatedUser.id);
    if (!command) throw new ApiError(404, 'Log request not found.');
    const logs = typeof command.result?.logs === 'string' ? command.result.logs : typeof command.result?.output === 'string' ? command.result.output : null;
    return { command: { id: command.id, status: command.status, result: logs === null ? null : { logs, truncated: command.result?.truncated === true } } };
  });
  app.get('/api/monitoring/summary', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ agents: await options.store.getMonitoringSummary() }));
  app.get('/api/monitoring/agents/:id', { preHandler: (request, reply) => requireUser(request, reply) }, async (request) => {
    const monitoring = await options.store.getAgentMonitoring(idParameter(request));
    if (!monitoring) throw new ApiError(404, 'Agent not found.');
    return monitoring;
  });
  app.get('/api/backups', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ backups: (await options.store.listBackups()).map(publicBackup) }));
  app.get('/api/restores', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ restores: (await options.store.listRestores()).map(publicRestore) }));
  app.post('/api/backups/:id/restore', { preHandler: (request, reply) => requireUser(request, reply, 'owner') }, async (request, reply) => {
    const created = await options.store.createRestore(idParameter(request), (request as AuthenticatedRequest).authenticatedUser.id);
    if (created === 'active') throw new ApiError(409, 'This stack already has an active backup or restore operation.');
    if (!created) throw new ApiError(409, 'Only a succeeded backup for an enabled stack and agent can be restored.');
    return reply.code(202).send({ restore: publicRestore(created) });
  });
  app.get('/api/system-backups', { preHandler: (request, reply) => requireUser(request, reply, 'owner') }, async () => ({
    backups: (await options.store.listSystemBackups()).map(publicSystemBackup),
    restores: (await options.store.listSystemRestores()).map(publicSystemRestore),
  }));
  app.post('/api/system-backups', { preHandler: (request, reply) => requireUser(request, reply, 'owner') }, async (request, reply) => {
    if (!options.systemRecoveryService) throw new ApiError(503, 'System recovery is not configured.');
    const body = objectBody(request.body);
    const target = stringField(body, 'target') as 'local' | 'nas';
    if (!['local', 'nas'].includes(target)) throw new ApiError(400, 'target must be local or nas.');
    const passphrase = opaqueStringField(body, 'passphrase', 16, 1024);
    try {
      const backup = await options.systemRecoveryService.createBackup({ requestedByUserId: (request as AuthenticatedRequest).authenticatedUser.id, target, passphrase });
      return reply.code(201).send({ backup: publicSystemBackup(backup) });
    } catch (error) {
      if (error instanceof SystemRecoveryFailure) throw new ApiError(error.statusCode, error.message, error.code);
      throw error;
    }
  });
  app.post('/api/system-backups/:id/stage-restore', { preHandler: (request, reply) => requireUser(request, reply, 'owner') }, async (request, reply) => {
    if (!options.systemRecoveryService) throw new ApiError(503, 'System recovery is not configured.');
    const passphrase = opaqueStringField(objectBody(request.body), 'passphrase', 16, 1024);
    try {
      const result = await options.systemRecoveryService.stageRestore({ backupId: idParameter(request), requestedByUserId: (request as AuthenticatedRequest).authenticatedUser.id, passphrase });
      return reply.code(202).send({
        restore: publicSystemRestore(result.restore),
        manualRestoreRequired: result.manualRestoreRequired,
        restoreCommand: result.restoreCommand,
      });
    } catch (error) {
      if (error instanceof SystemRecoveryFailure) throw new ApiError(error.statusCode, error.message, error.code);
      throw error;
    }
  });
  app.post('/api/commands', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const body = objectBody(request.body);
    const agentId = stringField(body, 'agentId');
    if (!UUID_PATTERN.test(agentId)) throw new ApiError(400, 'agentId must be a valid UUID.');
    const type = stringField(body, 'type', 1, 120);
    if (!USER_COMMAND_TYPES.has(type)) throw new ApiError(400, 'type is not an allowed user command.');
    const payload = body.payload === undefined ? {} : objectBody(body.payload);
    if (JSON.stringify(payload).length > 262_144) throw new ApiError(400, 'Command payload is too large.');
    const command = await options.store.createCommand(agentId, type, payload);
    if (!command) throw new ApiError(404, 'Enabled agent not found.');
    return reply.code(201).send({ command });
  });

  if (options.webRoot) {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Route not found.' });
    });
  }

  app.addHook('onClose', async () => {
    notificationDispatcher.stop();
    if (connectorIdentityStartupTimer) clearTimeout(connectorIdentityStartupTimer);
    if (connectorIdentityTimer) clearInterval(connectorIdentityTimer);
    await options.store.close();
  });
  return app;
}
