import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { CloudflareClient } from '../src/cloudflare-client.js';
import { hashToken } from '../src/crypto.js';
import { FakeStore } from './fake-store.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function cloudflareResponse(result: unknown = {}, options: { status?: number; success?: boolean; code?: number } = {}): Response {
  return new Response(JSON.stringify({ success: options.success ?? true, result, errors: options.code ? [{ code: options.code }] : [] }), { status: options.status ?? 200 });
}

async function fixture(fetch: typeof globalThis.fetch, exposure: 'tunnel' | 'public' = 'public') {
  const store = new FakeStore();
  const app = await buildApp({ store, masterKey: randomBytes(32), secureCookie: false, fetch });
  apps.push(app);
  await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const ownerCookie = String(login.headers['set-cookie']).split(';')[0]!;
  const apiToken = 'domain-access-cloudflare-token-never-returned';
  const accountResponse = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie: ownerCookie }, payload: { name: 'Domain access', accountIdentifier: 'a'.repeat(32), apiToken } });
  const accountId = accountResponse.json().account.id as string;
  await store.syncCloudflareZones(accountId, [{ zoneIdentifier: 'b'.repeat(32), name: 'example.test', status: 'active' }]);
  const agent = await store.createAgent('domain-gateway', hashToken('domain-gateway-enrollment-token'));
  const route = await store.createRoute({ gatewayAgentId: agent.id, name: 'domain-route', hostname: 'app.example.test', exposure, backends: ['http://app:8080'], enabled: true });
  route!.status = 'active';
  const operator = await store.createUser('operator@example.com', store.users[0]!.passwordHash, 'operator');
  const viewer = await store.createUser('viewer@example.com', store.users[0]!.passwordHash, 'viewer');
  store.sessions.set(hashToken('operator-domain-access-session-token'), operator.id);
  store.sessions.set(hashToken('viewer-domain-access-session-token'), viewer.id);
  return {
    app, store, apiToken, accountId, zoneId: store.cloudflareZones[0]!.id, agent, route: route!, ownerCookie,
    operatorCookie: 'gateway_control_session=operator-domain-access-session-token',
    viewerCookie: 'gateway_control_session=viewer-domain-access-session-token',
  };
}

function dnsFetch() {
  const records = new Map<string, { id: string; type: 'A' | 'AAAA' | 'CNAME'; name: string; content: string; proxied: boolean; ttl: number; comment?: string }>();
  const deleted: string[] = [];
  let sequence = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET' && url.includes('/dns_records?')) return cloudflareResponse([...records.values()]);
    if (init?.method === 'POST' && url.endsWith('/dns_records')) {
      const body = JSON.parse(String(init.body));
      const record = { id: `owned-${++sequence}`, ...body };
      records.set(record.id, record);
      return cloudflareResponse(record);
    }
    const id = url.split('/').at(-1)!;
    if (init?.method === 'GET' && url.includes('/dns_records/')) return records.has(id) ? cloudflareResponse(records.get(id)) : cloudflareResponse({}, { status: 404, success: false, code: 81044 });
    if (init?.method === 'DELETE' && url.includes('/dns_records/')) {
      deleted.push(id); records.delete(id); return cloudflareResponse({ id });
    }
    throw new Error(`Unexpected request: ${init?.method} ${url}`);
  });
  return { fetch, records, deleted };
}

