import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, normalizePublishTarget, type BuildAppOptions } from '../src/app.js';
import { hashToken } from '../src/crypto.js';
import { FakeStore } from './fake-store.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function response(result: unknown, status = 200, success = true): Response {
  return new Response(JSON.stringify({ success, result, errors: success ? [] : [{ code: 1000 }] }), { status });
}

async function authenticated(fetch: typeof globalThis.fetch, options: Partial<BuildAppOptions> = {}) {
  const store = new FakeStore();
  const app = await buildApp({ store, masterKey: randomBytes(32), secureCookie: false, fetch, ...options }); apps.push(app);
  await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } });
  return { app, store, cookie: String(login.headers['set-cookie']).split(';')[0]! };
}

describe('guided domain publishing', () => {
  it('normalizes host ports and rejects unsafe explicit targets', () => {
    expect(normalizePublishTarget('host_port', '5800')).toBe('http://host.docker.internal:5800');
    expect(normalizePublishTarget('host_port', 'localhost:5800')).toBe('http://host.docker.internal:5800');
    expect(() => normalizePublishTarget('url', 'http://127.0.0.1:5800')).toThrow('not allowed');
    expect(() => normalizePublishTarget('url', 'http://169.254.169.254/latest')).toThrow();
    expect(() => normalizePublishTarget('url', 'https://user:secret@example.test')).toThrow();
    expect(() => normalizePublishTarget('url', 'https://example.test/?command=rm')).toThrow();
  });

  it('creates a pending normalized route before DNS and publishes only after Agent success', async () => {
    const records = new Map<string, Record<string, unknown>>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET' && url.includes('/dns_records?')) return response([...records.values()]);
      if (init?.method === 'POST' && url.endsWith('/dns_records')) { const item = { id: 'dns-1', ...JSON.parse(String(init.body)) }; records.set('dns-1', item); return response(item); }
      if (init?.method === 'GET' && url.endsWith('/dns_records/dns-1')) return response(records.get('dns-1'));
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const observer = vi.fn(async () => ({ status: 'valid' as const, issuer: 'Trusted CA', validTo: new Date(Date.now() + 86_400_000).toISOString() }));
    const { app, store, cookie } = await authenticated(fetch, { tlsObserver: observer, guidedVerificationIntervalMs: 5 });
    const accountResponse = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Account', accountIdentifier: 'a'.repeat(32), apiToken: 'cloudflare-api-token-for-guided-publish', enabled: true } });
    const account = store.cloudflareAccounts.find((item) => item.id === accountResponse.json().account.id)!;
    await store.syncCloudflareZones(account.id, [{ zoneIdentifier: 'b'.repeat(32), name: 'example.test', status: 'active' }]);
    const agent = await store.createAgent('gateway', hashToken('enrollment')); agent.enrolledAt = new Date().toISOString();
    const payload = { accountId: account.id, zoneId: store.cloudflareZones[0]!.id, hostname: 'app.example.test', agentId: agent.id, targetKind: 'host_port', target: 'localhost:5800', accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'] };
    const created = await app.inject({ method: 'POST', url: '/api/cloudflare/domain-publish', headers: { cookie, 'idempotency-key': 'publish-sequence-1' }, payload });
    expect(created.statusCode).toBe(202);
    expect(store.routes[0]).toMatchObject({ status: 'pending', backends: ['http://host.docker.internal:5800'] });
    expect(fetch).not.toHaveBeenCalled();
    const command = store.commands.find((item) => item.type === 'traefik.route.sync')!; command.status = 'claimed';
    await store.completeCommand(agent.id, command.id, 'succeeded', { message: 'reachable' });
    const reconciled = await app.inject({ method: 'POST', url: `/api/cloudflare/domain-publish/${created.json().operation.id}/reconcile`, headers: { cookie } });
    expect(reconciled.statusCode).toBe(202);
    expect(reconciled.json()).toMatchObject({ operation: { status: 'waiting', stage: 'pending_https_verification' }, domainAccess: { status: 'pending', proxied: false }, nextAction: 'https_verification_pending' });
    expect(observer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(store.guidedOperations[0]).toMatchObject({ status: 'succeeded', stage: 'complete' }));
    expect(store.cloudflareDomainAccess[0]).toMatchObject({ status: 'active', tlsStatus: 'valid' });
    expect(observer).toHaveBeenCalledWith('app.example.test');
    expect(fetch).toHaveBeenCalled();
  });

  it('rejects proxied public access in the advanced endpoint', async () => {
    const { app, store, cookie } = await authenticated(vi.fn());
    const accountResponse = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Account', accountIdentifier: 'a'.repeat(32), apiToken: 'cloudflare-api-token-for-timeout-test', enabled: true } });
    const account = store.cloudflareAccounts.find((item) => item.id === accountResponse.json().account.id)!;
    await store.syncCloudflareZones(account.id, [{ zoneIdentifier: 'b'.repeat(32), name: 'example.test', status: 'active' }]);
    const agent = await store.createAgent('gateway', hashToken('enrollment'));
    const route = await store.createRoute({ gatewayAgentId: agent.id, name: 'public', hostname: 'app.example.test', exposure: 'public', backends: ['http://app:80'], enabled: true }); route!.status = 'active';
    const result = await app.inject({ method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie }, payload: { accountId: account.id, zoneId: store.cloudflareZones[0]!.id, routeId: route!.id, accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'], proxied: true } });
    expect(result.statusCode).toBe(400); expect(result.json().code).toBe('public_ip_proxied_unsupported');
  });

  it('verifies Cloudflare edge HTTPS before activating a guided tunnel publication', async () => {
    const tunnelId = randomUUID();
    const records = new Map<string, Record<string, unknown>>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET' && url.endsWith('/configurations')) return response({ config: { ingress: [{ service: 'http_status:404' }] } });
      if (init?.method === 'PUT' && url.endsWith('/configurations')) return response({});
      if (init?.method === 'GET' && url.includes('/dns_records?')) return response([...records.values()]);
      if (init?.method === 'POST' && url.endsWith('/dns_records')) { const item = { id: 'tunnel-dns', ...JSON.parse(String(init.body)) }; records.set('tunnel-dns', item); return response(item); }
      if (init?.method === 'GET' && url.endsWith('/dns_records/tunnel-dns')) return response(records.get('tunnel-dns'));
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const observer = vi.fn(async () => ({ status: 'valid' as const, issuer: 'Cloudflare Inc ECC CA', validTo: new Date(Date.now() + 86_400_000).toISOString() }));
    const { app, store, cookie } = await authenticated(fetch, { tlsObserver: observer, guidedVerificationIntervalMs: 5 });
    const accountResponse = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Account', accountIdentifier: 'a'.repeat(32), apiToken: 'cloudflare-api-token-for-tunnel-test', enabled: true } });
    const account = store.cloudflareAccounts.find((item) => item.id === accountResponse.json().account.id)!;
    await store.syncCloudflareZones(account.id, [{ zoneIdentifier: 'b'.repeat(32), name: 'example.test', status: 'active' }]);
    const agent = await store.createAgent('gateway', hashToken('enrollment')); agent.enrolledAt = new Date().toISOString();
    const connector = await store.createConnector({ name: 'tunnel', encryptedToken: 'not-used', enabled: true, agentId: agent.id, accountId: account.id, accountIdentifier: account.accountIdentifier, tunnelId, identityStatus: 'verified' });
    const created = await app.inject({ method: 'POST', url: '/api/cloudflare/domain-publish', headers: { cookie, 'idempotency-key': 'publish-tunnel-1' }, payload: { accountId: account.id, zoneId: store.cloudflareZones[0]!.id, hostname: 'tunnel.example.test', agentId: agent.id, targetKind: 'host_port', target: '5800', accessMethod: 'tunnel', connectorId: connector!.id } });
    const command = store.commands.find((item) => item.type === 'traefik.route.sync')!; command.status = 'claimed';
    await store.completeCommand(agent.id, command.id, 'succeeded', { message: 'configuration written' });
    const pending = await app.inject({ method: 'POST', url: `/api/cloudflare/domain-publish/${created.json().operation.id}/reconcile`, headers: { cookie } });
    expect(pending.json()).toMatchObject({ operation: { stage: 'pending_https_verification' }, domainAccess: { status: 'pending', accessMethod: 'tunnel' } });
    await vi.waitFor(() => expect(store.guidedOperations[0]?.status).toBe('succeeded'));
    expect(observer).toHaveBeenCalledWith('tunnel.example.test');
    expect(store.cloudflareDomainAccess[0]).toMatchObject({ status: 'active', tlsStatus: 'valid' });
  });

  it('observes only persisted active public hostnames and emits one scoped expiry event', async () => {
    const observer = vi.fn(async () => ({ status: 'expiring' as const, issuer: 'Test CA', validTo: new Date(Date.now() + 86_400_000).toISOString() }));
    const { store } = await authenticated(vi.fn(), { tlsObserver: observer, tlsObservationIntervalMs: 5 });
    const agent = await store.createAgent('gateway', hashToken('enrollment'));
    const route = await store.createRoute({ gatewayAgentId: agent.id, name: 'public', hostname: 'cert.example.test', exposure: 'public', backends: ['http://app:80'], enabled: true }); route!.status = 'active';
    const now = new Date().toISOString();
    store.cloudflareDomainAccess.push({ id: crypto.randomUUID(), cloudflareZoneId: crypto.randomUUID(), cloudflareAccountId: crypto.randomUUID(), connectorId: null, routeId: route!.id, hostname: route!.hostname, accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'], publicIpv6: [], ownedDnsRecords: [], dnsRecordId: null, enabled: true, revision: 1, proxied: false, status: 'active', lastError: null, lastReconciledAt: now, tlsStatus: 'not_observed', tlsIssuer: null, tlsValidTo: null, tlsObservedAt: null, tlsError: null, createdAt: now, updatedAt: now });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(observer).toHaveBeenCalledWith('cert.example.test');
    expect(store.cloudflareDomainAccess[0]).toMatchObject({ tlsStatus: 'expiring', tlsIssuer: 'Test CA' });
    expect(store.events.filter((event) => event.type === 'certificate.expiring')).toHaveLength(1);
    expect(store.events[0]?.payload).toMatchObject({ domainAccessId: store.cloudflareDomainAccess[0]!.id, agentId: agent.id });
  });

  it('adds durable operations and TLS fields without destructive or cascading migration behavior', async () => {
    const sql = await readFile(new URL('../migrations/020_guided_domain_publishing.sql', import.meta.url), 'utf8');
    expect(sql).toContain('CREATE TABLE guided_operations');
    expect(sql).toContain("kind IN ('cloudflare_bootstrap', 'domain_publish')");
    expect(sql).toContain('ADD COLUMN tls_status');
    expect(sql).toContain('cloudflare_public_hostnames_tls_observation_idx');
    expect(sql).not.toMatch(/ON DELETE CASCADE|DELETE FROM|DROP (?:TABLE|COLUMN)/i);
    const hardening = await readFile(new URL('../migrations/024_deploy_domain_hardening.sql', import.meta.url), 'utf8');
    expect(hardening).toContain('verification_deadline_at');
    expect(hardening).toContain('pending_https_verification');
    expect(hardening).not.toMatch(/ON DELETE CASCADE|DELETE FROM|DROP (?:TABLE|COLUMN)/i);
  });

  it('keeps unreachable publication pending and then fails it at the bounded deadline', async () => {
    const observer = vi.fn(async () => ({ status: 'error' as const, error: 'tls_connection_failed' }));
    const records = new Map<string, Record<string, unknown>>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET' && url.includes('/dns_records?')) return response([...records.values()]);
      if (init?.method === 'POST' && url.endsWith('/dns_records')) { const item = { id: 'dns-timeout', ...JSON.parse(String(init.body)) }; records.set('dns-timeout', item); return response(item); }
      if (init?.method === 'GET' && url.endsWith('/dns_records/dns-timeout')) return response(records.get('dns-timeout'));
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const { app, store, cookie } = await authenticated(fetch, { tlsObserver: observer, guidedVerificationIntervalMs: 5, guidedVerificationTimeoutMs: 1 });
    const accountResponse = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Account', accountIdentifier: 'a'.repeat(32), apiToken: 'cloudflare-api-token-for-timeout-test', enabled: true } });
    const account = store.cloudflareAccounts.find((item) => item.id === accountResponse.json().account.id)!;
    await store.syncCloudflareZones(account.id, [{ zoneIdentifier: 'b'.repeat(32), name: 'example.test', status: 'active' }]);
    const agent = await store.createAgent('gateway', hashToken('enrollment')); agent.enrolledAt = new Date().toISOString();
    const created = await app.inject({ method: 'POST', url: '/api/cloudflare/domain-publish', headers: { cookie, 'idempotency-key': 'publish-timeout-1' }, payload: { accountId: account.id, zoneId: store.cloudflareZones[0]!.id, hostname: 'down.example.test', agentId: agent.id, targetKind: 'host_port', target: '5800', accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'] } });
    const command = store.commands.find((item) => item.type === 'traefik.route.sync')!; command.status = 'claimed';
    await store.completeCommand(agent.id, command.id, 'succeeded', { message: 'configuration written' });
    await app.inject({ method: 'POST', url: `/api/cloudflare/domain-publish/${created.json().operation.id}/reconcile`, headers: { cookie } });
    await vi.waitFor(() => expect(store.guidedOperations[0]).toMatchObject({ status: 'failed', stage: 'https_verification_failed', error: 'tls_connection_failed' }));
    expect(store.cloudflareDomainAccess[0]?.status).toBe('failed');
  });
});
