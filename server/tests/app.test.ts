import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { CloudflareClient } from '../src/cloudflare-client.js';
import { hashToken } from '../src/crypto.js';
import { SecretBox } from '../src/crypto.js';
import { NotificationDispatcher } from '../src/notification-dispatcher.js';
import { OPERATIONAL_EVENT_TYPES } from '../src/types.js';
import { FakeStore } from './fake-store.js';
import { SystemRecoveryFailure, type SystemRecoveryService } from '../src/system-recovery.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const connectorAccountIdentifier = 'a'.repeat(32);
const connectorTunnelId = '123e4567-e89b-12d3-a456-426614174000';

function tunnelToken(accountIdentifier = connectorAccountIdentifier, tunnelId = connectorTunnelId, secret = Buffer.alloc(32, 7)): string {
  return Buffer.from(JSON.stringify({ a: accountIdentifier, t: tunnelId, s: secret.toString('base64') })).toString('base64');
}

function connectorVerificationFetch(token = tunnelToken()): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith('/token')) return cloudflareResponse(token);
    if (url.includes('/cfd_tunnel/')) return cloudflareResponse({ id: connectorTunnelId, account_tag: connectorAccountIdentifier, deleted_at: null });
    throw new Error(`Unexpected request: ${url}`);
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWithOwner(options: { fetch?: typeof globalThis.fetch; notificationIntervalMs?: number; systemRecoveryService?: SystemRecoveryService; protectedProjects?: string[] } = {}) {
  const store = new FakeStore();
  const app = await buildApp({ store, masterKey: randomBytes(32), secureCookie: false, fetch: options.fetch ?? connectorVerificationFetch(), ...options });
  apps.push(app);
  await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const setCookie = login.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return { app, store, cookie: cookieHeader?.split(';')[0] ?? '' };
}

