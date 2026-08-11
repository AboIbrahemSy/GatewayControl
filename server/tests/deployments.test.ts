import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/crypto.js';
import { FakeStore } from './fake-store.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture() {
  const compose = `services:\n  web:\n    image: nginx:1.27.5\n    restart: unless-stopped\n`;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    expect(String(input)).toMatch(/^https:\/\/raw\.githubusercontent\.com\/example\/reviewed-app\/[a-f0-9]{40}\/compose\.yaml$/);
    return new Response(compose, { headers: { 'content-type': 'application/x-unknown' } });
  });
  const store = new FakeStore(); const masterKey = randomBytes(32);
  const app = await buildApp({ store, masterKey, secureCookie: false, fetch, protectedProjects: ['critical'] }); apps.push(app);
  await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const agent = await store.createAgent('deployment-agent', hashToken('enrollment-token-long-enough'));
  const credential = 'deployment-agent-credential-long-enough'; const storedAgent = store.agents.find((item) => item.id === agent.id)!;
  storedAgent.enrolledAt = new Date().toISOString(); storedAgent.credentialHash = hashToken(credential); storedAgent.enabled = true;
  return { app, store, cookie, agent, credential, compose, fetch };
}

describe('reviewed deployments API', () => {
  it('previews without persistence and keeps Compose and environment data out of browser responses', async () => {
    const { app, store, cookie, agent, compose } = await fixture();
    const source = { repository: 'https://github.com/example/reviewed-app', commitSha: 'a'.repeat(40), composePath: 'compose.yaml', projectName: 'reviewed_app' };
    const preview = await app.inject({ method: 'POST', url: '/api/deployments/preview', headers: { cookie }, payload: source });
    expect(preview.statusCode).toBe(200); expect(store.deployments).toHaveLength(0); expect(preview.body).not.toContain(compose);
    const created = await app.inject({ method: 'POST', url: '/api/deployments', headers: { cookie }, payload: { ...source, agentId: agent.id, displayName: 'Reviewed app' } });
    expect(created.statusCode).toBe(201); expect(created.body).not.toContain(compose); expect(JSON.stringify(store.deploymentRevisions)).not.toContain(compose);
    const listed = await app.inject({ method: 'GET', url: '/api/deployments', headers: { cookie } });
    expect(listed.body).not.toContain('encrypted'); expect(listed.body).not.toContain(compose);
  });

  it('enforces owner mutations, active-run uniqueness, authoritative decoration, idempotent result, and stop without deletion', async () => {
    const { app, store, cookie, agent, credential } = await fixture();
    const source = { repository: 'https://github.com/example/reviewed-app', commitSha: 'b'.repeat(40), composePath: 'compose.yaml', projectName: 'reviewed_app', agentId: agent.id, displayName: 'Reviewed app' };
    const created = (await app.inject({ method: 'POST', url: '/api/deployments', headers: { cookie }, payload: source })).json().deployment;
    const viewer = await store.createUser('viewer@example.com', store.users[0]!.passwordHash, 'viewer'); store.sessions.set(hashToken('viewer-session-long-enough'), viewer.id);
    const viewerCookie = 'gateway_control_session=viewer-session-long-enough';
    expect((await app.inject({ method: 'GET', url: '/api/deployments', headers: { cookie: viewerCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/deployments/${created.id}/deploy`, headers: { cookie: viewerCookie }, payload: { revisionId: created.revisions[0].id } })).statusCode).toBe(403);

    const queued = await app.inject({ method: 'POST', url: `/api/deployments/${created.id}/deploy`, headers: { cookie }, payload: { revisionId: created.revisions[0].id } });
    expect(queued.statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: `/api/deployments/${created.id}/deploy`, headers: { cookie }, payload: { revisionId: created.revisions[0].id } })).statusCode).toBe(409);
    const claimed = await app.inject({ method: 'GET', url: '/api/agent/commands', headers: { authorization: `Bearer ${credential}` } });
    expect(claimed.json().commands[0]).toMatchObject({ type: 'deployment.compose.apply', payload: { revisionId: created.revisions[0].id, projectName: 'reviewed_app', action: 'deploy' } });
    expect(claimed.json().commands[0].payload.sourceCompose).toContain('services:');
    const commandId = claimed.json().commands[0].id;
    const completed = await app.inject({ method: 'POST', url: `/api/agent/commands/${commandId}/result`, headers: { authorization: `Bearer ${credential}` }, payload: { status: 'succeeded', result: { message: 'deployment applied' } } });
    expect(completed.json().idempotent).toBe(false);
    const duplicate = await app.inject({ method: 'POST', url: `/api/agent/commands/${commandId}/result`, headers: { authorization: `Bearer ${credential}` }, payload: { status: 'succeeded', result: { message: 'deployment applied' } } });
    expect(duplicate.json().idempotent).toBe(true); expect(store.events.at(-1)?.type).toBe('deployment.succeeded');

    const stopped = await app.inject({ method: 'POST', url: `/api/deployments/${created.id}/stop`, headers: { cookie }, payload: {} });
    expect(stopped.statusCode).toBe(202); expect(store.deployments).toHaveLength(1); expect(store.deploymentRevisions).toHaveLength(1);
  });

  it('rejects protected target projects before persistence', async () => {
    const { app, store, cookie, agent } = await fixture();
    const response = await app.inject({ method: 'POST', url: '/api/deployments', headers: { cookie }, payload: { repository: 'https://github.com/example/reviewed-app', commitSha: 'c'.repeat(40), composePath: 'compose.yaml', projectName: 'critical', agentId: agent.id, displayName: 'Critical' } });
    expect(response.statusCode).toBe(403); expect(store.deployments).toHaveLength(0);
  });
});
