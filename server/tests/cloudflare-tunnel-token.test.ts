import { describe, expect, it } from 'vitest';
import { CloudflareTunnelTokenError, parseCloudflareTunnelToken } from '../src/cloudflare-tunnel-token.js';

const accountIdentifier = 'a'.repeat(32);
const tunnelId = '123e4567-e89b-12d3-a456-426614174000';
const secret = Buffer.alloc(32, 11);

function encode(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
}

describe('Cloudflare tunnel token parser', () => {
  it('parses canonical standard and recognized FedRAMP tokens without exposing the secret', () => {
    for (const endpoint of [undefined, 'fed', 'us']) {
      const token = encode({ a: accountIdentifier, t: tunnelId, s: secret.toString('base64'), ...(endpoint ? { e: endpoint } : {}) });
      const parsed = parseCloudflareTunnelToken(token);
      expect(parsed).toMatchObject({ accountIdentifier, tunnelId, endpoint: endpoint ?? null });
      expect(parsed.secretFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(parsed)).not.toContain(secret.toString('base64'));
      parsed.secretMaterial.fill(0);
    }
  });

  it.each([
    ['whitespace', `${encode({ a: accountIdentifier, t: tunnelId, s: secret.toString('base64') })}\n`],
    ['URL-safe base64', `_${encode({ a: accountIdentifier, t: tunnelId, s: secret.toString('base64') }).slice(1)}`],
    ['unexpected field', encode({ a: accountIdentifier, t: tunnelId, s: secret.toString('base64'), admin: true })],
    ['unknown endpoint', encode({ a: accountIdentifier, t: tunnelId, s: secret.toString('base64'), e: 'https://evil.example' })],
    ['noncanonical UUID', encode({ a: accountIdentifier, t: tunnelId.toUpperCase(), s: secret.toString('base64') })],
    ['malformed secret', encode({ a: accountIdentifier, t: tunnelId, s: 'not-base64!' })],
    ['duplicate key', encode(`{"a":"${accountIdentifier}","a":"${accountIdentifier}","t":"${tunnelId}","s":"${secret.toString('base64')}"}`)],
    ['escaped key', encode(`{"\\u0061":"${accountIdentifier}","t":"${tunnelId}","s":"${secret.toString('base64')}"}`)],
  ])('rejects %s without including token material in the error', (_case, token) => {
    let error: unknown;
    try {
      parseCloudflareTunnelToken(token);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CloudflareTunnelTokenError);
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(secret.toString('base64'));
  });
});
