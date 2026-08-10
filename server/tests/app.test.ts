import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/crypto.js';
import { FakeStore } from './fake-store.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWithOwner(options: { fetch?: typeof globalThis.fetch; notificationIntervalMs?: number } = {}) {
  const store = new FakeStore();
  const app = await buildApp({ store, masterKey: randomBytes(32), secureCookie: false, ...options });
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
    const created = await app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie }, payload: { name: 'primary', token: 'a-very-long-cloudflare-connector-token', agentId: agent.id } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('cloudflare-connector-token');
    expect(store.connectors[0]?.encryptedToken).not.toContain('cloudflare-connector-token');
    expect(created.json().connector.agentId).toBe(agent.id);
    expect(store.commands).toHaveLength(1);
    expect(store.commands[0]).toMatchObject({ agentId: agent.id, type: 'cloudflare.connector.sync', payload: { connectorId: created.json().connector.id }, status: 'pending' });
    expect(JSON.stringify(store.commands)).not.toContain('cloudflare-connector-token');
    const browserCommands = await app.inject({ method: 'GET', url: '/api/commands', headers: { cookie } });
    expect(browserCommands.body).not.toContain('cloudflare-connector-token');

    const patched = await app.inject({ method: 'PATCH', url: `/api/connectors/${created.json().connector.id}`, headers: { cookie }, payload: { enabled: false } });
    expect(patched.statusCode).toBe(200);
    expect(store.commands).toHaveLength(1);
    expect(store.commands[0]).toMatchObject({ type: 'cloudflare.connector.sync', payload: { connectorId: created.json().connector.id } });
    const replacementAgent = await store.createAgent('replacement-gateway', hashToken('replacement-enrollment-token-that-is-long'));
    const reassigned = await app.inject({
      method: 'PATCH', url: `/api/connectors/${created.json().connector.id}`, headers: { cookie },
      payload: { name: 'renamed', token: 'a-replacement-cloudflare-connector-token', agentId: replacementAgent.id },
    });
    expect(reassigned.statusCode).toBe(200);
    expect(reassigned.body).not.toContain('replacement-cloudflare-connector-token');
    expect(store.commands[1]).toMatchObject({ agentId: replacementAgent.id, type: 'cloudflare.connector.sync', payload: { connectorId: created.json().connector.id } });
    expect(JSON.stringify(store.commands)).not.toContain('replacement-cloudflare-connector-token');

    const viewer = await store.createUser('viewer@example.com', store.users[0]!.passwordHash, 'viewer');
    store.sessions.set(hashToken('viewer-session-token-that-is-long-enough'), viewer.id);
    const forbidden = await app.inject({
      method: 'POST', url: '/api/connectors', headers: { cookie: 'gateway_control_session=viewer-session-token-that-is-long-enough' },
      payload: { name: 'forbidden', token: 'a-very-long-cloudflare-connector-token', agentId: agent.id },
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
    expect(body.enrollmentCommand).toContain("GATEWAY_AGENT_IMAGE='example/gateway-agent:1.0.0'");
    expect(body.enrollmentCommand).toContain('GATEWAY_HOST_PROC_ROOT=/host/proc');
    expect(body.enrollmentCommand).toContain('GATEWAY_LOCAL_BACKUP_ROOT=/opt/gateway-control/backups/local');
    expect(body.enrollmentCommand).toContain('GATEWAY_NAS_BACKUP_ROOT=/mnt/gateway-control-backups');
    expect(body.enrollmentCommand).toContain('GATEWAY_TRAEFIK_DYNAMIC_ROOT=/srv/traefik-dynamic');
    expect(body.enrollmentCommand).toContain("GATEWAY_TRAEFIK_DYNAMIC_VOLUME='gateway-traefik-dynamic'");
    expect(body.enrollmentCommand).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(body.enrollmentCommand).toContain('/var/lib/gateway-agent');
    expect(body.enrollmentCommand).toContain('/opt/gateway-control/stacks:/opt/gateway-control/stacks');
    expect(body.enrollmentCommand).toContain('/proc:/host/proc:ro');
    expect(body.enrollmentCommand).toContain('/opt/gateway-control/backups/local:/opt/gateway-control/backups/local');
    expect(body.enrollmentCommand).toContain('/mnt/gateway-control-backups:/mnt/gateway-control-backups');
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

  it('decorates connector sync only for the assigned authenticated agent', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('cloudflare-gateway', hashToken('unused-enrollment-token-that-is-long'));
    const credential = 'persistent-cloudflare-credential-that-is-long-enough';
    const storedAgent = store.agents.find((item) => item.id === agent.id)!;
    storedAgent.credentialHash = hashToken(credential);
    storedAgent.enrolledAt = new Date().toISOString();
    const created = await app.inject({
      method: 'POST', url: '/api/connectors', headers: { cookie },
      payload: { name: 'primary-tunnel', token: 'a-very-long-cloudflare-connector-token', agentId: agent.id },
    });
    const connectorId = created.json().connector.id;
    expect(store.commands[0]?.payload).toEqual({ connectorId });
    const polled = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().commands[0]).toMatchObject({
      type: 'cloudflare.connector.sync',
      payload: { connectorId, name: 'primary-tunnel', enabled: true, token: 'a-very-long-cloudflare-connector-token' },
    });
    expect(store.commands[0]?.payload).toEqual({ connectorId });

    const otherAgent = await store.createAgent('other-gateway', hashToken('other-enrollment-token-that-is-long'));
    const otherCredential = 'other-persistent-credential-that-is-long-enough';
    const storedOtherAgent = store.agents.find((item) => item.id === otherAgent.id)!;
    storedOtherAgent.credentialHash = hashToken(otherCredential);
    storedOtherAgent.enrolledAt = new Date().toISOString();
    const mismatched = await store.createCommand(otherAgent.id, 'cloudflare.connector.sync', { connectorId });
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

  it('encrypts managed stacks, deduplicates syncs, decorates assigned deployment, and updates status', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('stack-gateway', hashToken('stack-enrollment-token-that-is-long-enough'));
    const credential = 'stack-agent-credential-that-is-long-enough';
    const storedAgent = store.agents.find((item) => item.id === agent.id)!;
    storedAgent.credentialHash = hashToken(credential);
    storedAgent.enrolledAt = new Date().toISOString();
    const composeYaml = 'services:\n  web:\n    image: nginx:1.27\n';
    const created = await app.inject({
      method: 'POST', url: '/api/stacks', headers: { cookie },
      payload: { agentId: agent.id, name: 'web-stack', projectName: 'web_stack', composeYaml, enabled: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(composeYaml);
    expect(created.json().stack).toMatchObject({ agentId: agent.id, name: 'web-stack', projectName: 'web_stack', configured: true, revision: 1, status: 'pending' });
    const stackId = created.json().stack.id;
    expect(store.stacks[0]?.encryptedComposeYaml).not.toContain('nginx');
    expect(store.commands).toHaveLength(1);
    expect(store.commands[0]).toMatchObject({ type: 'compose.stack.sync', payload: { stackId } });
    expect(JSON.stringify(store.commands)).not.toContain('nginx');
    expect((await app.inject({ method: 'GET', url: '/api/commands', headers: { cookie } })).body).not.toContain('nginx');

    const patched = await app.inject({ method: 'PATCH', url: `/api/stacks/${stackId}`, headers: { cookie }, payload: { name: 'renamed-stack' } });
    expect(patched.json().stack.revision).toBe(2);
    expect(store.commands).toHaveLength(1);
    const listed = await app.inject({ method: 'GET', url: '/api/stacks', headers: { cookie } });
    expect(listed.body).not.toContain('composeYaml');
    expect(listed.body).not.toContain('nginx');

    const polled = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(polled.json().commands[0]).toMatchObject({
      type: 'compose.stack.sync',
      payload: { stackId, name: 'renamed-stack', projectName: 'web_stack', composeYaml, enabled: true, revision: 2 },
    });
    expect(store.commands[0]?.payload).toEqual({ stackId });
    const result = await app.inject({
      method: 'POST', url: `/api/agent/commands/${store.commands[0]!.id}/result`, headers: { authorization: `Bearer ${credential}` },
      payload: { status: 'succeeded', result: {} },
    });
    expect(result.statusCode).toBe(200);
    expect(store.stacks[0]?.status).toBe('active');
    const restart = await app.inject({ method: 'POST', url: `/api/stacks/${stackId}/restart`, headers: { cookie } });
    expect(restart.statusCode).toBe(202);
    expect(restart.json().command.payload).toEqual({ composePath: `${stackId}/compose.yaml`, stack: 'renamed-stack', project: 'web_stack' });
  });

  it('rejects unsafe or invalid managed stack YAML', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('validation-gateway', hashToken('validation-enrollment-token-that-is-long'));
    const invalidDocuments = [
      'not: [valid',
      'networks:\n  default: {}\n',
      'include: other.yaml\nservices: {}\n',
      'services:\n  bad:\n    image: test\n    privileged: true\n',
      'services:\n  bad:\n    image: test\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n',
      'services:\n  bad:\n    extends:\n      file: other.yaml\n      service: base\n',
    ];
    for (const composeYaml of invalidDocuments) {
      const response = await app.inject({
        method: 'POST', url: '/api/stacks', headers: { cookie },
        payload: { agentId: agent.id, name: 'invalid-stack', projectName: 'invalid', composeYaml },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(store.stacks).toHaveLength(0);
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
  });

  it('accepts bounded telemetry only from agents and exposes monitoring to viewers', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('telemetry-agent', hashToken('telemetry-enrollment-token-long-enough'));
    const credential = 'telemetry-agent-credential-long-enough';
    store.agents[0]!.credentialHash = hashToken(credential);
    store.agents[0]!.enrolledAt = new Date().toISOString();
    const snapshot = { observedAt: new Date().toISOString(), node: { hostname: 'nas-one', cpuPercent: 12.5 }, services: [{ name: 'web', status: 'healthy', cpuPercent: 2 }] };
    expect((await app.inject({ method: 'POST', url: '/api/agent/telemetry', payload: snapshot })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/agent/telemetry', headers: { authorization: `Bearer ${credential}` }, payload: snapshot })).statusCode).toBe(200);
    const invalid = { ...snapshot, services: Array.from({ length: 251 }, (_, index) => ({ name: `service-${index}`, status: 'healthy' })) };
    expect((await app.inject({ method: 'POST', url: '/api/agent/telemetry', headers: { authorization: `Bearer ${credential}` }, payload: invalid })).statusCode).toBe(400);
    const viewer = await store.createUser('monitor@example.com', store.users[0]!.passwordHash, 'viewer');
    store.sessions.set(hashToken('monitor-viewer-session-token-long-enough'), viewer.id);
    const viewerCookie = 'gateway_control_session=monitor-viewer-session-token-long-enough';
    const summary = await app.inject({ method: 'GET', url: '/api/monitoring/summary', headers: { cookie: viewerCookie } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().agents[0]).toMatchObject({ agentId: agent.id, node: { hostname: 'nas-one' } });
    expect((await app.inject({ method: 'GET', url: `/api/monitoring/agents/${agent.id}`, headers: { cookie } })).json().history).toHaveLength(1);
  });

  it('restricts service logs and decorates one claimed request with authoritative stack paths', async () => {
    const { app, store, cookie } = await appWithOwner();
    const agent = await store.createAgent('logs-agent', hashToken('logs-enrollment-token-long-enough'));
    const credential = 'logs-agent-credential-long-enough';
    store.agents[0]!.credentialHash = hashToken(credential);
    store.agents[0]!.enrolledAt = new Date().toISOString();
    const stack = await store.createStack({ agentId: agent.id, name: 'logs', projectName: 'authoritative', encryptedComposeYaml: 'encrypted', enabled: true });
    store.commands.length = 0;
    const viewer = await store.createUser('logs-viewer@example.com', store.users[0]!.passwordHash, 'viewer');
    store.sessions.set(hashToken('logs-viewer-session-token-long-enough'), viewer.id);
    const viewerCookie = 'gateway_control_session=logs-viewer-session-token-long-enough';
    expect((await app.inject({ method: 'POST', url: `/api/stacks/${stack!.id}/logs`, headers: { cookie: viewerCookie }, payload: { service: 'web', tail: 100 } })).statusCode).toBe(403);
    const queued = await app.inject({ method: 'POST', url: `/api/stacks/${stack!.id}/logs`, headers: { cookie }, payload: { service: 'web', tail: 100, since: new Date(Date.now() - 60_000).toISOString() } });
    expect(queued.statusCode).toBe(202);
    expect(store.commands[0]!.payload).toMatchObject({ stackId: stack!.id, service: 'web', tail: 100 });
    expect(store.commands[0]!.payload).not.toHaveProperty('projectName');
    const polled = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(polled.json().commands).toHaveLength(1);
    expect(polled.json().commands[0].payload).toMatchObject({ projectName: 'authoritative', stackPath: stack!.id, composePath: `${stack!.id}/compose.yaml` });
    expect(polled.json().commands[0].payload).not.toHaveProperty('requestedByUserId');
    expect((await app.inject({ method: 'GET', url: `/api/log-requests/${queued.json().commandId}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/log-requests/${queued.json().commandId}`, headers: { cookie: viewerCookie } })).statusCode).toBe(403);
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
    expect((await app.inject({ method: 'POST', url: `/api/cloudflare/accounts/${accountId}/test`, headers: { cookie } })).json()).toEqual({ verified: true });
    const synced = await app.inject({ method: 'POST', url: `/api/cloudflare/accounts/${accountId}/sync`, headers: { cookie } });
    expect(synced.statusCode).toBe(200);
    expect(synced.json().zones).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: `/api/cloudflare/accounts/${accountId}/sync`, headers: { cookie } })).json().zones).toHaveLength(2);
    expect(store.cloudflareZones.map((zone) => zone.name)).toEqual(['one.example', 'two.example']);
    expect(store.cloudflareAccounts[0]?.lastSyncedAt).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('reconciles and disables a public hostname while preserving unrelated tunnel ingress', async () => {
    const tunnelId = randomUUID();
    const originalIngress = [
      { hostname: 'existing.example.test', service: 'http://existing:8080', originRequest: { noTLSVerify: true } },
    ];
    const catchAll = { service: 'http_status:404' };
    let configReads = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET' && url.endsWith('/configurations')) {
        configReads += 1;
        return cloudflareResponse({ config: { ingress: configReads === 1 ? originalIngress : [originalIngress[0], { hostname: 'app.example.test', service: 'http://traefik:80' }, catchAll] } });
      }
      if (init?.method === 'PUT' && url.endsWith('/configurations')) return cloudflareResponse({});
      if (init?.method === 'POST' && url.endsWith('/dns_records')) return cloudflareResponse({ id: 'dns-record-123' });
      if (init?.method === 'DELETE' && url.endsWith('/dns_records/dns-record-123')) return cloudflareResponse({ id: 'dns-record-123' });
      throw new Error(`Unexpected request: ${init?.method} ${url}`);
    });
    const { app, store, cookie } = await appWithOwner({ fetch: fetchMock });
    const accountResponse = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Edge', accountIdentifier: '2'.repeat(32), apiToken: 'safe-cloudflare-api-token-for-reconciliation' } });
    const accountId = accountResponse.json().account.id;
    await store.syncCloudflareZones(accountId, [{ zoneIdentifier: '3'.repeat(32), name: 'example.test', status: 'active' }]);
    const zoneId = store.cloudflareZones[0]!.id;
    const agent = await store.createAgent('cloudflare-public-agent', hashToken('cloudflare-public-enrollment-long-enough'));
    const connectorResponse = await app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie }, payload: { name: 'public-tunnel', token: 'connector-token-that-remains-agent-compatible', agentId: agent.id, cloudflareAccountId: accountId, tunnelId } });
    expect(connectorResponse.json().connector).toMatchObject({ cloudflareAccountId: accountId, tunnelId });
    const route = await store.createRoute({ gatewayAgentId: agent.id, name: 'app', hostname: 'app.example.test', exposure: 'tunnel', backends: ['http://app:8080'], enabled: true });
    const created = await app.inject({ method: 'POST', url: '/api/cloudflare/public-hostnames', headers: { cookie }, payload: { zoneId, connectorId: connectorResponse.json().connector.id, routeId: route!.id } });
    expect(created.statusCode).toBe(201);
    expect(created.json().publicHostname).toMatchObject({ hostname: 'app.example.test', dnsRecordId: 'dns-record-123', enabled: true, status: 'active' });

    const createPut = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(createPut[1]?.body))).toEqual({ config: { ingress: [
      originalIngress[0], { hostname: 'app.example.test', service: 'http://traefik:80' }, catchAll,
    ] } });
    const dnsCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(dnsCall[1]?.body))).toMatchObject({ type: 'CNAME', name: 'app.example.test', content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 });

    const hostnameId = created.json().publicHostname.id;
    const disabled = await app.inject({ method: 'PATCH', url: `/api/cloudflare/public-hostnames/${hostnameId}`, headers: { cookie }, payload: { enabled: false } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().publicHostname).toMatchObject({ enabled: false, status: 'active', dnsRecordId: null });
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
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(cloudflareResponse({ config: { ingress: originalIngress } }))
      .mockResolvedValueOnce(cloudflareResponse({}))
      .mockResolvedValueOnce(cloudflareResponse({}, { status: 409, success: false, errors: [{ code: 81057, message: `conflict ${apiToken}` }] }))
      .mockResolvedValueOnce(cloudflareResponse({}));
    const { app, store, cookie } = await appWithOwner({ fetch: fetchMock });
    const firstAccount = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'First', accountIdentifier: '4'.repeat(32), apiToken } });
    const secondAccount = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Second', accountIdentifier: '5'.repeat(32), apiToken: 'another-safe-cloudflare-api-token-value' } });
    const firstId = firstAccount.json().account.id;
    const secondId = secondAccount.json().account.id;
    await store.syncCloudflareZones(firstId, [{ zoneIdentifier: '6'.repeat(32), name: 'example.test', status: 'active' }]);
    const agent = await store.createAgent('rollback-agent', hashToken('rollback-agent-enrollment-token-long-enough'));
    const connector = await store.createConnector('rollback-tunnel', 'encrypted-agent-token', true, agent.id, secondId, randomUUID());
    const route = await store.createRoute({ gatewayAgentId: agent.id, name: 'rollback', hostname: 'rollback.example.test', exposure: 'tunnel', backends: ['http://rollback:80'], enabled: true });
    const mismatch = await app.inject({ method: 'POST', url: '/api/cloudflare/public-hostnames', headers: { cookie }, payload: { zoneId: store.cloudflareZones[0]!.id, connectorId: connector!.id, routeId: route!.id } });
    expect(mismatch.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();

    await store.updateConnector(connector!.id, { cloudflareAccountId: firstId });
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