describe('Cloudflare domain access', () => {
  it('rejects standalone connectors that are not verified and linked to the selected account', async () => {
    const dns = dnsFetch();
    const context = await fixture(dns.fetch, 'tunnel');
    context.agent.enrolledAt = new Date().toISOString();
    const tunnelId = randomUUID();
    const connector = await context.store.createConnector({
      name: 'standalone', encryptedToken: 'encrypted', enabled: true, agentId: context.agent.id,
      accountIdentifier: 'a'.repeat(32), tunnelId, identityStatus: 'unmatched', identityError: 'connector_account_unlinked',
    });
    context.store.commands.length = 0;

    const created = await context.app.inject({
      method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.operatorCookie },
      payload: { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'tunnel', connectorId: connector!.id },
    });

    expect(created.statusCode).toBe(409);
    expect(created.json().code).toBe('tunnel_topology_mismatch');
    expect(dns.fetch).not.toHaveBeenCalled();
  });

  it('lets operators create and viewers read public IPv4/IPv6 access without exposing tokens', async () => {
    const dns = dnsFetch();
    const context = await fixture(dns.fetch);
    const denied = await context.app.inject({ method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.viewerCookie }, payload: {} });
    expect(denied.statusCode).toBe(403);

    const created = await context.app.inject({
      method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.operatorCookie },
      payload: { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'], publicIpv6: ['2606:4700:4700:0:0:0:0:1111'], proxied: false },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(context.apiToken);
    expect(created.json().domainAccess).toMatchObject({ accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'], publicIpv6: ['2606:4700:4700::1111'], status: 'active', connectorId: null });
    expect(created.json().domainAccess.ownedDnsRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'A', content: '1.1.1.1', status: 'active' }),
      expect.objectContaining({ type: 'AAAA', content: '2606:4700:4700::1111', status: 'active' }),
    ]));
    expect(dns.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      expect.objectContaining({ type: 'A', name: 'app.example.test', content: '1.1.1.1', proxied: false, ttl: 1, comment: `gateway-control:domain-access:${created.json().domainAccess.id}` }),
      expect.objectContaining({ type: 'AAAA', name: 'app.example.test', content: '2606:4700:4700::1111', proxied: false, ttl: 1, comment: `gateway-control:domain-access:${created.json().domainAccess.id}` }),
    ]);
    expect((await context.app.inject({ method: 'GET', url: '/api/cloudflare/domain-access', headers: { cookie: context.viewerCookie } })).statusCode).toBe(200);

    const id = created.json().domainAccess.id as string;
    const postCount = dns.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').length;
    expect((await context.app.inject({ method: 'POST', url: `/api/cloudflare/domain-access/${id}/reconcile`, headers: { cookie: context.operatorCookie } })).statusCode).toBe(200);
    expect(dns.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(postCount);

    dns.records.set('unknown-record', { id: 'unknown-record', type: 'A', name: 'app.example.test', content: '8.8.8.8', proxied: false, ttl: 1 });
    const disabled = await context.app.inject({ method: 'PATCH', url: `/api/cloudflare/domain-access/${id}`, headers: { cookie: context.operatorCookie }, payload: { enabled: false } });
    expect(disabled.json().domainAccess).toMatchObject({ enabled: false, status: 'disabled' });
    expect(dns.deleted.sort()).toEqual(['owned-1', 'owned-2']);
    expect(dns.records.has('unknown-record')).toBe(true);
    const callCount = dns.fetch.mock.calls.length;
    await context.app.inject({ method: 'PATCH', url: `/api/cloudflare/domain-access/${id}`, headers: { cookie: context.operatorCookie }, payload: { enabled: false } });
    expect(dns.fetch).toHaveBeenCalledTimes(callCount);
    dns.records.delete('unknown-record');
    const enabled = await context.app.inject({ method: 'PATCH', url: `/api/cloudflare/domain-access/${id}`, headers: { cookie: context.operatorCookie }, payload: { enabled: true } });
    expect(enabled.json().domainAccess).toMatchObject({ enabled: true, status: 'active' });
    expect([...dns.records.keys()].sort()).toEqual(['owned-3', 'owned-4']);
  });

  it.each([
    [['10.0.0.1'], [], 'non_global_public_ip'],
    [['192.0.2.1'], [], 'non_global_public_ip'],
    [[], ['fc00::1'], 'non_global_public_ip'],
    [[], ['fe80::1'], 'non_global_public_ip'],
    [[], ['ff02::1'], 'non_global_public_ip'],
    [[], ['::'], 'non_global_public_ip'],
    [[], ['2001:db8::1'], 'non_global_public_ip'],
    [[], ['3fff::1'], 'non_global_public_ip'],
    [[], ['::ffff:8.8.8.8'], 'non_global_public_ip'],
    [[], ['64:ff9b::808:808'], 'non_global_public_ip'],
    [['not-an-ip'], [], 'invalid_public_ip'],
    [['1.1.1.1', '01.001.001.001'], [], 'invalid_public_ip'],
    [['1.1.1.1', '1.1.1.1'], [], 'duplicate_public_ip'],
    [['1.1.1.1', '8.8.8.8', '9.9.9.9', '208.67.222.222', '208.67.220.220'], [], 'invalid_public_ip'],
  ])('rejects unsafe, malformed, duplicate, or excessive public addresses', async (publicIpv4, publicIpv6, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const context = await fixture(fetch);
    const response = await context.app.inject({
      method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie },
      payload: { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'public_ip', publicIpv4, publicIpv6 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe(code);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects inactive or mismatched routes, account-zone mismatches, and tunnel agent mismatches', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const context = await fixture(fetch, 'tunnel');
    const otherAgent = await context.store.createAgent('other-agent', hashToken('other-agent-enrollment-token'));
    context.store.agents.find((item) => item.id === otherAgent.id)!.enrolledAt = new Date().toISOString();
    const connector = await context.store.createConnector({ name: 'wrong-agent-tunnel', encryptedToken: 'encrypted', enabled: true, agentId: otherAgent.id, accountId: context.accountId, accountIdentifier: 'a'.repeat(32), tunnelId: randomUUID(), identityStatus: 'verified' });
    const payload = { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'tunnel', connectorId: connector!.id };
    const mismatch = await context.app.inject({ method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie }, payload });
    expect(mismatch.json().code).toBe('tunnel_topology_mismatch');
    context.route.status = 'failed';
    expect((await context.app.inject({ method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie }, payload })).json().code).toBe('domain_access_route_invalid');
    context.route.status = 'active';
    const otherAccount = await context.store.createCloudflareAccount({ name: 'Other', accountIdentifier: 'c'.repeat(32), encryptedApiToken: 'encrypted', enabled: true });
    expect((await context.app.inject({ method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie }, payload: { ...payload, accountId: otherAccount.id } })).json().code).toBe('cloudflare_zone_invalid');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires verified derived connector identity to equal persisted tunnel topology', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const context = await fixture(fetch, 'tunnel');
    context.store.agents.find((item) => item.id === context.agent.id)!.enrolledAt = new Date().toISOString();
    const connector = await context.store.createConnector({ name: 'derived mismatch', encryptedToken: 'encrypted', enabled: true, agentId: context.agent.id, accountId: context.accountId, accountIdentifier: 'a'.repeat(32), tunnelId: randomUUID(), identityStatus: 'verified' });
    const payload = { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'tunnel', connectorId: connector!.id };
    context.store.connectors[0]!.tokenAccountIdentifier = 'c'.repeat(32);

    const accountMismatch = await context.app.inject({ method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie }, payload });
    expect(accountMismatch.statusCode).toBe(409);
    expect(accountMismatch.json().code).toBe('tunnel_topology_mismatch');

    context.store.connectors[0]!.tokenAccountIdentifier = 'a'.repeat(32);
    context.store.connectors[0]!.tokenTunnelId = randomUUID();
    const tunnelMismatch = await context.app.inject({ method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie }, payload });
    expect(tunnelMismatch.statusCode).toBe(409);
    expect(tunnelMismatch.json().code).toBe('tunnel_topology_mismatch');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails on an unknown same-type record without updating or deleting it', async () => {
    const dns = dnsFetch();
    dns.records.set('unknown-a', { id: 'unknown-a', type: 'A', name: 'app.example.test', content: '8.8.8.8', proxied: true, ttl: 1 });
    const context = await fixture(dns.fetch);
    const response = await context.app.inject({
      method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie },
      payload: { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('dns_record_conflict');
    expect(dns.records.get('unknown-a')?.content).toBe('8.8.8.8');
    expect(dns.deleted).toEqual([]);
    expect(dns.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('compensates only records created by the failed reconciliation attempt', async () => {
    const dns = dnsFetch();
    const context = await fixture(dns.fetch);
    const created = await context.app.inject({
      method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie },
      payload: { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'] },
    });
    const access = context.store.cloudflareDomainAccess[0]!;
    access.publicIpv4.push('8.8.8.8', '9.9.9.9');
    const originalFetch = dns.fetch.getMockImplementation()!;
    dns.fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'POST' && JSON.parse(String(init.body)).content === '9.9.9.9') return cloudflareResponse({}, { status: 500, success: false, code: 1000 });
      return originalFetch(input, init);
    });
    const reconciled = await context.app.inject({ method: 'POST', url: `/api/cloudflare/domain-access/${created.json().domainAccess.id}/reconcile`, headers: { cookie: context.ownerCookie } });
    expect(reconciled.statusCode).toBe(502);
    expect(dns.deleted).toEqual(['owned-2']);
    expect(dns.records.has('owned-1')).toBe(true);
    expect(access.ownedDnsRecords.find((record) => record.cloudflareRecordId === 'owned-1')?.status).toBe('active');
    expect(access.ownedDnsRecords.find((record) => record.cloudflareRecordId === 'owned-2')?.status).toBe('deleted');
  });

  it('retains ownership as cleanup pending after deletion failure and retries disable safely', async () => {
    const dns = dnsFetch();
    const context = await fixture(dns.fetch);
    const created = await context.app.inject({
      method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie },
      payload: { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'] },
    });
    const originalFetch = dns.fetch.getMockImplementation()!;
    let failDelete = true;
    dns.fetch.mockImplementation(async (input, init) => {
      if (failDelete && init?.method === 'DELETE') return cloudflareResponse({}, { status: 500, success: false, code: 1000 });
      return originalFetch(input, init);
    });
    const id = created.json().domainAccess.id as string;
    const failed = await context.app.inject({ method: 'PATCH', url: `/api/cloudflare/domain-access/${id}`, headers: { cookie: context.ownerCookie }, payload: { enabled: false } });
    expect(failed.statusCode).toBe(502);
    expect(context.store.cloudflareDomainAccess[0]).toMatchObject({ enabled: false, status: 'failed' });
    expect(context.store.cloudflareDomainAccess[0]!.ownedDnsRecords[0]).toMatchObject({ cloudflareRecordId: 'owned-1', status: 'cleanup_pending' });
    failDelete = false;
    const retried = await context.app.inject({ method: 'PATCH', url: `/api/cloudflare/domain-access/${id}`, headers: { cookie: context.ownerCookie }, payload: { enabled: false } });
    expect(retried.json().domainAccess).toMatchObject({ enabled: false, status: 'disabled' });
    expect(context.store.cloudflareDomainAccess[0]!.ownedDnsRecords[0]!.status).toBe('deleted');
  });

  it('does not treat unrelated Cloudflare 404 responses as DNS absence', async () => {
    const dns = dnsFetch();
    const context = await fixture(dns.fetch);
    const created = await context.app.inject({
      method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie },
      payload: { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'] },
    });
    const originalFetch = dns.fetch.getMockImplementation()!;
    dns.fetch.mockImplementation(async (input, init) => init?.method === 'DELETE'
      ? cloudflareResponse({}, { status: 404, success: false, code: 1000 }) : originalFetch(input, init));
    const response = await context.app.inject({ method: 'PATCH', url: `/api/cloudflare/domain-access/${created.json().domainAccess.id}`, headers: { cookie: context.ownerCookie }, payload: { enabled: false } });
    expect(response.statusCode).toBe(502);
    expect(context.store.cloudflareDomainAccess[0]!.ownedDnsRecords[0]!.status).toBe('cleanup_pending');
  });

  it('adopts an ambiguously created record only by exact ownership marker and content', async () => {
    const records: Array<Record<string, unknown>> = [];
    let postAttempted = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET' && url.includes('/dns_records?')) return cloudflareResponse(records);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        records.push({ id: 'ambiguous-owned', ...body });
        postAttempted = true;
        throw new Error('Connection ended after Cloudflare accepted the request.');
      }
      if (init?.method === 'GET' && url.endsWith('/dns_records/ambiguous-owned')) return cloudflareResponse(records[0]);
      throw new Error(`Unexpected request: ${init?.method} ${url}`);
    });
    const context = await fixture(fetch);
    const created = await context.app.inject({
      method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie },
      payload: { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'] },
    });
    expect(created.statusCode).toBe(201);
    expect(postAttempted).toBe(true);
    expect(created.json().domainAccess.ownedDnsRecords[0]).toMatchObject({ cloudflareRecordId: 'ambiguous-owned', status: 'active' });
  });

  it('serializes reconcile with a newer disable and prevents stale outcome writes', async () => {
    const dns = dnsFetch();
    const context = await fixture(dns.fetch);
    const created = await context.app.inject({
      method: 'POST', url: '/api/cloudflare/domain-access', headers: { cookie: context.ownerCookie },
      payload: { accountId: context.accountId, zoneId: context.zoneId, routeId: context.route.id, accessMethod: 'public_ip', publicIpv4: ['1.1.1.1'] },
    });
    const originalFetch = dns.fetch.getMockImplementation()!;
    let releaseList!: () => void;
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => { listStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseList = resolve; });
    let listCalls = 0;
    dns.fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET' && String(input).includes('/dns_records?') && ++listCalls === 1) {
        listStarted();
        await release;
      }
      return originalFetch(input, init);
    });
    const id = created.json().domainAccess.id as string;
    const reconciling = context.app.inject({ method: 'POST', url: `/api/cloudflare/domain-access/${id}/reconcile`, headers: { cookie: context.ownerCookie } });
    await started;
    const disabling = context.app.inject({ method: 'PATCH', url: `/api/cloudflare/domain-access/${id}`, headers: { cookie: context.ownerCookie }, payload: { enabled: false } });
    while (context.store.cloudflareDomainAccess[0]!.enabled) await new Promise((resolve) => setTimeout(resolve, 1));
    releaseList();
    expect((await reconciling).json().code).toBe('domain_access_superseded');
    expect((await disabling).json().domainAccess).toMatchObject({ enabled: false, status: 'disabled' });
  });

  it('serializes different domain accesses that share an account and tunnel', async () => {
    const store = new FakeStore();
    const account = await store.createCloudflareAccount({ name: 'Shared tunnel', accountIdentifier: 'a'.repeat(32), encryptedApiToken: 'encrypted', enabled: true });
    const agent = await store.createAgent('shared-tunnel-agent', hashToken('shared-tunnel-enrollment'));
    store.agents[0]!.enrolledAt = new Date().toISOString();
    const tunnelId = randomUUID();
    const connector = await store.createConnector({ name: 'shared', encryptedToken: 'encrypted', enabled: true, agentId: agent.id, accountId: account.id, accountIdentifier: account.accountIdentifier, tunnelId, identityStatus: 'verified' });
    const now = new Date().toISOString();
    for (const hostname of ['one.example.test', 'two.example.test']) {
      store.cloudflareDomainAccess.push({
        id: randomUUID(), cloudflareZoneId: randomUUID(), cloudflareAccountId: account.id, connectorId: connector!.id,
        routeId: randomUUID(), hostname, accessMethod: 'tunnel', publicIpv4: [], publicIpv6: [], ownedDnsRecords: [],
        dnsRecordId: null, enabled: true, revision: 1, proxied: true, status: 'pending', lastError: null,
        lastReconciledAt: null, createdAt: now, updatedAt: now,
      });
    }
    let active = 0;
    let maximumActive = 0;
    const run = (id: string) => store.withDomainAccessLock(id, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });
    await Promise.all(store.cloudflareDomainAccess.map((access) => run(access.id)));
    expect(maximumActive).toBe(1);
  });

  it('marks omitted zones unavailable only after successful synchronization', async () => {
    const store = new FakeStore();
    const account = await store.createCloudflareAccount({ name: 'Zones', accountIdentifier: 'a'.repeat(32), encryptedApiToken: 'encrypted', enabled: true });
    await store.syncCloudflareZones(account.id, [
      { zoneIdentifier: 'b'.repeat(32), name: 'one.example', status: 'active' },
      { zoneIdentifier: 'c'.repeat(32), name: 'two.example', status: 'active' },
    ]);
    await store.syncCloudflareZones(account.id, [{ zoneIdentifier: 'b'.repeat(32), name: 'one.example', status: 'active' }], 'partial pagination failure');
    expect(store.cloudflareZones.find((zone) => zone.name === 'two.example')!.status).toBe('active');
    await store.syncCloudflareZones(account.id, [{ zoneIdentifier: 'b'.repeat(32), name: 'one.example', status: 'active' }]);
    expect(store.cloudflareZones.find((zone) => zone.name === 'two.example')!.status).toBe('unavailable');
  });

  it('fails closed when exact DNS pagination exceeds its bounded limit', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ success: true, result: [], result_info: { page: 1, total_pages: 11 } }), { status: 200 }));
    await expect(new CloudflareClient('token', fetch).listDnsRecordsExact('b'.repeat(32), 'app.example.test')).rejects.toThrow('10-page safety limit');
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it('defines additive non-cascading migration constraints and no row deletion', async () => {
    const sql = await readFile(new URL('../migrations/012_domain_access.sql', import.meta.url), 'utf8');
    expect(sql).toContain("access_method text NOT NULL DEFAULT 'tunnel'");
    expect(sql).toContain("status IN ('pending', 'active', 'failed', 'disabled')");
    expect(sql).toContain('cardinality(public_ipv4) <= 4');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).not.toMatch(/ON DELETE CASCADE|DELETE FROM cloudflare_public_hostnames/i);
  });

  it('hardens revisions, ownership cleanup, legacy rows, uniqueness, and address families additively', async () => {
    const sql = await readFile(new URL('../migrations/016_domain_access_hardening.sql', import.meta.url), 'utf8');
    expect(sql).toContain('ADD COLUMN revision bigint NOT NULL DEFAULT 1');
    expect(sql).toContain("status IN ('active', 'cleanup_pending', 'deleted')");
    expect(sql).toContain('cloudflare_domain_access_dns_records_remote_id_unique');
    expect(sql).toContain('gateway_domain_access_ip_family');
    expect(sql).toContain('Legacy DNS ownership has no persisted tunnel identifier and requires cleanup.');
    expect(sql).toContain("status = 'failed'");
    expect(sql).toMatch(/OLD\.cloudflare_account_id IS DISTINCT FROM NEW\.cloudflare_account_id/);
    expect(sql).toMatch(/OLD\.tunnel_id IS DISTINCT FROM NEW\.tunnel_id/);
    expect(sql).toMatch(/OLD\.token_encrypted IS DISTINCT FROM NEW\.token_encrypted/);
    expect(sql).not.toMatch(/OLD\.identity_status IS DISTINCT FROM NEW\.identity_status/);
    expect(sql).not.toMatch(/OLD\.token_(?:account_identifier|tunnel_id) IS DISTINCT FROM NEW\.token_/);
    expect(sql).not.toMatch(/ON DELETE CASCADE|DELETE FROM cloudflare_public_hostnames/i);
  });
});
