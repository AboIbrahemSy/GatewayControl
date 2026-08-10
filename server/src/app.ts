import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { parseDocument } from 'yaml';
import { SecretBox, hashPassword, hashToken, randomToken, verifyPassword } from './crypto.js';
import { CloudflareClient, CloudflareClientError, type CloudflareIngressRule } from './cloudflare-client.js';
import { NotificationDispatcher } from './notification-dispatcher.js';
import { SystemRecoveryFailure, type SystemRecoveryService } from './system-recovery.js';
import { OPERATIONAL_EVENT_TYPES, type Agent, type AgentCommand, type Role, type StackBackup, type StackRestore, type Store, type SystemBackup, type SystemRestore, type User } from './types.js';

const SESSION_COOKIE = 'gateway_control_session';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$/i;
const USER_COMMAND_TYPES = new Set(['ping', 'docker.info', 'agent.diagnostics.run', 'compose.ps', 'compose.up', 'compose.stop', 'compose.restart']);
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DOCKER_VOLUME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/;
const MAX_COMPOSE_BYTES = 512 * 1024;
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
  systemRecoveryService?: SystemRecoveryService;
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

function enrollmentCommand(baseUrl: string, image: string, enrollmentToken: string, agentId: string, agentName: string, traefikDynamicVolume: string, nasRoot: string, nasMarker: string): string {
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

function validateComposeYaml(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_COMPOSE_BYTES) throw new ApiError(400, 'composeYaml must not exceed 512 KiB.');
  const document = parseDocument(value, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) throw new ApiError(400, 'composeYaml is not valid YAML.');
  let compose: unknown;
  try {
    compose = document.toJS({ maxAliasCount: 50 });
  } catch {
    throw new ApiError(400, 'composeYaml contains unsafe or excessive aliases.');
  }
  if (!compose || typeof compose !== 'object' || Array.isArray(compose)) throw new ApiError(400, 'composeYaml must contain a top-level mapping.');
  const root = compose as Record<string, unknown>;
  if (!root.services || typeof root.services !== 'object' || Array.isArray(root.services)) throw new ApiError(400, 'composeYaml must contain a top-level services object.');
  if ('include' in root) throw new ApiError(400, 'External Compose file references are not allowed.');
  for (const service of Object.values(root.services as Record<string, unknown>)) {
    if (!service || typeof service !== 'object' || Array.isArray(service)) continue;
    const definition = service as Record<string, unknown>;
    if (definition.privileged === true || definition.use_api_socket === true) throw new ApiError(400, 'Privileged services and Docker API socket access are not allowed.');
    const extension = definition.extends;
    if (extension && typeof extension === 'object' && !Array.isArray(extension) && 'file' in extension) throw new ApiError(400, 'External Compose file references are not allowed.');
    if (Array.isArray(definition.volumes) && definition.volumes.some((mount) => {
      if (typeof mount === 'string') return /(?:^|:)\/{1,2}(?:var\/run|run)\/docker\.sock(?::|$)/i.test(mount);
      if (!mount || typeof mount !== 'object' || Array.isArray(mount)) return false;
      const volume = mount as Record<string, unknown>;
      return [volume.source, volume.target].some((path) => typeof path === 'string' && /\/(?:var\/run|run)\/docker\.sock$/i.test(path));
    })) throw new ApiError(400, 'Docker socket mounts are not allowed.');
  }
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
    if (typeof validated.name !== 'string' || !SERVICE_NAME_PATTERN.test(validated.name)) throw new ApiError(400, `services[${index}].name is invalid.`);
    if (typeof validated.status !== 'string' || !['healthy', 'unhealthy', 'starting', 'stopped', 'unknown'].includes(validated.status)) throw new ApiError(400, `services[${index}].status is invalid.`);
    return validated;
  });
  if (new Set(services.map((service) => service.name)).size !== services.length) throw new ApiError(400, 'services must have unique names.');
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
  const notificationDispatcher = new NotificationDispatcher({
    store: options.store, secretBox, fetch: httpFetch, logger: app.log,
    ...(options.notificationIntervalMs !== undefined ? { intervalMs: options.notificationIntervalMs } : {}),
    ...(options.offlineAfterMs !== undefined ? { offlineAfterMs: options.offlineAfterMs } : {}),
    ...(options.commandStaleAfterMs !== undefined ? { commandStaleAfterMs: options.commandStaleAfterMs } : {}),
  });

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

  async function reconcileCloudflareHostname(id: string): Promise<unknown> {
    const deployment = await options.store.getCloudflareHostnameDeployment(id);
    if (!deployment) throw new ApiError(409, 'Cloudflare hostname deployment relationships are no longer valid.');
    let apiToken: string;
    try {
      apiToken = secretBox.decrypt(deployment.encryptedApiToken);
    } catch {
      await options.store.markCloudflareHostnameOutcome(id, { status: 'failed', enabled: deployment.enabled, lastError: 'Cloudflare account credentials could not be decrypted.' });
      throw new ApiError(500, 'Cloudflare account credentials could not be decrypted.');
    }
    const client = new CloudflareClient(apiToken, httpFetch);
    let originalIngress: CloudflareIngressRule[];
    try {
      originalIngress = await client.getTunnelConfig(deployment.accountIdentifier, deployment.tunnelId);
      if (deployment.enabled) {
        await client.putTunnelConfig(deployment.accountIdentifier, deployment.tunnelId, enabledIngress(originalIngress, deployment.hostname));
        let dnsRecordId: string;
        try {
          dnsRecordId = await client.createDnsCname(deployment.zoneIdentifier, deployment.hostname, deployment.tunnelId, deployment.proxied);
        } catch (error) {
          try {
            await client.putTunnelConfig(deployment.accountIdentifier, deployment.tunnelId, originalIngress);
          } catch {
            // Preserve the original DNS failure as the actionable, safely bounded error.
          }
          throw error;
        }
        return await options.store.markCloudflareHostnameOutcome(id, { status: 'active', enabled: true, dnsRecordId, lastError: null });
      }
      if (deployment.dnsRecordId) {
        try {
          await client.deleteDnsRecord(deployment.zoneIdentifier, deployment.dnsRecordId);
        } catch (error) {
          if (!(error instanceof CloudflareClientError && error.isExplicitNotFound())) throw error;
        }
      }
      await client.putTunnelConfig(deployment.accountIdentifier, deployment.tunnelId, disabledIngress(originalIngress, deployment.hostname));
      return await options.store.markCloudflareHostnameOutcome(id, { status: 'active', enabled: false, dnsRecordId: null, lastError: null });
    } catch (error) {
      const safeError = safeCloudflareError(error);
      await options.store.markCloudflareHostnameOutcome(id, { status: 'failed', enabled: deployment.enabled, lastError: safeError });
      throw new ApiError(502, safeError);
    }
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
  app.addHook('onReady', async () => notificationDispatcher.start());

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (request.url.startsWith('/api/') || request.url === '/health') {
      reply.header('cache-control', 'no-store');
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    } else {
      reply.header('content-security-policy', "default-src 'self'; connect-src 'self'; font-src 'self' data:; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
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

  app.get('/health', async () => ({ status: 'ok' }));

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
    const name = stringField(body, 'name', 1, 120);
    const token = opaqueStringField(body, 'token', 20, 4096);
    const enabled = optionalBoolean(body, 'enabled') ?? true;
    const agentId = stringField(body, 'agentId', 36, 36);
    if (!UUID_PATTERN.test(agentId)) throw new ApiError(400, 'agentId must be a valid UUID.');
    const cloudflareAccountId = optionalUuid(body, 'cloudflareAccountId');
    const tunnelId = optionalUuid(body, 'tunnelId');
    if (tunnelId && !cloudflareAccountId) throw new ApiError(400, 'cloudflareAccountId is required when tunnelId is provided.');
    const connector = await options.store.createConnector(name, secretBox.encrypt(token), enabled, agentId, cloudflareAccountId, tunnelId);
    if (!connector) throw new ApiError(404, 'Enabled agent not found.');
    return reply.code(201).send({ connector });
  });
  app.patch('/api/connectors/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const id = idParameter(request);
    const body = objectBody(request.body);
    const name = body.name === undefined ? undefined : stringField(body, 'name', 1, 120);
    const token = body.token === undefined ? undefined : opaqueStringField(body, 'token', 20, 4096);
    const enabled = optionalBoolean(body, 'enabled');
    const agentId = body.agentId === undefined ? undefined : stringField(body, 'agentId', 36, 36);
    if (agentId !== undefined && !UUID_PATTERN.test(agentId)) throw new ApiError(400, 'agentId must be a valid UUID.');
    const cloudflareAccountId = optionalUuid(body, 'cloudflareAccountId');
    const tunnelId = optionalUuid(body, 'tunnelId');
    if (name === undefined && token === undefined && enabled === undefined && agentId === undefined && cloudflareAccountId === undefined && tunnelId === undefined) throw new ApiError(400, 'At least one editable field is required.');
    const connector = await options.store.updateConnector(id, {
      ...(name !== undefined ? { name } : {}),
      ...(token !== undefined ? { encryptedToken: secretBox.encrypt(token) } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(cloudflareAccountId !== undefined ? { cloudflareAccountId } : {}),
      ...(tunnelId !== undefined ? { tunnelId } : {}),
    });
    if (!connector) throw new ApiError(404, 'Connector not found.');
    return { connector };
  });

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
    const body = objectBody(request.body);
    const name = body.name === undefined ? undefined : stringField(body, 'name', 1, 120);
    const accountIdentifier = body.accountIdentifier === undefined ? undefined : cloudflareIdentifier(body, 'accountIdentifier');
    const apiToken = body.apiToken === undefined ? undefined : opaqueStringField(body, 'apiToken', 20, 4096);
    const enabled = optionalBoolean(body, 'enabled');
    if (name === undefined && accountIdentifier === undefined && apiToken === undefined && enabled === undefined) throw new ApiError(400, 'At least one editable field is required.');
    const account = await options.store.updateCloudflareAccount(idParameter(request), {
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
  app.get('/api/cloudflare/public-hostnames', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ publicHostnames: await options.store.listCloudflarePublicHostnames() }));
  app.post('/api/cloudflare/public-hostnames', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const body = objectBody(request.body);
    const created = await options.store.createPendingCloudflarePublicHostname({
      zoneId: optionalUuid(body, 'zoneId') ?? (() => { throw new ApiError(400, 'zoneId is required.'); })(),
      connectorId: optionalUuid(body, 'connectorId') ?? (() => { throw new ApiError(400, 'connectorId is required.'); })(),
      routeId: optionalUuid(body, 'routeId') ?? (() => { throw new ApiError(400, 'routeId is required.'); })(),
      proxied: optionalBoolean(body, 'proxied') ?? true,
    });
    if (!created) throw new ApiError(409, 'Zone, account, connector, tunnel, or enabled tunnel route relationships are invalid or already managed.');
    const reconciled = await reconcileCloudflareHostname(created.id);
    return reply.code(201).send({ publicHostname: reconciled });
  });
  app.patch('/api/cloudflare/public-hostnames/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const body = objectBody(request.body);
    const enabled = optionalBoolean(body, 'enabled');
    if (enabled === undefined || Object.keys(body).some((key) => key !== 'enabled')) throw new ApiError(400, 'Only enabled may be updated.');
    const pending = await options.store.setCloudflarePublicHostnamePending(idParameter(request), enabled);
    if (!pending) throw new ApiError(404, 'Cloudflare public hostname not found.');
    if (pending.status === 'active') return { publicHostname: pending };
    return { publicHostname: await reconcileCloudflareHostname(pending.id) };
  });

  app.get('/api/stacks', { preHandler: (request, reply) => requireUser(request, reply) }, async () => ({ stacks: await options.store.listStacks() }));
  app.post('/api/stacks', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const body = objectBody(request.body);
    const agentId = stringField(body, 'agentId', 36, 36);
    if (!UUID_PATTERN.test(agentId)) throw new ApiError(400, 'agentId must be a valid UUID.');
    const name = validateResourceName(stringField(body, 'name', 1, 63));
    const projectName = stringField(body, 'projectName', 1, 63);
    if (!PROJECT_NAME_PATTERN.test(projectName)) throw new ApiError(400, 'projectName must use lowercase letters, numbers, underscores, or hyphens.');
    const composeYaml = validateComposeYaml(opaqueStringField(body, 'composeYaml', 1, MAX_COMPOSE_BYTES));
    const postgresBackupConfig = optionalPostgresBackupConfig(body);
    const stack = await options.store.createStack({
      agentId,
      name,
      projectName,
      encryptedComposeYaml: secretBox.encrypt(composeYaml),
      enabled: optionalBoolean(body, 'enabled') ?? true,
      ...(postgresBackupConfig ? { postgresBackupConfig } : {}),
    });
    if (!stack) throw new ApiError(404, 'Enabled agent not found.');
    return reply.code(201).send({ stack });
  });
  app.patch('/api/stacks/:id', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request) => {
    const body = objectBody(request.body);
    const name = body.name === undefined ? undefined : validateResourceName(stringField(body, 'name', 1, 63));
    const composeYaml = body.composeYaml === undefined ? undefined : validateComposeYaml(opaqueStringField(body, 'composeYaml', 1, MAX_COMPOSE_BYTES));
    const enabled = optionalBoolean(body, 'enabled');
    const postgresBackupConfig = optionalPostgresBackupConfig(body);
    if (name === undefined && composeYaml === undefined && enabled === undefined && postgresBackupConfig === undefined) throw new ApiError(400, 'At least one editable field is required.');
    const stack = await options.store.updateStack(idParameter(request), {
      ...(name !== undefined ? { name } : {}),
      ...(composeYaml !== undefined ? { encryptedComposeYaml: secretBox.encrypt(composeYaml) } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(postgresBackupConfig !== undefined ? { postgresBackupConfig } : {}),
    });
    if (!stack) throw new ApiError(404, 'Stack or enabled agent not found.');
    return { stack };
  });
  for (const action of ['restart', 'stop'] as const) {
    app.post(`/api/stacks/:id/${action}`, { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
      const command = await options.store.queueStackAction(idParameter(request), `compose.${action}`);
      if (!command) throw new ApiError(404, 'Enabled stack or agent not found.');
      return reply.code(202).send({ command });
    });
  }
  app.post('/api/stacks/:id/logs', { preHandler: (request, reply) => requireUser(request, reply, 'operator') }, async (request, reply) => {
    const body = objectBody(request.body);
    const service = stringField(body, 'service', 1, 128);
    if (!SERVICE_NAME_PATTERN.test(service)) throw new ApiError(400, 'service must be a valid Compose service identifier.');
    const tail = body.tail;
    if (!Number.isInteger(tail) || (tail as number) < 1 || (tail as number) > 1000) throw new ApiError(400, 'tail must be an integer between 1 and 1000.');
    let since: string | undefined;
    if (body.since !== undefined) {
      since = stringField(body, 'since', 20, 40);
      const sinceTime = Date.parse(since);
      if (!RFC3339_PATTERN.test(since) || !Number.isFinite(sinceTime) || sinceTime > Date.now() || sinceTime < Date.now() - 24 * 3_600_000) throw new ApiError(400, 'since must be an RFC3339 timestamp within the last 24 hours.');
      since = new Date(sinceTime).toISOString();
    }
    const user = (request as AuthenticatedRequest).authenticatedUser;
    const command = await options.store.queueLogRequest(idParameter(request), user.id, service, tail as number, since);
    if (!command) throw new ApiError(404, 'Enabled stack or agent not found.');
    return reply.code(202).send({ commandId: command.id, status: command.status });
  });
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
    const route = await options.store.updateRoute(idParameter(request), {
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
        const stackId = command.payload.stackId;
        const deployment = typeof stackId === 'string' && UUID_PATTERN.test(stackId) ? await options.store.getStackDeployment(stackId) : null;
        if (!deployment || deployment.agentId !== agent.id) {
          await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Stack deployment is unavailable for this agent.' });
          continue;
        }
        let composeYaml: string;
        try {
          composeYaml = secretBox.decrypt(deployment.encryptedComposeYaml);
        } catch {
          await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Stack configuration could not be decrypted.' });
          continue;
        }
        commands.push({
          ...command,
          payload: {
            stackId: deployment.id,
            name: deployment.name,
            projectName: deployment.projectName,
            composeYaml,
            enabled: deployment.enabled,
            revision: deployment.revision,
          },
        });
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
      if (command.type !== 'cloudflare.connector.sync') {
        commands.push(command);
        continue;
      }
      const connectorId = command.payload.connectorId;
      const deployment = typeof connectorId === 'string' && UUID_PATTERN.test(connectorId)
        ? await options.store.getConnectorDeployment(connectorId)
        : null;
      if (!deployment || deployment.agentId !== agent.id) {
        await options.store.completeCommand(agent.id, command.id, 'failed', { error: 'Connector deployment is unavailable for this agent.' });
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
        payload: { connectorId: deployment.connectorId, name: deployment.name, enabled: deployment.enabled, token },
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
        if (!['cloudflare.connector.sync', 'compose.stack.sync', 'traefik.route.sync'].includes(command.type)) return command;
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
      return reply.code(202).send({ restore: publicSystemRestore(result.restore), restartRequired: result.restartRequired });
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
    await options.store.close();
  });
  return app;
}
