import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/crypto.js';
import { FakeStore } from './fake-store.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function envelope(result: unknown, status = 200, success = true): Response {
  return new Response(JSON.stringify({ success, result, errors: success ? [] : [{ code: 1000 }], result_info: { page: 1, total_pages: 1 } }), { status });
}

describe('automatic Cloudflare bootstrap', () => {
  it('persists an external partial, retries idempotently, and never returns secrets', async () => {
    const accountIdentifier = 'a'.repeat(32);
    const tunnelId = '123e4567-e89b-12d3-a456-426614174000';
    const tunnelSecret = Buffer.alloc(32, 9).toString('base64');
    const connectorToken = Buffer.from(JSON.stringify({ a: accountIdentifier, t: tunnelId, s: tunnelSecret })).toString('base64');
    let tokenCalls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/user/tokens/verify')) return envelope({ status: 'active' });
      if (url.includes('/zones?')) return envelope([{ id: 'b'.repeat(32), name: 'example.test', status: 'active' }]);
      if (url.includes('/cfd_tunnel?')) return envelope([]);
      if (init?.method === 'POST' && url.endsWith('/cfd_tunnel')) {
        const body = JSON.parse(String(init.body));
        expect(body.name).toMatch(/^[a-z0-9-]{3,100}$/);
        expect(Buffer.from(body.tunnel_secret, 'base64')).toHaveLength(32);
        return envelope({ id: tunnelId, name: body.name });
      }
      if (url.endsWith('/token')) return ++tokenCalls === 1 ? envelope({}, 500, false) : envelope(connectorToken);
      if (url.endsWith(`/cfd_tunnel/${tunnelId}`)) return envelope({ id: tunnelId, account_tag: accountIdentifier, deleted_at: null });
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const store = new FakeStore();
    const app = await buildApp({ store, masterKey: randomBytes(32), secureCookie: false, fetch }); apps.push(app);
    await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const agent = await store.createAgent('gateway', hashToken('enrollment')); agent.enrolledAt = new Date().toISOString();
    const apiToken = 'cloudflare-api-token-that-must-never-return';
    const payload = { name: 'Production', accountIdentifier, apiToken, enabled: true, createManagedTunnel: true, agentId: agent.id, connectorName: 'Primary connector' };
    const headers = { cookie, 'idempotency-key': 'bootstrap-idempotency-1' };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers, payload }),
      app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers, payload }),
    ]);
    const first = responses.find((item) => item.statusCode === 502)!;
    const retried = responses.find((item) => item.statusCode === 200)!;
    expect(first).toBeDefined();
    expect(store.guidedOperations[0]).toMatchObject({ status: 'succeeded', remoteTunnelId: tunnelId, stage: 'complete' });
    expect(store.cloudflareAccounts).toHaveLength(1);
    expect(retried).toBeDefined();
    expect(retried.json()).toMatchObject({ zoneCount: 1, tunnel: { id: tunnelId }, connector: { identityStatus: 'verified' }, operation: { status: 'succeeded' } });
    expect(retried.body).not.toContain(apiToken); expect(retried.body).not.toContain(connectorToken); expect(retried.body).not.toContain(tunnelSecret);
    expect(store.cloudflareAccounts).toHaveLength(1); expect(store.connectors).toHaveLength(1);
    expect(fetch.mock.calls.filter(([input, init]) => init?.method === 'POST' && String(input).endsWith('/cfd_tunnel'))).toHaveLength(1);
    expect(store.commands.filter((command) => command.type === 'cloudflare.connector.sync')).toHaveLength(1);
  });

  it('requires Operator or Owner', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const store = new FakeStore(); const app = await buildApp({ store, masterKey: randomBytes(32), secureCookie: false, fetch }); apps.push(app);
    const owner = await store.createOwner('owner@example.test', 'hash');
    const viewer = await store.createUser('viewer@example.test', 'hash', 'viewer');
    store.sessions.set(hashToken('viewer-session-token-with-enough-length'), viewer.id);
    const denied = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie: 'gateway_control_session=viewer-session-token-with-enough-length', 'idempotency-key': 'bootstrap-role-1' }, payload: {} });
    expect(denied.statusCode).toBe(403); expect(fetch).not.toHaveBeenCalled(); expect(owner).not.toBeNull();
  });

  it('serializes the same idempotency key while allowing different keys to run in parallel', async () => {
    const store = new FakeStore();
    let sameKeyActive = 0; let sameKeyMaximum = 0; let differentKeyActive = 0; let differentKeyMaximum = 0;
    const same = async () => store.withGuidedOperationLock('cloudflare_bootstrap', 'user', 'same-key', async () => {
      sameKeyActive += 1; sameKeyMaximum = Math.max(sameKeyMaximum, sameKeyActive);
      await new Promise((resolve) => setTimeout(resolve, 10)); sameKeyActive -= 1;
    });
    await Promise.all([same(), same()]);
    const different = (key: string) => store.withGuidedOperationLock('cloudflare_bootstrap', 'user', key, async () => {
      differentKeyActive += 1; differentKeyMaximum = Math.max(differentKeyMaximum, differentKeyActive);
      await new Promise((resolve) => setTimeout(resolve, 10)); differentKeyActive -= 1;
    });
    await Promise.all([different('key-one'), different('key-two')]);
    expect(sameKeyMaximum).toBe(1);
    expect(differentKeyMaximum).toBe(2);
  });
});