function cloudflareResponse(result: unknown = {}, options: { status?: number; success?: boolean; errors?: unknown[]; resultInfo?: Record<string, unknown> } = {}): Response {
  return new Response(JSON.stringify({ success: options.success ?? true, result, errors: options.errors ?? [], ...(options.resultInfo ? { result_info: options.resultInfo } : {}) }), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('control-plane API', () => {
  it('keeps liveness independent and reports bounded database readiness without leaking errors', async () => {
    const readinessCheck = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('postgresql://secret@database/private'));
    const store = new FakeStore();
    const app = await buildApp({ store, masterKey: randomBytes(32), secureCookie: false, readinessCheck, release: '2026.08.10' });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok', release: '2026.08.10' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', release: '2026.08.10' });
    const unavailable = await app.inject({ method: 'GET', url: '/ready' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ status: 'unavailable', release: '2026.08.10' });
    expect(unavailable.body).not.toContain('secret');
  });

  it('allows bundled data fonts in the application content security policy', async () => {
    const store = new FakeStore();
    const app = await buildApp({ store, masterKey: randomBytes(32), secureCookie: false });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.headers['content-security-policy']).toContain("font-src 'self' data:");
  }, 15_000);

  it('reports first-run state and allows owner setup exactly once', async () => {
    const store = new FakeStore();
    const app = await buildApp({ store, masterKey: randomBytes(32), secureCookie: false });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ setupComplete: false });
    const first = await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'other@example.com', password: 'another secure password' } });
    expect(second.statusCode).toBe(409);
  }, 15_000);

  it('enforces roles and never returns connector tokens', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('connector-gateway', hashToken('pending-enrollment-token-that-is-long'));
    store.agents[0]!.enrolledAt = new Date().toISOString();
    await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Connector account', accountIdentifier: connectorAccountIdentifier, apiToken: 'cloudflare-api-token-that-is-long-enough' } });
    const token = tunnelToken();
    const created = await app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie }, payload: { name: 'primary', token, agentId: agent.id } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(token);
    expect(store.connectors[0]?.encryptedToken).not.toContain(token);
    expect(created.json().connector.agentId).toBe(agent.id);
    expect(store.commands).toHaveLength(1);
    expect(store.commands[0]).toMatchObject({ agentId: agent.id, type: 'cloudflare.connector.sync', payload: { connectorId: created.json().connector.id }, status: 'pending' });
    expect(JSON.stringify(store.commands)).not.toContain(token);
    const browserCommands = await app.inject({ method: 'GET', url: '/api/commands', headers: { cookie } });
    expect(browserCommands.body).not.toContain(token);

    const patched = await app.inject({ method: 'PATCH', url: `/api/connectors/${created.json().connector.id}`, headers: { cookie }, payload: { enabled: false } });
    expect(patched.statusCode).toBe(200);
    expect(store.commands).toHaveLength(1);
    expect(store.commands[0]).toMatchObject({ type: 'cloudflare.connector.sync', payload: { connectorId: created.json().connector.id } });
    const replacementAgent = await store.createAgent('replacement-gateway', hashToken('replacement-enrollment-token-that-is-long'));
    store.agents.find((item) => item.id === replacementAgent.id)!.enrolledAt = new Date().toISOString();
    const reassigned = await app.inject({
      method: 'PATCH', url: `/api/connectors/${created.json().connector.id}`, headers: { cookie },
      payload: { name: 'renamed', token, agentId: replacementAgent.id },
    });
    expect(reassigned.statusCode).toBe(200);
    expect(reassigned.body).not.toContain(token);
    expect(store.commands).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: replacementAgent.id, type: 'cloudflare.connector.sync', payload: { connectorId: created.json().connector.id, revision: 3 } })]));
    expect(JSON.stringify(store.commands)).not.toContain(token);

    const viewer = await store.createUser('viewer@example.com', store.users[0]!.passwordHash, 'viewer');
    store.sessions.set(hashToken('viewer-session-token-that-is-long-enough'), viewer.id);
    const forbidden = await app.inject({
      method: 'POST', url: '/api/connectors', headers: { cookie: 'gateway_control_session=viewer-session-token-that-is-long-enough' },
      payload: { name: 'forbidden', token, agentId: agent.id },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('exchanges an enrollment token once and accepts agent credentials', async () => {
    const { app, store, cookie } = await appWithOwner();
    const definition = await app.inject({ method: 'POST', url: '/api/agents', headers: { cookie }, payload: { name: 'edge-one', baseUrl: 'https://control.example.test', image: 'example/gateway-agent:1.0.0' } });
    expect(definition.statusCode).toBe(201);
    const body = definition.json();
    expect(body.enrollmentCommand).toContain('docker run');
    expect(body.enrollmentCommand).toContain('--pull always');
    expect(body.enrollmentCommand).toContain('--entrypoint /bin/sh');
    expect(body.enrollmentCommand).toContain('chown 10001:10001 /opt/gateway-control/stacks /opt/gateway-control/backups/local /srv/traefik-dynamic');
    expect(body.enrollmentCommand).toContain('GATEWAY_STATE_VOLUME');
    expect(body.enrollmentCommand).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(body.enrollmentCommand).toContain('GATEWAY_CONTROL_URL=');
    expect(body.enrollmentCommand).toContain('GATEWAY_ENROLLMENT_TOKEN=');
    expect(body.enrollmentCommand).toContain('GATEWAY_AGENT_NAME=');
    expect(body.enrollmentCommand).toContain('GATEWAY_STATE_DIR=/var/lib/gateway-agent');
    expect(body.enrollmentCommand).toContain('GATEWAY_STATE_VOLUME=');
    expect(body.enrollmentCommand).toContain('GATEWAY_STACKS_ROOT=/opt/gateway-control/stacks');
    expect(body.enrollmentCommand).toContain('GATEWAY_HOST_STACKS_ROOT=/opt/gateway-control/stacks');
    expect(body.enrollmentCommand).toContain('GATEWAY_DEPLOYMENTS_ROOT=/opt/gateway-control/deployments');
    expect(body.enrollmentCommand).toContain('GATEWAY_HOST_DEPLOYMENTS_ROOT=/opt/gateway-control/deployments');
    expect(body.enrollmentCommand).toContain("GATEWAY_AGENT_IMAGE='example/gateway-agent:1.0.0'");
    expect(body.enrollmentCommand).toContain('GATEWAY_HOST_PROC_ROOT=/host/proc');
    expect(body.enrollmentCommand).toContain('GATEWAY_LOCAL_BACKUP_ROOT=/opt/gateway-control/backups/local');
    expect(body.enrollmentCommand).toContain("GATEWAY_NAS_BACKUP_ROOT='/mnt/gateway-control-backups'");
    expect(body.enrollmentCommand).toContain("GATEWAY_NAS_MARKER='.gateway-control-nas'");
    expect(body.enrollmentCommand).toContain('GATEWAY_TRAEFIK_DYNAMIC_ROOT=/srv/traefik-dynamic');
    expect(body.enrollmentCommand).toContain("GATEWAY_TRAEFIK_DYNAMIC_VOLUME='gateway-traefik-dynamic'");
    expect(body.enrollmentCommand).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(body.enrollmentCommand).toContain('/var/lib/gateway-agent');
    expect(body.enrollmentCommand).toContain('/opt/gateway-control/stacks:/opt/gateway-control/stacks');
    expect(body.enrollmentCommand).toContain('/opt/gateway-control/deployments:/opt/gateway-control/deployments');
    expect(body.enrollmentCommand).toContain('/proc:/host/proc:ro');
    expect(body.enrollmentCommand).toContain('/opt/gateway-control/backups/local:/opt/gateway-control/backups/local');
    expect(body.enrollmentCommand).toContain("'/mnt/gateway-control-backups:/mnt/gateway-control-backups'");
    expect(body.enrollmentCommand).toContain("'gateway-traefik-dynamic':/srv/traefik-dynamic");
    expect(body.enrollmentCommand).toContain('--group-add');
    expect(store.agents[0]?.enrollmentTokenHash).not.toBe(body.enrollmentToken);

    const enrollment = await app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { enrollmentToken: body.enrollmentToken } });
    expect(enrollment.statusCode).toBe(200);
    const credential = enrollment.json().credential;
    expect(store.agents[0]?.credentialHash).toBe(hashToken(credential));
    const reuse = await app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { enrollmentToken: body.enrollmentToken } });
    expect(reuse.statusCode).toBe(401);
    const heartbeat = await app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: { authorization: `Bearer ${credential}` }, payload: { version: '1.0.0' } });
    expect(heartbeat.statusCode).toBe(200);

    const localDefinition = await app.inject({ method: 'POST', url: '/api/agents', headers: { cookie }, payload: { name: 'local-edge', baseUrl: 'http://127.0.0.1:8080', image: 'gateway-control-agent:local' } });
    expect(localDefinition.json().enrollmentCommand).toContain("docker image inspect 'gateway-control-agent:local'");
    expect(localDefinition.json().enrollmentCommand).toContain('Build or load it on this host before enrollment.');
    expect(localDefinition.json().enrollmentCommand).not.toContain('exit 1');
    expect(localDefinition.json().enrollmentCommand).toContain('--pull never');
    expect(localDefinition.json().enrollmentCommand).toContain('GATEWAY_ALLOW_INSECURE_HTTP=true');
    expect(localDefinition.json().enrollmentCommand).toContain("GATEWAY_CONTROL_URL='http://host.docker.internal:8080'");
    expect(localDefinition.json().enrollmentCommand).toContain('--add-host host.docker.internal:host-gateway');
  });

  it('propagates the canonical configurable NAS root and marker to Agent enrollment', async () => {
    const store = new FakeStore();
    const app = await buildApp({
      store,
      masterKey: randomBytes(32),
      secureCookie: false,
      systemBackupNasRoot: '/srv/shared-gateway-nas',
      systemBackupNasMarker: '.trusted-gateway-nas',
      protectedProjects: ['gateway-control', 'critical_api'],
    });
    apps.push(app);
    await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: { name: 'custom-nas', baseUrl: 'https://control.example.test', image: 'example/gateway-agent:1.0.0' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().enrollmentCommand).toContain("GATEWAY_NAS_BACKUP_ROOT='/srv/shared-gateway-nas'");
    expect(response.json().enrollmentCommand).toContain("GATEWAY_HOST_NAS_BACKUP_ROOT='/srv/shared-gateway-nas'");
    expect(response.json().enrollmentCommand).toContain("GATEWAY_NAS_MARKER='.trusted-gateway-nas'");
    expect(response.json().enrollmentCommand).toContain("GATEWAY_PROTECTED_PROJECTS='gateway-control,critical_api'");
    expect(response.json().enrollmentCommand).toContain("'/srv/shared-gateway-nas:/srv/shared-gateway-nas'");
    expect(response.json().enrollmentCommand).not.toContain('/mnt/gateway-control-backups');
  });

  it('lets only owners safely remove unassigned agents and returns host cleanup instructions', async () => {
    const { app, store, cookie } = await appWithOwner();
    const pendingResponse = await app.inject({
      method: 'POST', url: '/api/agents', headers: { cookie },
      payload: { name: 'pending-removal', baseUrl: 'https://control.example.test', image: 'example/gateway-agent:1.0.0' },
    });
    const pendingAgent = pendingResponse.json().agent;
    const operator = await store.createUser('operator@example.com', store.users[0]!.passwordHash, 'operator');
    store.sessions.set(hashToken('operator-session-token-that-is-long-enough'), operator.id);

    const forbidden = await app.inject({
      method: 'DELETE', url: `/api/agents/${pendingAgent.id}`,
      headers: { cookie: 'gateway_control_session=operator-session-token-that-is-long-enough' },
    });
    expect(forbidden.statusCode).toBe(403);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/agents/${pendingAgent.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ mode: 'deleted' });
    expect(deleted.json().cleanupCommand).toContain(`gateway-agent-${pendingAgent.id.slice(0, 8)}`);
    expect(store.agents.some((agent) => agent.id === pendingAgent.id)).toBe(false);

    const enrolledResponse = await app.inject({
      method: 'POST', url: '/api/agents', headers: { cookie },
      payload: { name: 'enrolled-removal', baseUrl: 'https://control.example.test', image: 'example/gateway-agent:1.0.0' },
    });
    const enrolledBody = enrolledResponse.json();
    const enrollment = await app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { enrollmentToken: enrolledBody.enrollmentToken } });
    const credential = enrollment.json().credential;
    const archived = await app.inject({ method: 'DELETE', url: `/api/agents/${enrolledBody.agent.id}`, headers: { cookie } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ mode: 'archived' });
    expect((await store.listAgents()).some((agent) => agent.id === enrolledBody.agent.id)).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: { authorization: `Bearer ${credential}` }, payload: {} })).statusCode).toBe(401);

    const assigned = await store.createAgent('assigned-removal', hashToken('assigned-enrollment-token-that-is-long'));
    await store.createStack({ agentId: assigned.id, name: 'assigned-stack', projectName: 'assigned-stack', encryptedComposeYaml: 'encrypted', enabled: false });
    const blocked = await app.inject({ method: 'DELETE', url: `/api/agents/${assigned.id}`, headers: { cookie } });
    expect(blocked.statusCode).toBe(409);
    expect((await store.listAgents()).some((agent) => agent.id === assigned.id)).toBe(true);
  });

  it('preserves configured Telegram credentials when only events change', async () => {
    const { app, store, cookie } = await appWithOwner();
    const missing = await app.inject({ method: 'PUT', url: '/api/notifications/telegram', headers: { cookie }, payload: { selectedEvents: ['agent.offline'] } });
    expect(missing.statusCode).toBe(409);
    const partial = await app.inject({ method: 'PUT', url: '/api/notifications/telegram', headers: { cookie }, payload: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd', selectedEvents: [] } });
    expect(partial.statusCode).toBe(400);
    const configured = await app.inject({
      method: 'PUT', url: '/api/notifications/telegram', headers: { cookie },
      payload: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd', groupId: '-1001234567890', selectedEvents: ['agent.offline'] },
    });
    expect(configured.statusCode).toBe(200);
    const originalSecrets = { ...store.notificationSecrets! };
    const updated = await app.inject({ method: 'PUT', url: '/api/notifications/telegram', headers: { cookie }, payload: { selectedEvents: ['deployment.failed'] } });
    expect(updated.statusCode).toBe(200);
    expect(store.notificationSecrets).toEqual(originalSecrets);
    expect(store.selectedEvents).toEqual(['deployment.failed']);
    const unsupported = await app.inject({ method: 'PUT', url: '/api/notifications/telegram', headers: { cookie }, payload: { selectedEvents: ['command.failed'] } });
    expect(unsupported.statusCode).toBe(400);
  });

  it('defaults new Telegram settings to every operational event while preserving intentional global opt-outs', async () => {
    const { app, store, cookie } = await appWithOwner();
    const defaults = await app.inject({ method: 'GET', url: '/api/notifications/telegram', headers: { cookie } });
    expect(defaults.json()).toEqual({ configured: false, selectedEvents: [...OPERATIONAL_EVENT_TYPES] });

    await app.inject({ method: 'PUT', url: '/api/notifications/telegram', headers: { cookie }, payload: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd', groupId: '-1001234567890', selectedEvents: [] } });
    expect((await app.inject({ method: 'GET', url: '/api/notifications/telegram', headers: { cookie } })).json().selectedEvents).toEqual([]);
    expect(store.selectedEvents).toEqual([]);
  });

  it('returns hierarchical notification preferences and authorizes scope changes by role', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('notification-agent', hashToken('notification-agent-enrollment-token'));
    store.agents[0]!.enrolledAt = new Date().toISOString();
    await store.recordTelemetry(agent.id, {
      observedAt: new Date().toISOString(), node: {},
      services: [{ name: 'alpha/web', projectName: 'alpha', serviceName: 'web', status: 'healthy' }],
    });
    const operator = await store.createUser('notification-operator@example.com', store.users[0]!.passwordHash, 'operator');
    const viewer = await store.createUser('notification-viewer@example.com', store.users[0]!.passwordHash, 'viewer');
    store.sessions.set(hashToken('notification-operator-session-long-enough'), operator.id);
    store.sessions.set(hashToken('notification-viewer-session-long-enough'), viewer.id);
    const operatorCookie = 'gateway_control_session=notification-operator-session-long-enough';
    const viewerCookie = 'gateway_control_session=notification-viewer-session-long-enough';

    expect((await app.inject({ method: 'GET', url: '/api/notifications/topology', headers: { cookie: viewerCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/notifications/agents/${agent.id}`, headers: { cookie: viewerCookie }, payload: { enabled: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/notifications/telegram', headers: { cookie: operatorCookie }, payload: { selectedEvents: [] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/telegram/test', headers: { cookie: operatorCookie } })).statusCode).toBe(403);

    const mutedAgent = await app.inject({ method: 'PATCH', url: `/api/notifications/agents/${agent.id}`, headers: { cookie: operatorCookie }, payload: { enabled: false } });
    expect(mutedAgent.json().agent).toMatchObject({ enabled: false, services: [{ projectName: 'alpha', serviceName: 'web', enabled: false, inherited: true, directlyEnabled: true }] });
    const mutedService = await app.inject({ method: 'PATCH', url: '/api/notifications/services', headers: { cookie: operatorCookie }, payload: { agentId: agent.id, projectName: 'alpha', serviceName: 'web', enabled: false } });
    expect(mutedService.json().service).toMatchObject({ enabled: false, inherited: false, directlyEnabled: false });
    const repeated = await app.inject({ method: 'PATCH', url: '/api/notifications/services', headers: { cookie: operatorCookie }, payload: { agentId: agent.id, projectName: 'alpha', serviceName: 'web', enabled: false } });
    expect(repeated.statusCode).toBe(200);
    store.telemetry.length = 0;
    expect((await store.getNotificationTopology()).agents[0]?.services[0]).toMatchObject({ projectName: 'alpha', serviceName: 'web', discovered: false });
    expect((await app.inject({ method: 'PATCH', url: '/api/notifications/services', headers: { cookie: operatorCookie }, payload: { agentId: agent.id, projectName: 'missing', serviceName: 'unknown', enabled: false } })).statusCode).toBe(404);
  });

  it('bounds notification topology responses for viewers and marks truncation', async () => {
    const { app, store } = await appWithOwner();
    const viewer = await store.createUser('bounded-viewer@example.com', store.users[0]!.passwordHash, 'viewer');
    store.sessions.set(hashToken('bounded-viewer-session-long-enough'), viewer.id);
    for (let index = 0; index < 101; index += 1) await store.createAgent(`bounded-agent-${String(index).padStart(3, '0')}`, hashToken(`bounded-enrollment-token-${index}-long-enough`));

    const response = await app.inject({ method: 'GET', url: '/api/notifications/topology', headers: { cookie: 'gateway_control_session=bounded-viewer-session-long-enough' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().agents).toHaveLength(100);
    expect(response.json().truncated).toEqual({ agents: true, services: false, scopes: false });
  });

  it('applies agent and service notification routing and rechecks policy before send', async () => {
    const masterKey = randomBytes(32);
    const secretBox = new SecretBox(masterKey);
    const store = new FakeStore();
    const owner = await store.createOwner('routing-owner@example.com', 'password-hash');
    const agent = await store.createAgent('routing-agent', hashToken('routing-agent-enrollment-token'));
    store.agents[0]!.enrolledAt = new Date().toISOString();
    await store.saveNotificationSettings(secretBox.encrypt('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd'), secretBox.encrypt('-1001234567890'), [...OPERATIONAL_EVENT_TYPES]);
    const healthy = { observedAt: new Date(Date.now() - 1_000).toISOString(), node: {}, services: [{ name: 'alpha/web', projectName: 'alpha', serviceName: 'web', status: 'healthy' }] };
    await store.recordTelemetry(agent.id, healthy);
    await store.recordTelemetry(agent.id, { ...healthy, observedAt: new Date().toISOString(), services: [{ ...healthy.services[0]!, status: 'unhealthy' }] });
    expect(store.deliveries).toHaveLength(1);
    expect(store.events[0]?.payload).toMatchObject({ agentId: agent.id, projectName: 'alpha', serviceName: 'web' });

    await store.setServiceNotificationPreference(agent.id, 'alpha', 'web', false, owner!.id);
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const dispatcher = new NotificationDispatcher({ store, secretBox, fetch: fetchMock, logger: { error: vi.fn() } as never });
    await dispatcher.tick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.deliveries[0]?.status).toBe('skipped');

    await store.setServiceNotificationPreference(agent.id, 'alpha', 'web', true, owner!.id);
    await store.recordTelemetry(agent.id, { ...healthy, observedAt: new Date(Date.now() + 1_000).toISOString() });
    await store.recordTelemetry(agent.id, { ...healthy, observedAt: new Date(Date.now() + 2_000).toISOString(), services: [{ ...healthy.services[0]!, status: 'unhealthy' }] });
    await dispatcher.tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.deliveries.some((delivery) => delivery.eventType === 'service.recovered' && delivery.status === 'succeeded')).toBe(true);

    await store.recordTelemetry(agent.id, { ...healthy, observedAt: new Date(Date.now() + 2_500).toISOString(), services: [{ ...healthy.services[0]!, status: 'stopped' }] });
    await store.recordTelemetry(agent.id, { ...healthy, observedAt: new Date(Date.now() + 2_750).toISOString(), services: [{ ...healthy.services[0]!, status: 'running' }] });
    expect(store.events.at(-2)?.type).toBe('service.stopped');
    expect(store.events.at(-1)?.type).toBe('service.recovered');

    await store.setAgentNotificationPreference(agent.id, false, owner!.id);
    await store.recordTelemetry(agent.id, { ...healthy, observedAt: new Date(Date.now() + 3_000).toISOString() });
    await store.recordTelemetry(agent.id, { ...healthy, observedAt: new Date(Date.now() + 4_000).toISOString(), services: [{ ...healthy.services[0]!, status: 'unhealthy' }] });
    expect(store.deliveries).toHaveLength(5);
    store.agents[0]!.lastHeartbeatAt = new Date(Date.now() - 10_000).toISOString();
    await store.sweepOfflineAgents(new Date(Date.now() - 5_000));
    expect(store.events.find((event) => event.type === 'agent.offline')?.payload).toMatchObject({ agentId: agent.id });
    expect(store.deliveries).toHaveLength(5);
  });

  it('decorates connector sync only for the assigned authenticated agent', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('cloudflare-gateway', hashToken('unused-enrollment-token-that-is-long'));
    const credential = 'persistent-cloudflare-credential-that-is-long-enough';
    const storedAgent = store.agents.find((item) => item.id === agent.id)!;
    storedAgent.credentialHash = hashToken(credential);
    storedAgent.enrolledAt = new Date().toISOString();
    await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Command account', accountIdentifier: connectorAccountIdentifier, apiToken: 'cloudflare-api-token-that-is-long-enough' } });
    const token = tunnelToken();
    const created = await app.inject({
      method: 'POST', url: '/api/connectors', headers: { cookie },
      payload: { name: 'primary-tunnel', token, agentId: agent.id },
    });
    const connectorId = created.json().connector.id;
    expect(store.commands[0]?.payload).toEqual({ connectorId, revision: 1 });
    const polled = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().commands[0]).toMatchObject({
      type: 'cloudflare.connector.sync',
      payload: { connectorId, revision: 1, name: 'primary-tunnel', enabled: true, token },
    });
    expect(store.commands[0]?.payload).toEqual({ connectorId, revision: 1 });

    const otherAgent = await store.createAgent('other-gateway', hashToken('other-enrollment-token-that-is-long'));
    const otherCredential = 'other-persistent-credential-that-is-long-enough';
    const storedOtherAgent = store.agents.find((item) => item.id === otherAgent.id)!;
    storedOtherAgent.credentialHash = hashToken(otherCredential);
    storedOtherAgent.enrolledAt = new Date().toISOString();
    const mismatched = await store.createCommand(otherAgent.id, 'cloudflare.connector.sync', { connectorId, revision: 1 });
    const rejectedPoll = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${otherCredential}` } });
    expect(rejectedPoll.json().commands).toEqual([]);
    expect(mismatched?.status).toBe('failed');
    expect(JSON.stringify(mismatched)).not.toContain('cloudflare-connector-token');
  });

  it('validates standalone enrollment IDs and restricts user commands', async () => {
    const { app, store, cookie } = await appWithOwner();
    const invalidEnrollment = await app.inject({
      method: 'POST', url: '/api/agents/enrollment-command', headers: { cookie },
      payload: { baseUrl: 'https://control.example.test', image: 'example/agent:1', enrollmentToken: 'enrollment-token-that-is-sufficiently-long', agentId: 'not-a-uuid', agentName: 'edge' },
    });
    expect(invalidEnrollment.statusCode).toBe(400);
    const agent = await store.createAgent('command-gateway', hashToken('unused-enrollment-token-that-is-long'));
    const allowed = await app.inject({ method: 'POST', url: '/api/commands', headers: { cookie }, payload: { agentId: agent.id, type: 'ping', payload: {} } });
    expect(allowed.statusCode).toBe(201);
    const internal = await app.inject({ method: 'POST', url: '/api/commands', headers: { cookie }, payload: { agentId: agent.id, type: 'cloudflare.connector.sync', payload: { connectorId: randomUUID() } } });
    expect(internal.statusCode).toBe(400);
    const arbitrary = await app.inject({ method: 'POST', url: '/api/commands', headers: { cookie }, payload: { agentId: agent.id, type: 'shell.exec', payload: {} } });
    expect(arbitrary.statusCode).toBe(400);
  });

  it('disables legacy stack mutations while preserving legacy history', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('stack-gateway', hashToken('stack-enrollment-token-that-is-long-enough'));
    const legacy = await store.createStack({ agentId: agent.id, name: 'legacy', projectName: 'legacy', encryptedComposeYaml: 'encrypted', enabled: true });
    for (const request of [
      { method: 'POST' as const, url: '/api/stacks', payload: {} },
      { method: 'PATCH' as const, url: `/api/stacks/${legacy!.id}`, payload: {} },
      { method: 'POST' as const, url: `/api/stacks/${legacy!.id}/restart`, payload: {} },
      { method: 'POST' as const, url: `/api/stacks/${legacy!.id}/logs`, payload: {} },
    ]) {
      const response = await app.inject({ ...request, headers: { cookie } });
      expect(response.statusCode).toBe(410);
      expect(response.json().code).toBe('legacy_stack_mutation_disabled');
    }
    expect((await app.inject({ method: 'GET', url: '/api/stacks', headers: { cookie } })).json().stacks).toHaveLength(1);
    for (const type of ['compose.ps', 'compose.up', 'compose.stop', 'compose.restart']) {
      expect((await app.inject({ method: 'POST', url: '/api/commands', headers: { cookie }, payload: { agentId: agent.id, type, payload: {} } })).statusCode).toBe(400);
    }
  });

  it('validates and decorates Traefik routes only for their gateway', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('route-gateway', hashToken('route-enrollment-token-that-is-long-enough'));
    const credential = 'route-agent-credential-that-is-long-enough';
    const storedAgent = store.agents.find((item) => item.id === agent.id)!;
    storedAgent.credentialHash = hashToken(credential);
    storedAgent.enrolledAt = new Date().toISOString();
    const created = await app.inject({
      method: 'POST', url: '/api/routes', headers: { cookie },
      payload: { gatewayAgentId: agent.id, name: 'internal-app', hostname: 'app.example.test', exposure: 'tunnel', backends: ['http://192.168.1.20:8080/'], enabled: true },
    });
    expect(created.statusCode).toBe(201);
    const routeId = created.json().route.id;
    expect(store.commands[0]).toMatchObject({ type: 'traefik.route.sync', payload: { routeId } });
    const polled = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(polled.json().commands[0]).toMatchObject({
      type: 'traefik.route.sync',
      payload: { routeId, hostname: 'app.example.test', exposure: 'tunnel', backends: ['http://192.168.1.20:8080/'] },
    });
    const completed = await app.inject({
      method: 'POST', url: `/api/agent/commands/${store.commands[0]!.id}/result`, headers: { authorization: `Bearer ${credential}` },
      payload: { status: 'failed', result: { reason: 'test' } },
    });
    expect(completed.statusCode).toBe(200);
    expect(store.routes[0]?.status).toBe('failed');

    const otherAgent = await store.createAgent('unrelated-route-gateway', hashToken('unrelated-route-enrollment-token-long'));
    const otherCredential = 'unrelated-route-agent-credential-long-enough';
    const storedOtherAgent = store.agents.find((item) => item.id === otherAgent.id)!;
    storedOtherAgent.credentialHash = hashToken(otherCredential);
    storedOtherAgent.enrolledAt = new Date().toISOString();
    const mismatched = await store.createCommand(otherAgent.id, 'traefik.route.sync', { routeId });
    const unrelatedPoll = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${otherCredential}` } });
    expect(unrelatedPoll.json().commands).toEqual([]);
    expect(mismatched?.status).toBe('failed');

    for (const payload of [
      { gatewayAgentId: agent.id, name: 'unicode', hostname: 'éxample.test', exposure: 'public', backends: ['http://127.0.0.1'] },
      { gatewayAgentId: agent.id, name: 'credentials', hostname: 'credentials.test', exposure: 'public', backends: ['http://user:pass@127.0.0.1'] },
      { gatewayAgentId: agent.id, name: 'fragment', hostname: 'fragment.test', exposure: 'public', backends: ['http://127.0.0.1/#secret'] },
    ]) {
      expect((await app.inject({ method: 'POST', url: '/api/routes', headers: { cookie }, payload })).statusCode).toBe(400);
    }
    const internalStack = await app.inject({ method: 'POST', url: '/api/commands', headers: { cookie }, payload: { agentId: agent.id, type: 'compose.stack.sync', payload: { stackId: randomUUID() } } });
    const internalRoute = await app.inject({ method: 'POST', url: '/api/commands', headers: { cookie }, payload: { agentId: agent.id, type: 'traefik.route.sync', payload: { routeId: randomUUID() } } });
    expect(internalStack.statusCode).toBe(400);
    expect(internalRoute.statusCode).toBe(400);
  });

  it('handles command completion idempotently', async () => {
    const { app, store } = await appWithOwner();
    const agent = await store.createAgent('edge-two', hashToken('unused-enrollment-token-that-is-long'));
    const credential = 'persistent-agent-credential-that-is-long-enough';
    const storedAgent = store.agents.find((item) => item.id === agent.id)!;
    storedAgent.credentialHash = hashToken(credential);
    storedAgent.enrolledAt = new Date().toISOString();
    const command = await store.createCommand(agent.id, 'reload', {});
    await store.claimCommands(agent.id, 20);
    const request = { method: 'POST' as const, url: `/api/agent/commands/${command!.id}/result`, headers: { authorization: `Bearer ${credential}` }, payload: { status: 'succeeded', result: { applied: true } } };
    expect((await app.inject(request)).json()).toEqual({ accepted: true, idempotent: false });
    expect((await app.inject(request)).json()).toEqual({ accepted: true, idempotent: true });

    const reordered = await store.createCommand(agent.id, 'reload', {});
    await store.claimCommands(agent.id, 1);
    const first = { method: 'POST' as const, url: `/api/agent/commands/${reordered!.id}/result`, headers: { authorization: `Bearer ${credential}` }, payload: { status: 'succeeded', result: { first: 1, second: 2 } } };
    const duplicate = { ...first, payload: { status: 'succeeded', result: { second: 2, first: 1 } } };
    expect((await app.inject(first)).json().idempotent).toBe(false);
    expect((await app.inject(duplicate)).json().idempotent).toBe(true);
  });

  it('accepts bounded telemetry only from agents and exposes monitoring to viewers', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('telemetry-agent', hashToken('telemetry-enrollment-token-long-enough'));
    const credential = 'telemetry-agent-credential-long-enough';
    store.agents[0]!.credentialHash = hashToken(credential);
    store.agents[0]!.enrolledAt = new Date().toISOString();
    const snapshot = { observedAt: new Date().toISOString(), node: { hostname: 'nas-one', cpuPercent: 12.5 }, services: [
      { name: 'gateway-control/server', projectName: 'gateway-control', serviceName: 'server', status: 'healthy', total: 1, running: 1, healthy: 1, unhealthy: 0, starting: 0, stopped: 0, completed: 0 },
      { name: 'gateway-control/bootstrap', projectName: 'gateway-control', serviceName: 'bootstrap', status: 'completed', total: 1, running: 0, healthy: 0, unhealthy: 0, starting: 0, stopped: 0, completed: 1 },
      { name: 'firefox/browser', projectName: 'firefox', serviceName: 'browser', status: 'running', total: 1, running: 1, healthy: 0, unhealthy: 0, starting: 0, stopped: 0, completed: 0 },
    ] };
    expect((await app.inject({ method: 'POST', url: '/api/agent/telemetry', payload: snapshot })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/agent/telemetry', headers: { authorization: `Bearer ${credential}` }, payload: snapshot })).statusCode).toBe(200);
    const invalid = { ...snapshot, services: Array.from({ length: 251 }, (_, index) => ({ ...snapshot.services[0], name: `site/service-${index}`, serviceName: `service-${index}` })) };
    expect((await app.inject({ method: 'POST', url: '/api/agent/telemetry', headers: { authorization: `Bearer ${credential}` }, payload: invalid })).statusCode).toBe(400);
    const viewer = await store.createUser('monitor@example.com', store.users[0]!.passwordHash, 'viewer');
    store.sessions.set(hashToken('monitor-viewer-session-token-long-enough'), viewer.id);
    const viewerCookie = 'gateway_control_session=monitor-viewer-session-token-long-enough';
    const summary = await app.inject({ method: 'GET', url: '/api/monitoring/summary', headers: { cookie: viewerCookie } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().agents[0]).toMatchObject({ agentId: agent.id, node: { hostname: 'nas-one' } });
    const runtimeProjects = await app.inject({ method: 'GET', url: '/api/runtime-projects', headers: { cookie: viewerCookie } });
    expect(runtimeProjects.json().projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectName: 'gateway-control', status: 'healthy' }),
      expect.objectContaining({ projectName: 'firefox', status: 'running' }),
    ]));
    expect((await app.inject({ method: 'GET', url: `/api/monitoring/agents/${agent.id}`, headers: { cookie } })).json().history).toHaveLength(1);

    const futureClock = { ...snapshot, observedAt: new Date(Date.now() + 4 * 60_000).toISOString(), node: { source: 'future-clock' } };
    const newerReceived = { ...snapshot, observedAt: new Date(Date.now() - 60_000).toISOString(), node: { source: 'newer-received' } };
    await app.inject({ method: 'POST', url: '/api/agent/telemetry', headers: { authorization: `Bearer ${credential}` }, payload: futureClock });
    await app.inject({ method: 'POST', url: '/api/agent/telemetry', headers: { authorization: `Bearer ${credential}` }, payload: newerReceived });
    const latest = await app.inject({ method: 'GET', url: '/api/monitoring/summary', headers: { cookie: viewerCookie } });
    expect(latest.json().agents[0].node).toEqual({ source: 'newer-received' });
  });

  it('rejects stale, offline, protected, unknown, and malformed runtime action targets with stable codes', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('runtime-guard-agent', hashToken('runtime-guard-enrollment-token-long'));
    const storedAgent = store.agents[0]!; storedAgent.enrolledAt = new Date().toISOString(); storedAgent.credentialHash = hashToken('runtime-guard-credential-long-enough');
    const service = { name: 'gateway-control/server', projectName: 'gateway-control', serviceName: 'server', status: 'healthy', total: 1, running: 1, healthy: 1, unhealthy: 0, starting: 0, stopped: 0, completed: 0 };
    const payload = { agentId: agent.id, projectName: 'gateway-control', scope: 'project', action: 'restart' };
    expect((await app.inject({ method: 'POST', url: '/api/runtime-actions', headers: { cookie }, payload })).json().code).toBe('agent_unavailable');
    await store.recordTelemetry(agent.id, { observedAt: new Date().toISOString(), node: {}, services: [service] });
    expect((await app.inject({ method: 'POST', url: '/api/runtime-actions', headers: { cookie }, payload })).json().code).toBe('project_protected');
    expect((await app.inject({ method: 'POST', url: '/api/runtime-actions', headers: { cookie }, payload: { ...payload, projectName: 'missing' } })).json().code).toBe('target_not_found');
    store.telemetry[0]!.receivedAt = new Date(Date.now() - 91_000).toISOString();
    expect((await app.inject({ method: 'POST', url: '/api/runtime-actions', headers: { cookie }, payload })).json().code).toBe('telemetry_stale');
    expect((await app.inject({ method: 'POST', url: '/api/runtime-actions', headers: { cookie }, payload: { ...payload, arbitrary: true } })).json().code).toBe('invalid_payload');
  });

  it('authorizes discovered runtime actions and logs with minimal stored commands and owned results', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('logs-agent', hashToken('logs-enrollment-token-long-enough'));
    const credential = 'logs-agent-credential-long-enough';
    store.agents[0]!.credentialHash = hashToken(credential);
    store.agents[0]!.enrolledAt = new Date().toISOString();
    await store.recordTelemetry(agent.id, { observedAt: new Date().toISOString(), node: {}, services: [{ name: 'authoritative/web', projectName: 'authoritative', serviceName: 'web', status: 'healthy', total: 1, running: 1, healthy: 1, unhealthy: 0, starting: 0, stopped: 0, completed: 0 }] });
    await store.saveNotificationSettings('encrypted-token', 'encrypted-group', [...OPERATIONAL_EVENT_TYPES]);
    await store.setServiceNotificationPreference(agent.id, 'authoritative', 'web', false, store.users[0]!.id);
    const viewer = await store.createUser('logs-viewer@example.com', store.users[0]!.passwordHash, 'viewer');
    store.sessions.set(hashToken('logs-viewer-session-token-long-enough'), viewer.id);
    const viewerCookie = 'gateway_control_session=logs-viewer-session-token-long-enough';
    expect((await app.inject({ method: 'GET', url: '/api/runtime-projects', headers: { cookie: viewerCookie } })).statusCode).toBe(200);
    const actionPayload = { agentId: agent.id, projectName: 'authoritative', serviceName: 'web', scope: 'service', action: 'restart' };
    expect((await app.inject({ method: 'POST', url: '/api/runtime-actions', headers: { cookie: viewerCookie }, payload: actionPayload })).statusCode).toBe(403);
    const action = await app.inject({ method: 'POST', url: '/api/runtime-actions', headers: { cookie }, payload: actionPayload });
    expect(action.statusCode).toBe(202);
    expect(store.commands[0]!.payload).toEqual({ operationId: action.json().operation.id });
    expect((await app.inject({ method: 'POST', url: '/api/runtime-actions', headers: { cookie }, payload: actionPayload })).json().code).toBe('operation_active');
    const actionPoll = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(actionPoll.json().commands[0].payload).toEqual({ operationId: action.json().operation.id, projectName: 'authoritative', serviceName: 'web', action: 'restart', scope: 'service' });
    const completion = { method: 'POST' as const, url: `/api/agent/commands/${store.commands[0]!.id}/result`, headers: { authorization: `Bearer ${credential}` }, payload: { status: 'succeeded', result: { matched: 1, succeeded: 1, internalId: 'hidden' } } };
    expect((await app.inject(completion)).json().idempotent).toBe(false);
    expect((await app.inject(completion)).json().idempotent).toBe(true);
    expect(store.events.filter((event) => event.type === 'runtime.action.succeeded')).toHaveLength(1);
    expect(store.events.find((event) => event.type === 'runtime.action.succeeded')).toMatchObject({ agentId: agent.id, projectName: 'authoritative', serviceName: 'web' });
    expect(store.events.find((event) => event.type === 'runtime.action.succeeded')?.payload).toMatchObject({ agentId: agent.id, projectName: 'authoritative', serviceName: 'web' });
    expect(store.deliveries).toHaveLength(0);

    const crashWindowAction = await app.inject({ method: 'POST', url: '/api/runtime-actions', headers: { cookie }, payload: { ...actionPayload, action: 'stop' } });
    const crashWindowCommand = store.commands.at(-1)!;
    const crashWindowOperation = store.runtimeOperations.find((item) => item.id === crashWindowAction.json().operation.id)!;
    crashWindowCommand.status = 'claimed';
    crashWindowOperation.status = 'pending';
    expect(await store.completeCommand(agent.id, crashWindowCommand.id, 'succeeded', { matched: 1 })).toBe('updated');
    expect(crashWindowOperation.status).toBe('succeeded');
    expect(await store.completeCommand(agent.id, crashWindowCommand.id, 'succeeded', { matched: 1 })).toBe('idempotent');

    const queued = await app.inject({ method: 'POST', url: '/api/runtime-log-requests', headers: { cookie }, payload: { agentId: agent.id, projectName: 'authoritative', serviceName: 'web', tail: 100, since: new Date(Date.now() - 60_000).toISOString() } });
    expect(queued.statusCode).toBe(202);
    const logCommand = store.commands.find((command) => command.payload.requestId === queued.json().request.id)!;
    expect(logCommand.payload).toEqual({ requestId: queued.json().request.id });
    const polled = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(polled.json().commands).toHaveLength(1);
    expect(polled.json().commands[0].payload).toMatchObject({ projectName: 'authoritative', serviceName: 'web', tail: 100 });
    expect(polled.json().commands[0].payload).not.toHaveProperty('requestedByUserId');
    const failedLogs = await app.inject({ method: 'POST', url: `/api/agent/commands/${logCommand.id}/result`, headers: { authorization: `Bearer ${credential}` }, payload: { status: 'failed', result: { error: 'runtime log collection failed: permission denied' } } });
    expect(failedLogs.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/runtime-log-requests/${queued.json().request.id}`, headers: { cookie } })).json().request.error).toBe('runtime log collection failed: permission denied');
    expect((await app.inject({ method: 'GET', url: `/api/runtime-log-requests/${queued.json().request.id}`, headers: { cookie } })).statusCode).toBe(200);
    const other = await store.createUser('other@example.com', store.users[0]!.passwordHash, 'operator'); store.sessions.set(hashToken('other-operator-session-token-long-enough'), other.id);
    expect((await app.inject({ method: 'GET', url: `/api/runtime-log-requests/${queued.json().request.id}`, headers: { cookie: 'gateway_control_session=other-operator-session-token-long-enough' } })).statusCode).toBe(404);
  });

  it('restricts configured protected-project logs to owners with a stable code', async () => {
    const { app, store, cookie } = await appWithOwner({ protectedProjects: ['gateway-control', 'critical_api'] });
    const agent = await store.createAgent('protected-logs-agent', hashToken('protected-logs-enrollment-token-long'));
    store.agents[0]!.enrolledAt = new Date().toISOString();
    await store.recordTelemetry(agent.id, { observedAt: new Date().toISOString(), node: {}, services: [{ name: 'critical_api/Web.Service', projectName: 'critical_api', serviceName: 'Web.Service', status: 'healthy', total: 1, running: 1, healthy: 1, unhealthy: 0, starting: 0, stopped: 0, completed: 0 }] });
    const operator = await store.createUser('protected-operator@example.com', store.users[0]!.passwordHash, 'operator');
    store.sessions.set(hashToken('protected-operator-session-token-long'), operator.id);
    const payload = { agentId: agent.id, projectName: 'critical_api', serviceName: 'Web.Service', tail: 100 };
    const denied = await app.inject({ method: 'POST', url: '/api/runtime-log-requests', headers: { cookie: 'gateway_control_session=protected-operator-session-token-long' }, payload });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('protected_logs_owner_required');
    expect((await app.inject({ method: 'POST', url: '/api/runtime-log-requests', headers: { cookie }, payload })).statusCode).toBe(202);
    expect((await app.inject({ method: 'GET', url: '/api/runtime-projects', headers: { cookie } })).json().projects[0].protected).toBe(true);

    const historical = await store.createRuntimeLogRequest({ requestedByUserId: operator.id, agentId: agent.id, projectName: 'critical_api', serviceName: 'Web.Service', tail: 100 });
    const historicalRead = await app.inject({ method: 'GET', url: `/api/runtime-log-requests/${historical!.id}`, headers: { cookie: 'gateway_control_session=protected-operator-session-token-long' } });
    expect(historicalRead.statusCode).toBe(403);
    expect(historicalRead.json().code).toBe('protected_logs_owner_required');
  });

  it('expires runtime log content while retaining terminal audit metadata', async () => {
    const store = new FakeStore();
    const owner = await store.createOwner('owner@example.com', 'password-hash');
    const agent = await store.createAgent('retention-agent', hashToken('retention-enrollment-token-long'));
    agent.enrolledAt = new Date().toISOString();
    const request = await store.createRuntimeLogRequest({ requestedByUserId: owner!.id, agentId: agent.id, projectName: 'project', serviceName: 'web', tail: 100 });
    const command = store.commands.at(-1)!;
    await store.claimCommands(agent.id, 1);
    await store.completeCommand(agent.id, command.id, 'succeeded', { logs: 'token=private', truncated: false });
    request!.completedAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();

    expect(await store.purgeRuntimeLogResults(new Date(Date.now() - 24 * 60 * 60_000))).toBe(1);
    expect(request).toMatchObject({ status: 'succeeded', result: null });
    expect(command).toMatchObject({ status: 'succeeded', result: { truncated: false } });
    expect(JSON.stringify(command)).not.toContain('private');
  });

  it('orchestrates backup completion and owner-only restore using metadata-only responses', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('backup-agent', hashToken('backup-enrollment-token-long-enough'));
    const credential = 'backup-agent-credential-long-enough';
    store.agents[0]!.credentialHash = hashToken(credential);
    store.agents[0]!.enrolledAt = new Date().toISOString();
    const stack = await store.createStack({ agentId: agent.id, name: 'data', projectName: 'data_project', encryptedComposeYaml: 'encrypted', enabled: true });
    store.commands.length = 0;
    const created = await app.inject({ method: 'POST', url: `/api/stacks/${stack!.id}/backups`, headers: { cookie }, payload: { target: 'nas' } });
    expect(created.statusCode).toBe(202);
    expect(created.body).not.toContain('Path');
    const backupId = created.json().backup.id;
    expect(store.commands[0]!.payload).toEqual({ backupId });
    const polled = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(polled.json().commands[0].payload).toMatchObject({ backupId, projectName: 'data_project', revision: 1, target: 'nas', stackPath: stack!.id });
    await app.inject({ method: 'POST', url: `/api/agent/commands/${store.commands[0]!.id}/result`, headers: { authorization: `Bearer ${credential}` }, payload: { status: 'succeeded', result: { sizeBytes: 1234 } } });
    expect(store.backups[0]).toMatchObject({ status: 'succeeded', result: { sizeBytes: 1234 } });
    const operator = await store.createUser('operator@example.com', store.users[0]!.passwordHash, 'operator');
    store.sessions.set(hashToken('operator-session-token-long-enough'), operator.id);
    const operatorCookie = 'gateway_control_session=operator-session-token-long-enough';
    expect((await app.inject({ method: 'POST', url: `/api/backups/${backupId}/restore`, headers: { cookie: operatorCookie } })).statusCode).toBe(403);
    const restored = await app.inject({ method: 'POST', url: `/api/backups/${backupId}/restore`, headers: { cookie } });
    expect(restored.statusCode).toBe(202);
    expect(store.commands[1]!.payload).toEqual({ restoreId: restored.json().restore.id });
    const listedRestores = await app.inject({ method: 'GET', url: '/api/restores', headers: { cookie } });
    expect(listedRestores.statusCode).toBe(200);
    expect(listedRestores.json().restores[0]).toMatchObject({ id: restored.json().restore.id, backupId, status: 'pending' });
    const restorePoll = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(restorePoll.json().commands[0].payload).toMatchObject({ backupId, target: 'nas', projectName: 'data_project' });
  });

  it('restricts system recovery to owners, validates passphrases, and returns metadata-only staging results', async () => {
    const now = new Date().toISOString();
    const createBackup = vi.fn(async () => ({
      id: randomUUID(), requestedByUserId: 'private-user', target: 'local' as const, status: 'succeeded' as const,
      sizeBytes: 4096, checksum: 'a'.repeat(64), error: null, createdAt: now, completedAt: now,
      artifactPath: '/private/system.gcsb', masterKey: 'private-key', passphrase: 'never-return-this',
    }));
    const stageRestore = vi.fn(async (input: { backupId: string }) => ({
      restore: { id: randomUUID(), backupId: input.backupId, requestedByUserId: 'private-user', status: 'staged' as const, error: null, createdAt: now, completedAt: now },
      manualRestoreRequired: true as const,
      restoreCommand: 'sh docker/recover.sh',
    }));
    const { app, store, cookie } = await appWithOwner({ systemRecoveryService: { createBackup, stageRestore } });
    const operator = await store.createUser('system-operator@example.com', store.users[0]!.passwordHash, 'operator');
    store.sessions.set(hashToken('system-operator-session-token-long-enough'), operator.id);
    const operatorCookie = 'gateway_control_session=system-operator-session-token-long-enough';
    expect((await app.inject({ method: 'GET', url: '/api/system-backups', headers: { cookie: operatorCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/system-backups', headers: { cookie: operatorCookie }, payload: { target: 'local', passphrase: 'valid-system-passphrase' } })).statusCode).toBe(403);
    const tooShort = await app.inject({ method: 'POST', url: '/api/system-backups', headers: { cookie }, payload: { target: 'local', passphrase: 'fifteen-chars!!' } });
    expect(tooShort.statusCode).toBe(400);
    expect(createBackup).not.toHaveBeenCalled();
    const created = await app.inject({ method: 'POST', url: '/api/system-backups', headers: { cookie }, payload: { target: 'local', passphrase: 'valid-system-passphrase' } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toMatch(/artifactPath|masterKey|passphrase|private-user|private\/system/);
    const backupId = created.json().backup.id;
    const stored = await store.createSystemBackup(store.users[0]!.id, 'nas', '/private/listed-system.gcsb');
    await store.completeSystemBackup(stored.id, 2048, 'b'.repeat(64));
    const listed = await app.inject({ method: 'GET', url: '/api/system-backups', headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toMatch(/artifactPath|requestedByUserId|private\/listed-system/);
    expect((await app.inject({ method: 'POST', url: `/api/system-backups/${backupId}/stage-restore`, headers: { cookie: operatorCookie }, payload: { passphrase: 'valid-system-passphrase' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/system-backups/${backupId}/stage-restore`, headers: { cookie }, payload: { passphrase: 'too-short' } })).statusCode).toBe(400);
    expect(stageRestore).not.toHaveBeenCalled();
    const staged = await app.inject({ method: 'POST', url: `/api/system-backups/${backupId}/stage-restore`, headers: { cookie }, payload: { passphrase: 'valid-system-passphrase' } });
    expect(staged.statusCode).toBe(202);
    expect(staged.json()).toMatchObject({
      manualRestoreRequired: true,
      restoreCommand: 'sh docker/recover.sh',
      restore: { backupId, status: 'staged' },
    });
    expect(staged.body).not.toMatch(/requestedByUserId|masterKey|passphrase|artifactPath/);
    expect(stageRestore).toHaveBeenCalledWith(expect.objectContaining({ backupId, passphrase: 'valid-system-passphrase' }));
  });

  it('returns a stable machine-readable system recovery failure code', async () => {
    const createBackup = vi.fn(async () => { throw new SystemRecoveryFailure(409, 'nas_unavailable', 'The NAS backup target is unavailable.'); });
    const stageRestore = vi.fn();
    const { app, cookie } = await appWithOwner({ systemRecoveryService: { createBackup, stageRestore } });

    const response = await app.inject({ method: 'POST', url: '/api/system-backups', headers: { cookie }, payload: { target: 'nas', passphrase: 'valid-system-passphrase' } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'The NAS backup target is unavailable.', code: 'nas_unavailable' });
  });

  it('authorizes raw backup imports and keeps passphrases and paths out of responses', async () => {
    const now = new Date().toISOString();
    const importId = randomUUID();
    const backupId = randomUUID();
    const uploaded = { id: importId, requestedByUserId: 'private-user', status: 'uploaded' as const, quarantinePath: '/private/quarantine.gcsb', sizeBytes: 4, checksum: 'a'.repeat(64), backupId: null, error: null, createdAt: now, updatedAt: now, completedAt: null, validationRevision: 0 };
    const imported = { ...uploaded, status: 'imported' as const, backupId, completedAt: now };
    const backup = { id: backupId, requestedByUserId: 'private-user', target: 'local' as const, status: 'succeeded' as const, sizeBytes: 4, checksum: 'a'.repeat(64), error: null, source: 'imported' as const, metadata: { importId }, createdAt: now, completedAt: now };
    const service: SystemRecoveryService = {
      createBackup: vi.fn(), stageRestore: vi.fn(), listImports: vi.fn(async () => [uploaded]), cleanupStaleImports: vi.fn(async () => undefined),
      uploadImport: vi.fn(async () => uploaded), validateImport: vi.fn(async () => ({ importRecord: imported, backup, idempotent: false })),
      requestApply: vi.fn(async () => ({ queued: true as const })), exportArtifact: vi.fn(),
    };
    const { app, store, cookie } = await appWithOwner({ systemRecoveryService: service });
    const operator = await store.createUser('import-operator@example.com', store.users[0]!.passwordHash, 'operator');
    store.sessions.set(hashToken('import-operator-session-token-long-enough'), operator.id);
    const operatorCookie = 'gateway_control_session=import-operator-session-token-long-enough';

    expect((await app.inject({ method: 'POST', url: '/api/system-backup-imports', headers: { cookie: operatorCookie, 'content-type': 'application/octet-stream', 'content-length': '4' }, payload: Buffer.from('test') })).statusCode).toBe(403);
    const upload = await app.inject({ method: 'POST', url: '/api/system-backup-imports', headers: { cookie, 'content-type': 'application/octet-stream', 'content-length': '4' }, payload: Buffer.from('test') });
    expect(upload.statusCode).toBe(201);
    expect(upload.body).not.toMatch(/quarantine|private-user|private\//);
    const validated = await app.inject({ method: 'POST', url: `/api/system-backup-imports/${importId}/validate`, headers: { cookie }, payload: { passphrase: 'valid-import-passphrase' } });
    expect(validated.statusCode).toBe(200);
    expect(validated.body).not.toMatch(/passphrase|quarantine|requestedByUserId|private\//);
    expect(service.validateImport).toHaveBeenCalledWith(expect.objectContaining({ importId, passphrase: 'valid-import-passphrase' }));
  });

  it('fails backup and restore commands that remain incomplete for 24 hours', async () => {
    const store = new FakeStore();
    const owner = await store.createOwner('owner@example.com', 'password-hash');
    const agent = await store.createAgent('stale-operation-agent', hashToken('stale-operation-enrollment-token'));
    const stack = await store.createStack({ agentId: agent.id, name: 'stale', projectName: 'stale', encryptedComposeYaml: 'encrypted', enabled: true });
    store.commands.length = 0;

    const staleBackup = await store.createBackup(stack!.id, owner!.id, 'local');
    store.commands[0]!.createdAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await store.claimCommands(agent.id, 1);
    expect(await store.failStaleCommands(new Date(Date.now() - 24 * 60 * 60_000))).toBe(1);
    expect(staleBackup).toMatchObject({ status: 'failed', result: { error: 'The operation exceeded the 24-hour completion window.' } });
    expect(store.events.at(-1)).toMatchObject({ type: 'backup.failed', payload: { operation: 'backup', reason: 'stale' } });

    const successfulBackup = await store.createBackup(stack!.id, owner!.id, 'local');
    const backupCommand = store.commands.at(-1)!;
    await store.claimCommands(agent.id, 1);
    await store.completeCommand(agent.id, backupCommand.id, 'succeeded', {});
    const staleRestore = await store.createRestore((successfulBackup as { id: string }).id, owner!.id);
    const restoreCommand = store.commands.at(-1)!;
    restoreCommand.createdAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await store.claimCommands(agent.id, 1);
    expect(await store.failStaleCommands(new Date(Date.now() - 24 * 60 * 60_000))).toBe(1);
    expect(staleRestore).toMatchObject({ status: 'failed', result: { error: 'The operation exceeded the 24-hour completion window.' } });
    expect(store.events.at(-1)).toMatchObject({ type: 'backup.failed', payload: { operation: 'restore', reason: 'stale' } });

    store.agents[0]!.enrolledAt = new Date().toISOString();
    await store.saveNotificationSettings('encrypted-token', 'encrypted-group', [...OPERATIONAL_EVENT_TYPES]);
    await store.setAgentNotificationPreference(agent.id, false, owner!.id);
    const runtimeOperation = await store.createRuntimeOperation({ requestedByUserId: owner!.id, agentId: agent.id, projectName: 'stale', serviceName: 'web', scope: 'service', action: 'restart' });
    const runtimeCommand = store.commands.at(-1)!;
    runtimeCommand.createdAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    expect(await store.failStaleCommands(new Date(Date.now() - 24 * 60 * 60_000))).toBe(1);
    expect(runtimeOperation).toMatchObject({ status: 'failed' });
    expect(store.events.at(-1)).toMatchObject({ type: 'runtime.action.failed', agentId: agent.id, projectName: 'stale', serviceName: 'web' });
    expect(store.deliveries).toHaveLength(0);
  });

  it('dispatches selected durable backup events through injected Telegram fetch', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, store, cookie } = await appWithOwner({ fetch: fetchMock, notificationIntervalMs: 5 });
    await app.inject({
      method: 'PUT', url: '/api/notifications/telegram', headers: { cookie },
      payload: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd', groupId: '-1001234567890', selectedEvents: ['backup.succeeded'] },
    });
    const agent = await store.createAgent('event-agent', hashToken('event-enrollment-token-long-enough'));
    const credential = 'event-agent-credential-long-enough';
    store.agents[0]!.credentialHash = hashToken(credential);
    store.agents[0]!.enrolledAt = new Date().toISOString();
    const stack = await store.createStack({ agentId: agent.id, name: 'event', projectName: 'event', encryptedComposeYaml: 'encrypted', enabled: true });
    store.commands.length = 0;
    await app.inject({ method: 'POST', url: `/api/stacks/${stack!.id}/backups`, headers: { cookie }, payload: { target: 'local' } });
    await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    await app.inject({ method: 'POST', url: `/api/agent/commands/${store.commands[0]!.id}/result`, headers: { authorization: `Bearer ${credential}` }, payload: { status: 'succeeded', result: {} } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(store.deliveries[0]?.status).toBe('succeeded');
    expect(store.events.find((event) => event.type === 'backup.succeeded')?.payload).toMatchObject({ agentId: agent.id, projectName: 'event' });
    const telegramBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(telegramBody.text).toContain(`Event ID: ${store.deliveries[0]?.eventId}`);
    expect(telegramBody.text).toContain(`Delivery ID: ${store.deliveries[0]?.id}`);
  });

  it('manages Cloudflare accounts without exposing tokens and syncs paginated zones for operators', async () => {
    const apiToken = 'cloudflare-api-token-that-must-never-be-returned';
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${apiToken}` });
      if (url.endsWith('/user/tokens/verify')) return cloudflareResponse({ status: 'active' });
      if (url.includes('/zones?') && url.includes('page=1')) return cloudflareResponse(
        [{ id: 'a'.repeat(32), name: 'one.example', status: 'active' }],
        { resultInfo: { page: 1, total_pages: 2 } },
      );
      if (url.includes('/zones?') && url.includes('page=2')) return cloudflareResponse(
        [{ id: 'b'.repeat(32), name: 'two.example', status: 'pending' }],
        { resultInfo: { page: 2, total_pages: 2 } },
      );
      throw new Error(`Unexpected request: ${url}`);
    });
    const { app, store, cookie } = await appWithOwner({ fetch: fetchMock });
    const created = await app.inject({
      method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie },
      payload: { name: 'Production', accountIdentifier: '1'.repeat(32), apiToken },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(apiToken);
    expect(created.json().account).toMatchObject({ name: 'Production', accountIdentifier: '1'.repeat(32), configured: true, enabled: true });
    expect(store.cloudflareAccounts[0]?.encryptedApiToken).not.toContain(apiToken);
    const accountId = created.json().account.id;
    const listed = await app.inject({ method: 'GET', url: '/api/cloudflare/accounts', headers: { cookie } });
    expect(listed.body).not.toContain(apiToken);

    const viewer = await store.createUser('cloudflare-viewer@example.com', store.users[0]!.passwordHash, 'viewer');
    store.sessions.set(hashToken('cloudflare-viewer-session-token-long-enough'), viewer.id);
    const viewerCookie = 'gateway_control_session=cloudflare-viewer-session-token-long-enough';
    expect((await app.inject({ method: 'GET', url: '/api/cloudflare/accounts', headers: { cookie: viewerCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/cloudflare/accounts/${accountId}/test`, headers: { cookie: viewerCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/cloudflare/accounts/${accountId}/test`, headers: { cookie } })).json()).toEqual({ verified: true, zoneCount: 2 });
    const synced = await app.inject({ method: 'POST', url: `/api/cloudflare/accounts/${accountId}/sync`, headers: { cookie } });
    expect(synced.statusCode).toBe(200);
    expect(synced.json().zoneCount).toBe(2);
    expect(synced.json().zones).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: `/api/cloudflare/accounts/${accountId}/sync`, headers: { cookie } })).json().zones).toHaveLength(2);
    expect(store.cloudflareZones.map((zone) => zone.name)).toEqual(['one.example', 'two.example']);
    expect(store.cloudflareAccounts[0]?.lastSyncedAt).not.toBeNull();
    const deleted = await app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${accountId}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(204);
    expect(store.cloudflareAccounts).toHaveLength(0);
    expect(store.cloudflareZones).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it('blocks Cloudflare account deletion while references exist', async () => {
    const { app, store, cookie } = await appWithOwner();
    const created = await app.inject({
      method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie },
      payload: { name: 'Referenced', accountIdentifier: '2'.repeat(32), apiToken: 'cloudflare-api-token-that-is-long-enough' },
    });
    const accountId = created.json().account.id;
    const pendingAgent = await store.createAgent('referenced-agent', hashToken('referenced-agent-enrollment-token'));
    await store.enrollAgent(hashToken('referenced-agent-enrollment-token'), hashToken('referenced-agent-credential'));
    await store.createConnector({
      name: 'referenced-connector', encryptedToken: 'encrypted-token', enabled: false, agentId: pendingAgent.id,
      accountId, accountIdentifier: '2'.repeat(32), tunnelId: randomUUID(), identityStatus: 'verified',
    });

    const blocked = await app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${accountId}`, headers: { cookie } });

    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'cloudflare_account_delete_blocked' });
    expect(store.cloudflareAccounts).toHaveLength(1);
  });

  it('tests zero-zone accounts and maps zone authorization failures without leaking Cloudflare responses', async () => {
    const apiToken = 'cloudflare-zone-test-token-that-must-not-leak';
    let denyZones = false;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith('/user/tokens/verify')) return cloudflareResponse({ status: 'active' });
      if (denyZones) return cloudflareResponse({ private: apiToken }, { status: 403, success: false, errors: [{ code: 1000 }] });
      return cloudflareResponse([], { resultInfo: { page: 1, total_pages: 1 } });
    });
    const { app, cookie } = await appWithOwner({ fetch: fetchMock });
    const created = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Empty', accountIdentifier: '3'.repeat(32), apiToken } });
    const accountId = created.json().account.id as string;
    expect((await app.inject({ method: 'POST', url: `/api/cloudflare/accounts/${accountId}/test`, headers: { cookie } })).json()).toEqual({ verified: true, zoneCount: 0 });
    denyZones = true;
    const denied = await app.inject({ method: 'POST', url: `/api/cloudflare/accounts/${accountId}/test`, headers: { cookie } });
    expect(denied.statusCode).toBe(502);
    expect(denied.json().code).toBe('cloudflare_zone_access_denied');
    expect(denied.body).not.toContain(apiToken);
  });

  it('rejects unstable zone pagination and duplicate zone identifiers', async () => {
    const accountIdentifier = '4'.repeat(32);
    const zone = { id: '5'.repeat(32), name: 'example.test', status: 'active' };
    const unstable = vi.fn<typeof globalThis.fetch>(async (input) => String(input).includes('page=1')
      ? cloudflareResponse([zone], { resultInfo: { page: 1, total_pages: 2 } })
      : cloudflareResponse([], { resultInfo: { page: 2, total_pages: 3 } }));
    await expect(new CloudflareClient('token', unstable).listZones(accountIdentifier)).rejects.toThrow('invalid zone pagination metadata');

    const duplicate = vi.fn<typeof globalThis.fetch>().mockResolvedValue(cloudflareResponse([zone, zone], { resultInfo: { page: 1, total_pages: 1 } }));
    await expect(new CloudflareClient('token', duplicate).listZones(accountIdentifier)).rejects.toThrow('duplicate zone identifiers');
  });

  it('reconciles and disables a public hostname while preserving unrelated tunnel ingress', async () => {
    const tunnelId = randomUUID();
    const accountIdentifier = '2'.repeat(32);
    const connectorToken = tunnelToken(accountIdentifier, tunnelId);
    const originalIngress = [
      { hostname: 'existing.example.test', service: 'http://existing:8080', originRequest: { noTLSVerify: true } },
    ];
    const catchAll = { service: 'http_status:404' };
    let configReads = 0;
    let dnsComment: string | undefined;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET' && url.endsWith(`/cfd_tunnel/${tunnelId}/token`)) return cloudflareResponse(connectorToken);
      if (init?.method === 'GET' && url.endsWith(`/cfd_tunnel/${tunnelId}`)) return cloudflareResponse({ id: tunnelId, account_tag: accountIdentifier, deleted_at: null });
      if (init?.method === 'GET' && url.endsWith('/configurations')) {
        configReads += 1;
        return cloudflareResponse({ config: { ingress: configReads === 1 ? originalIngress : [originalIngress[0], { hostname: 'app.example.test', service: 'http://traefik:80' }, catchAll] } });
      }
      if (init?.method === 'GET' && url.includes('/dns_records?')) return cloudflareResponse([]);
      if (init?.method === 'PUT' && url.endsWith('/configurations')) return cloudflareResponse({});
      if (init?.method === 'POST' && url.endsWith('/dns_records')) {
        const body = JSON.parse(String(init.body));
        dnsComment = body.comment;
        return cloudflareResponse({ id: 'dns-record-123', ...body });
      }
      if (init?.method === 'GET' && url.endsWith('/dns_records/dns-record-123')) return cloudflareResponse({ id: 'dns-record-123', type: 'CNAME', name: 'app.example.test', content: `${tunnelId}.cfargotunnel.com`, proxied: true, comment: dnsComment });
      if (init?.method === 'DELETE' && url.endsWith('/dns_records/dns-record-123')) return cloudflareResponse({ id: 'dns-record-123' });
      throw new Error(`Unexpected request: ${init?.method} ${url}`);
    });
    const { app, store, cookie } = await appWithOwner({ fetch: fetchMock });
    const accountResponse = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Edge', accountIdentifier, apiToken: 'safe-cloudflare-api-token-for-reconciliation' } });
    const accountId = accountResponse.json().account.id;
    await store.syncCloudflareZones(accountId, [{ zoneIdentifier: '3'.repeat(32), name: 'example.test', status: 'active' }]);
    const zoneId = store.cloudflareZones[0]!.id;
    const agent = await store.createAgent('cloudflare-public-agent', hashToken('cloudflare-public-enrollment-long-enough'));
    store.agents.find((item) => item.id === agent.id)!.enrolledAt = new Date().toISOString();
    const connectorResponse = await app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie }, payload: { name: 'public-tunnel', token: connectorToken, agentId: agent.id } });
    expect(connectorResponse.json().connector).toMatchObject({ cloudflareAccountId: accountId, tunnelId });
    const route = await store.createRoute({ gatewayAgentId: agent.id, name: 'app', hostname: 'app.example.test', exposure: 'tunnel', backends: ['http://app:8080'], enabled: true });
    route!.status = 'active';
    const created = await app.inject({ method: 'POST', url: '/api/cloudflare/public-hostnames', headers: { cookie }, payload: { zoneId, connectorId: connectorResponse.json().connector.id, routeId: route!.id } });
    expect(created.statusCode).toBe(201);
    expect(created.json().publicHostname).toMatchObject({ hostname: 'app.example.test', dnsRecordId: 'dns-record-123', enabled: true, status: 'active' });
    for (const mutation of [
      { url: `/api/cloudflare/accounts/${accountId}`, payload: { enabled: false } },
      { url: `/api/connectors/${connectorResponse.json().connector.id}`, payload: { enabled: false } },
      { url: `/api/routes/${route!.id}`, payload: { enabled: false } },
    ]) {
      const blocked = await app.inject({ method: 'PATCH', headers: { cookie }, ...mutation });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().code).toBe('domain_access_dependency_enabled');
    }

    const createPut = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(createPut[1]?.body))).toEqual({ config: { ingress: [
      originalIngress[0], { hostname: 'app.example.test', service: 'http://traefik:80' }, catchAll,
    ] } });
    const dnsCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(dnsCall[1]?.body))).toMatchObject({ type: 'CNAME', name: 'app.example.test', content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 });

    const hostnameId = created.json().publicHostname.id;
    const disabled = await app.inject({ method: 'PATCH', url: `/api/cloudflare/public-hostnames/${hostnameId}`, headers: { cookie }, payload: { enabled: false } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().publicHostname).toMatchObject({ enabled: false, status: 'disabled', dnsRecordId: null });
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(putCalls[1]![1]?.body))).toEqual({ config: { ingress: [...originalIngress, catchAll] } });
    const deleteIndex = fetchMock.mock.calls.findIndex(([, init]) => init?.method === 'DELETE');
    const disablePutIndex = fetchMock.mock.calls.findLastIndex(([, init]) => init?.method === 'PUT');
    expect(deleteIndex).toBeLessThan(disablePutIndex);
    const callCount = fetchMock.mock.calls.length;
    expect((await app.inject({ method: 'PATCH', url: `/api/cloudflare/public-hostnames/${hostnameId}`, headers: { cookie }, payload: { enabled: false } })).statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(callCount);
  });

  it('rejects mismatched public-hostname relationships and safely rolls back DNS failures', async () => {
    const apiToken = 'rollback-secret-token-that-must-be-redacted';
    const originalIngress = [{ hostname: 'other.example.test', service: 'http://other:80' }, { service: 'http_status:404' }];
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET' && url.includes('/dns_records?')) return cloudflareResponse([]);
      if (init?.method === 'GET' && url.endsWith('/configurations')) return cloudflareResponse({ config: { ingress: originalIngress } });
      if (init?.method === 'PUT' && url.endsWith('/configurations')) return cloudflareResponse({});
      if (init?.method === 'POST' && url.endsWith('/dns_records')) return cloudflareResponse({}, { status: 409, success: false, errors: [{ code: 81057, message: `conflict ${apiToken}` }] });
      throw new Error(`Unexpected request: ${init?.method} ${url}`);
    });
    const { app, store, cookie } = await appWithOwner({ fetch: fetchMock });
    const firstAccount = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'First', accountIdentifier: '4'.repeat(32), apiToken } });
    const secondAccount = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Second', accountIdentifier: '5'.repeat(32), apiToken: 'another-safe-cloudflare-api-token-value' } });
    const firstId = firstAccount.json().account.id;
    const secondId = secondAccount.json().account.id;
    await store.syncCloudflareZones(firstId, [{ zoneIdentifier: '6'.repeat(32), name: 'example.test', status: 'active' }]);
    const agent = await store.createAgent('rollback-agent', hashToken('rollback-agent-enrollment-token-long-enough'));
    store.agents.find((item) => item.id === agent.id)!.enrolledAt = new Date().toISOString();
    const rollbackTunnelId = randomUUID();
    const connector = await store.createConnector({ name: 'rollback-tunnel', encryptedToken: 'encrypted-agent-token', enabled: true, agentId: agent.id, accountId: secondId, accountIdentifier: '5'.repeat(32), tunnelId: rollbackTunnelId, identityStatus: 'verified' });
    const route = await store.createRoute({ gatewayAgentId: agent.id, name: 'rollback', hostname: 'rollback.example.test', exposure: 'tunnel', backends: ['http://rollback:80'], enabled: true });
    route!.status = 'active';
    const mismatch = await app.inject({ method: 'POST', url: '/api/cloudflare/public-hostnames', headers: { cookie }, payload: { zoneId: store.cloudflareZones[0]!.id, connectorId: connector!.id, routeId: route!.id } });
    expect(mismatch.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();

    await store.updateConnector(connector!.id, { encryptedToken: 'replacement-encrypted-token', accountId: firstId, accountIdentifier: '4'.repeat(32), tunnelId: rollbackTunnelId });
    const failed = await app.inject({ method: 'POST', url: '/api/cloudflare/public-hostnames', headers: { cookie }, payload: { zoneId: store.cloudflareZones[0]!.id, connectorId: connector!.id, routeId: route!.id, proxied: false } });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).toContain('code 81057');
    expect(failed.body).not.toContain(apiToken);
    expect(store.cloudflarePublicHostnames[0]).toMatchObject({ status: 'failed', dnsRecordId: null });
    expect(store.cloudflarePublicHostnames[0]?.lastError).not.toContain(apiToken);
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(2);
    expect(JSON.parse(String(putCalls[1]![1]?.body))).toEqual({ config: { ingress: originalIngress } });
  });
});
