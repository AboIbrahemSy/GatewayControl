import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { SecretBox, hashToken } from '../src/crypto.js';
import { FakeStore } from './fake-store.js';

const accountIdentifier = 'b'.repeat(32);
const tunnelId = '123e4567-e89b-12d3-a456-426614174000';
const apiToken = 'cloudflare-account-api-token-that-must-not-leak';
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

function token(secret = Buffer.alloc(32, 9)): string {
  return Buffer.from(JSON.stringify({ a: accountIdentifier, t: tunnelId, s: secret.toString('base64') })).toString('base64');
}

function response(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ code: 1000 }] }), { status });
}

function cloudflareFetch(remoteToken = token()): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${apiToken}`);
    const url = String(input);
    if (url.endsWith('/token')) return response(remoteToken);
    return response({ id: tunnelId, account_tag: accountIdentifier, deleted_at: null });
  });
}

async function fixture(fetch: typeof globalThis.fetch = cloudflareFetch()) {
  const store = new FakeStore();
  const masterKey = randomBytes(32);
  const app = await buildApp({ store, masterKey, secureCookie: false, fetch, connectorIdentityIntervalMs: 60_000 });
  apps.push(app);
  await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const account = await app.inject({ method: 'POST', url: '/api/cloudflare/accounts', headers: { cookie }, payload: { name: 'Connector identity', accountIdentifier, apiToken } });
  const agent = await store.createAgent('identity-agent', hashToken('identity-enrollment-token'));
  const credential = 'identity-agent-credential-that-is-long-enough';
  Object.assign(store.agents.find((item) => item.id === agent.id)!, { enrolledAt: new Date().toISOString(), credentialHash: hashToken(credential) });
  return { app, store, masterKey, cookie, accountId: account.json().account.id as string, agent, credential };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('connector identity and revision lifecycle', () => {
  it('auto-binds verified identity, decorates disable without a token, ignores disabled heartbeat, and queues reassignment cleanup', async () => {
    const context = await fixture();
    const connectorToken = token();
    const created = await context.app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie: context.cookie }, payload: { name: 'verified', token: connectorToken, agentId: context.agent.id } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(connectorToken);
    expect(created.body).not.toContain(apiToken);
    expect(created.json().connector).toMatchObject({ identityStatus: 'verified', cloudflareAccountId: context.accountId, tokenAccountIdentifier: accountIdentifier, tokenTunnelId: tunnelId, desiredRevision: 1 });

    const disabled = await context.app.inject({ method: 'PATCH', url: `/api/connectors/${created.json().connector.id}`, headers: { cookie: context.cookie }, payload: { enabled: false } });
    expect(disabled.json().connector).toMatchObject({ enabled: false, deploymentStatus: 'stopping', desiredRevision: 2 });
    const poll = await context.app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${context.credential}` } });
    expect(poll.json().commands[0].payload).toEqual({ connectorId: created.json().connector.id, revision: 2, enabled: false });
    expect(poll.body).not.toContain(connectorToken);

    context.store.connectors[0]!.runtimeStatus = 'stopped';
    await context.store.heartbeatAgent(context.agent.id, { diagnostics: { connectors: { [created.json().connector.id]: { status: 'connected' } } } });
    expect(context.store.connectors[0]!.runtimeStatus).toBe('stopped');

    const replacement = await context.store.createAgent('replacement-agent', hashToken('replacement-enrollment-token'));
    context.store.agents.find((item) => item.id === replacement.id)!.enrolledAt = new Date().toISOString();
    const reassigned = await context.app.inject({ method: 'PATCH', url: `/api/connectors/${created.json().connector.id}`, headers: { cookie: context.cookie }, payload: { agentId: replacement.id } });
    expect(reassigned.statusCode).toBe(200);
    expect(context.store.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: context.agent.id, type: 'cloudflare.connector.remove', payload: { connectorId: created.json().connector.id, revision: 3 } }),
      expect.objectContaining({ agentId: replacement.id, type: 'cloudflare.connector.sync', payload: { connectorId: created.json().connector.id, revision: 3 } }),
    ]));
  });

  it('keeps a claimed old revision result from overwriting the newer desired generation', async () => {
    const context = await fixture();
    const created = await context.app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie: context.cookie }, payload: { name: 'revisioned', token: token(), agentId: context.agent.id } });
    const connectorId = created.json().connector.id as string;
    const [oldCommand] = await context.store.claimCommands(context.agent.id, 1);
    await context.store.updateConnector(connectorId, { name: 'new desired name' });
    expect(context.store.connectors[0]).toMatchObject({ desiredRevision: 2, deploymentStatus: 'pending' });
    await context.store.completeCommand(context.agent.id, oldCommand!.id, 'succeeded', { runtimeStatus: 'connected' });
    expect(context.store.connectors[0]).toMatchObject({ desiredRevision: 2, deploymentStatus: 'pending', runtimeStatus: 'unknown' });
    expect(context.store.commands.some((command) => command.status === 'pending' && command.payload.revision === 2)).toBe(true);
  });

  it.each([
    ['unlinked account', 'unmatched', 'connector_account_unlinked', undefined],
    ['current token mismatch', 'mismatch', 'connector_token_mismatch', cloudflareFetch(token(Buffer.alloc(32, 4)))],
    ['transient Cloudflare failure', 'parsed', 'connector_identity_verification_failed', vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('network token secret'))],
  ])('persists and deploys strictly parsed tokens after %s', async (_case, identityStatus, identityError, fetch) => {
    const context = await fixture(fetch ?? cloudflareFetch());
    if (identityStatus === 'unmatched') context.store.cloudflareAccounts[0]!.enabled = false;
    const connectorToken = token();
    const result = await context.app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie: context.cookie }, payload: { name: 'standalone', token: connectorToken, agentId: context.agent.id } });
    expect(result.statusCode).toBe(201);
    expect(result.json().connector).toMatchObject({
      identityStatus, identityError, tokenAccountIdentifier: accountIdentifier, tokenTunnelId: tunnelId,
      ...(identityStatus === 'unmatched' ? { cloudflareAccountId: null, tunnelId: null } : { cloudflareAccountId: context.accountId, tunnelId }),
    });
    expect(result.body).not.toContain(connectorToken);
    expect(result.body).not.toContain(apiToken);
    const poll = await context.app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${context.credential}` } });
    expect(poll.json().commands[0].payload).toMatchObject({ connectorId: result.json().connector.id, enabled: true, token: connectorToken });
  });

  it('rejects malformed connector tokens before persistence', async () => {
    const context = await fixture();
    const result = await context.app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie: context.cookie }, payload: { name: 'malformed', token: 'x'.repeat(48), agentId: context.agent.id } });
    expect(result.statusCode).toBe(400);
    expect(result.json().code).toBe('invalid_connector_token');
    expect(context.store.connectors).toHaveLength(0);
  });

  it('manually verifies a legacy pending connector and persists malformed legacy tokens as invalid', async () => {
    const context = await fixture();
    const created = await context.app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie: context.cookie }, payload: { name: 'legacy', token: token(), agentId: context.agent.id } });
    const connector = context.store.connectors[0]!;
    const topology = { cloudflareAccountId: connector.cloudflareAccountId, tunnelId: connector.tunnelId };
    Object.assign(connector, { identityStatus: 'pending', identityVerifiedAt: null, identityError: null, encryptedToken: new SecretBox(context.masterKey).encrypt('malformed legacy token') });
    const invalid = await context.app.inject({ method: 'POST', url: `/api/connectors/${created.json().connector.id}/verify`, headers: { cookie: context.cookie } });
    expect(invalid.statusCode).toBe(400);
    expect(context.store.connectors[0]).toMatchObject({ identityStatus: 'invalid', identityError: 'invalid_connector_token', ...topology });

    connector.encryptedToken = new SecretBox(context.masterKey).encrypt(token());
    const verified = await context.app.inject({ method: 'POST', url: `/api/connectors/${connector.id}/verify`, headers: { cookie: context.cookie } });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().connector).toMatchObject({ identityStatus: 'verified', tokenAccountIdentifier: accountIdentifier, tokenTunnelId: tunnelId });
  });

  it('preserves legacy topology and records an identity mismatch instead of rebinding it', async () => {
    const context = await fixture();
    const created = await context.app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie: context.cookie }, payload: { name: 'legacy mismatch', token: token(), agentId: context.agent.id } });
    const connector = context.store.connectors[0]!;
    const persistedTunnelId = '223e4567-e89b-12d3-a456-426614174000';
    Object.assign(connector, { tunnelId: persistedTunnelId, identityStatus: 'pending', identityVerifiedAt: null });

    const result = await context.app.inject({ method: 'POST', url: `/api/connectors/${created.json().connector.id}/verify`, headers: { cookie: context.cookie } });

    expect(result.statusCode).toBe(409);
    expect(result.json().code).toBe('connector_identity_mismatch');
    expect(context.store.connectors[0]).toMatchObject({
      cloudflareAccountId: context.accountId,
      tunnelId: persistedTunnelId,
      tokenAccountIdentifier: accountIdentifier,
      tokenTunnelId: tunnelId,
      identityStatus: 'mismatch',
      identityError: 'connector_identity_mismatch',
    });
    expect(result.body).not.toContain(token());
    expect(result.body).not.toContain(apiToken);
  });

  it('rejects identity writes when either the desired revision or encrypted token version was superseded', async () => {
    const context = await fixture();
    await context.app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie: context.cookie }, payload: { name: 'guarded', token: token(), agentId: context.agent.id } });
    const connector = context.store.connectors[0]!;
    const expected = { desiredRevision: connector.desiredRevision, encryptedToken: connector.encryptedToken };
    connector.encryptedToken = new SecretBox(context.masterKey).encrypt(token(Buffer.alloc(32, 7)));

    expect(await context.store.markConnectorIdentity(connector.id, expected, { status: 'invalid', error: 'stale_result' })).toBeNull();
    expect(connector).toMatchObject({ identityStatus: 'verified', cloudflareAccountId: context.accountId, tunnelId });
  });

  it('does not let delayed verification of an old token overwrite a newer token revision', async () => {
    let remoteToken = token();
    let delayNextTokenRead = false;
    let releaseOldVerification!: () => void;
    let oldVerificationStarted!: () => void;
    const started = new Promise<void>((resolve) => { oldVerificationStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseOldVerification = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${apiToken}`);
      if (String(input).endsWith('/token')) {
        if (delayNextTokenRead) {
          delayNextTokenRead = false;
          oldVerificationStarted();
          await release;
          return response(token());
        }
        return response(remoteToken);
      }
      return response({ id: tunnelId, account_tag: accountIdentifier, deleted_at: null });
    });
    const context = await fixture(fetch);
    const oldToken = token();
    const created = await context.app.inject({ method: 'POST', url: '/api/connectors', headers: { cookie: context.cookie }, payload: { name: 'concurrent', token: oldToken, agentId: context.agent.id } });
    const connector = context.store.connectors[0]!;
    connector.identityStatus = 'pending';
    delayNextTokenRead = true;
    const oldVerification = context.app.inject({ method: 'POST', url: `/api/connectors/${connector.id}/verify`, headers: { cookie: context.cookie } });
    await started;

    const newToken = token(Buffer.alloc(32, 7));
    remoteToken = newToken;
    const updated = await context.app.inject({ method: 'PATCH', url: `/api/connectors/${connector.id}`, headers: { cookie: context.cookie }, payload: { token: newToken } });
    expect(updated.statusCode).toBe(200);
    expect(connector.desiredRevision).toBe(2);
    connector.identityStatus = 'pending';
    connector.identityError = 'newer_token_pending';
    releaseOldVerification();

    expect((await oldVerification).json().connector).toBeNull();
    expect(connector).toMatchObject({ desiredRevision: 2, identityStatus: 'pending', identityError: 'newer_token_pending' });
    expect(updated.body).not.toContain(newToken);
    expect(updated.body).not.toContain(apiToken);
    expect(created.body).not.toContain(oldToken);
  });
});
