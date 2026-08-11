import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';

export const DEPLOYMENT_POLICY_VERSION = 2;
const MAX_ALIASES = 20;
const MAX_NODES = 10_000;
const MAX_ENVIRONMENT_ENTRIES = 100;
const MAX_ENVIRONMENT_VALUE = 2048;
const SECRET_KEY_PATTERN = /(?:^|_)(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL)(?:_|$)/i;
const PARAMETER_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$/;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TOP_LEVEL_KEYS = new Set(['services', 'volumes', 'networks']);
const SERVICE_KEYS = new Set(['image', 'restart', 'healthcheck', 'environment', 'ports', 'expose', 'network_mode', 'depends_on', 'volumes', 'networks', 'labels', 'logging', 'deploy', 'user', 'working_dir', 'read_only', 'tmpfs', 'stop_grace_period', 'init', 'pull_policy', 'security_opt']);

export interface ComposePolicyResult {
  policyVersion: number;
  normalizedCompose: string;
  checksum: string;
  services: Array<{ name: string; image: string; digestPinned: boolean; healthcheck: boolean }>;
  warnings: Array<{ code: string; service?: string }>;
}

export class ComposePolicyError extends Error {
  public constructor(public readonly code: string, message: string, public readonly service?: string) { super(message); }
}

type JsonObject = Record<string, unknown>;

export function evaluateComposePolicy(source: string, projectName: string, parameters: Record<string, string | number | boolean> = {}): ComposePolicyResult {
  if (!PROJECT_PATTERN.test(projectName)) throw new ComposePolicyError('invalid_project', 'projectName is invalid.');
  const expanded = substituteParameters(source, parameters);
  const document = parseDocument(expanded, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0) throw new ComposePolicyError('invalid_yaml', 'Compose YAML could not be parsed safely.');
  let nodeCount = 0;
  if (document.contents) walk(document.contents, () => { nodeCount += 1; });
  if (nodeCount > MAX_NODES) throw new ComposePolicyError('compose_too_complex', 'Compose document is too complex.');
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: MAX_ALIASES }); } catch { throw new ComposePolicyError('aliases_exceeded', 'Compose aliases exceed the allowed limit.'); }
  if (!isObject(value)) throw new ComposePolicyError('invalid_compose', 'Compose must be a mapping.');
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, 'unsupported_top_level');
  if (!isObject(value.services)) throw new ComposePolicyError('services_required', 'Compose services must be a mapping.');
  const serviceEntries = Object.entries(value.services);
  if (serviceEntries.length < 1 || serviceEntries.length > 50) throw new ComposePolicyError('service_count', 'Compose must contain between 1 and 50 services.');
  validateNamedResources(value.volumes, 'volume');
  validateNamedResources(value.networks, 'network');
  const warnings: ComposePolicyResult['warnings'] = [];
  const services: ComposePolicyResult['services'] = [];
  for (const [name, rawService] of serviceEntries) {
    if (!SERVICE_PATTERN.test(name) || !isObject(rawService)) throw new ComposePolicyError('invalid_service', `Service ${name} is invalid.`, name);
    rejectUnknownKeys(rawService, SERVICE_KEYS, 'unsupported_service_key', name);
    for (const forbidden of ['build', 'privileged', 'use_api_socket', 'network_mode', 'ports', 'expose', 'pid', 'ipc', 'devices', 'cap_add', 'command', 'entrypoint', 'extends']) {
      if (forbidden in rawService) throw new ComposePolicyError(`forbidden_${forbidden}`, `${forbidden} is not allowed.`, name);
    }
    const image = rawService.image;
    if (typeof image !== 'string' || !IMAGE_PATTERN.test(image) || !hasPinnedImage(image) || /:latest(?:@|$)/i.test(image)) throw new ComposePolicyError('image_not_pinned', 'Each service image must have an explicit non-latest tag or sha256 digest.', name);
    const digestPinned = image.includes('@sha256:');
    if (!digestPinned) warnings.push({ code: 'image_digest_recommended', service: name });
    if (!['always', 'unless-stopped', 'on-failure'].includes(String(rawService.restart ?? ''))) throw new ComposePolicyError('restart_required', 'Each service requires always, unless-stopped, or on-failure restart policy.', name);
    validateEnvironment(rawService.environment, name);
    validateVolumes(rawService.volumes, name);
    validateSecurityOptions(rawService.security_opt, name);
    validateDeploy(rawService, name, warnings);
    if (!isObject(rawService.healthcheck)) warnings.push({ code: 'healthcheck_recommended', service: name });
    services.push({ name, image, digestPinned, healthcheck: isObject(rawService.healthcheck) });
  }
  const normalized = sortObject(value);
  const normalizedCompose = stringify(normalized, { lineWidth: 0, sortMapEntries: true }).trimEnd() + '\n';
  return { policyVersion: DEPLOYMENT_POLICY_VERSION, normalizedCompose, checksum: createHash('sha256').update(normalizedCompose).digest('hex'), services, warnings };
}

function substituteParameters(source: string, parameters: Record<string, string | number | boolean>): string {
  const entries = Object.entries(parameters);
  if (entries.length > 50) throw new ComposePolicyError('parameter_count', 'At most 50 parameters are allowed.');
  for (const [key, value] of entries) {
    if (!PARAMETER_KEY_PATTERN.test(key) || SECRET_KEY_PATTERN.test(key) || String(value).length > 256) throw new ComposePolicyError('invalid_parameter', 'Parameters must be bounded, non-secret, typed values.');
  }
  const used = new Set<string>();
  const expanded = source.replace(/\$\{([A-Z][A-Z0-9_]{0,63})\}/g, (_match, key: string) => {
    if (!(key in parameters)) throw new ComposePolicyError('parameter_required', `Parameter ${key} is required.`);
    used.add(key);
    return JSON.stringify(parameters[key]);
  });
  if (/\$\{/.test(expanded) || entries.some(([key]) => !used.has(key))) throw new ComposePolicyError('invalid_parameter', 'Only declared and used ${NAME} parameters are supported.');
  return expanded;
}

function validateNamedResources(value: unknown, kind: string): void {
  if (value === undefined) return;
  if (!isObject(value)) throw new ComposePolicyError(`invalid_${kind}s`, `${kind}s must be a mapping.`);
  for (const [name, definition] of Object.entries(value)) {
    if (!SERVICE_PATTERN.test(name) || !isObject(definition) || definition.external === true || 'name' in definition) throw new ComposePolicyError(`unsafe_${kind}`, `Only project-scoped named ${kind}s are allowed.`);
    rejectUnknownKeys(definition, kind === 'volume' ? new Set(['driver', 'driver_opts', 'labels']) : new Set(['driver', 'driver_opts', 'internal', 'labels']), `unsupported_${kind}`);
  }
}

function validateEnvironment(value: unknown, service: string): void {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value.map((item) => String(item).split(/=(.*)/s).slice(0, 2)) : isObject(value) ? Object.entries(value) : [];
  if (entries.length < 1 || entries.length > MAX_ENVIRONMENT_ENTRIES) throw new ComposePolicyError('invalid_environment', 'Environment entries are invalid or exceed the limit.', service);
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key ?? '') || SECRET_KEY_PATTERN.test(key ?? '') || item === null || item === undefined || !['string', 'number', 'boolean'].includes(typeof item) || String(item).length > MAX_ENVIRONMENT_VALUE) {
      throw new ComposePolicyError('unsafe_environment', 'Environment values must be bounded non-secret literals.', service);
    }
  }
}

function validateVolumes(value: unknown, service: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 50) throw new ComposePolicyError('unsafe_volume', 'Service volumes must be a bounded list of named volumes.', service);
  for (const mount of value) {
    if (typeof mount === 'string') {
      const source = mount.split(':', 1)[0]!;
      if (!SERVICE_PATTERN.test(source) || source === '.' || source.includes('/') || source.includes('\\') || source === '/var/run/docker.sock') throw new ComposePolicyError('unsafe_volume', 'Bind mounts and Docker socket mounts are not allowed.', service);
    } else if (!isObject(mount) || mount.type !== 'volume' || typeof mount.source !== 'string' || !SERVICE_PATTERN.test(mount.source) || typeof mount.target !== 'string' || !mount.target.startsWith('/')) {
      throw new ComposePolicyError('unsafe_volume', 'Only named volume mounts are allowed.', service);
    }
  }
}

function validateSecurityOptions(value: unknown, service: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || /(?:seccomp|apparmor):?unconfined|label:disable/i.test(item))) throw new ComposePolicyError('unsafe_security_opt', 'Security options may not disable isolation.', service);
}

function validateDeploy(service: JsonObject, name: string, warnings: ComposePolicyResult['warnings']): void {
  if (service.deploy === undefined) service.deploy = {};
  if (!isObject(service.deploy)) throw new ComposePolicyError('invalid_deploy', 'deploy must be a mapping.', name);
  rejectUnknownKeys(service.deploy, new Set(['resources', 'restart_policy']), 'unsupported_deploy', name);
  if ('placement' in service.deploy) throw new ComposePolicyError('forbidden_placement', 'Deploy placement is not allowed.', name);
  const resources = service.deploy.resources;
  if (resources === undefined) {
    service.deploy.resources = { limits: { cpus: '1.0', memory: '512M' } };
    warnings.push({ code: 'resource_defaults_injected', service: name });
    return;
  }
  if (!isObject(resources)) throw new ComposePolicyError('invalid_resources', 'deploy.resources must be a mapping.', name);
  rejectUnknownKeys(resources, new Set(['limits', 'reservations']), 'unsupported_resources', name);
  if (isObject(resources.reservations) && 'devices' in resources.reservations) throw new ComposePolicyError('forbidden_device_reservation', 'Device reservations are not allowed.', name);
  if (!isObject(resources.limits) || !validCpu(resources.limits.cpus) || !validMemory(resources.limits.memory)) throw new ComposePolicyError('resource_limits_required', 'CPU and memory limits are required.', name);
}

function validCpu(value: unknown): boolean { const number = Number(value); return Number.isFinite(number) && number >= 0.1 && number <= 8; }
function validMemory(value: unknown): boolean { const match = typeof value === 'string' && /^(\d+)([KMG])$/i.exec(value); if (!match) return false; const bytes = Number(match[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2]!.toUpperCase()]!); return bytes >= 32 * 1024 ** 2 && bytes <= 16 * 1024 ** 3; }
function hasPinnedImage(image: string): boolean { const leaf = image.slice(image.lastIndexOf('/') + 1); return image.includes('@sha256:') || leaf.includes(':'); }
function isObject(value: unknown): value is JsonObject { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function rejectUnknownKeys(value: JsonObject, allowed: Set<string>, code: string, service?: string): void { const key = Object.keys(value).find((item) => !allowed.has(item)); if (key) throw new ComposePolicyError(code, `${key} is not supported by the deployment policy.`, service); }
function sortObject(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortObject); if (!isObject(value)) return value; return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortObject(item)])); }
function walk(node: unknown, visit: () => void): void { if (!node || typeof node !== 'object') return; visit(); const record = node as { items?: unknown[]; key?: unknown; value?: unknown }; for (const item of record.items ?? []) walk(item, visit); walk(record.key, visit); walk(record.value, visit); }
