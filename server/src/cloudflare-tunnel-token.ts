import { createHash } from 'node:crypto';

const ACCOUNT_TAG_PATTERN = /^[a-f0-9]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MIN_TOKEN_BYTES = 48;
const MAX_TOKEN_BYTES = 4096;
const MIN_SECRET_BYTES = 16;
const MAX_SECRET_BYTES = 1024;

export class CloudflareTunnelTokenError extends Error {
  public constructor() {
    super('The Cloudflare tunnel connector token is invalid.');
  }
}

export interface CloudflareTunnelTokenIdentity {
  accountIdentifier: string;
  tunnelId: string;
  secretFingerprint: string;
  endpoint: 'fed' | 'us' | null;
}

export interface ParsedCloudflareTunnelToken extends CloudflareTunnelTokenIdentity {
  secretMaterial: Buffer;
}

function decodeCanonicalBase64(value: string, minBytes: number, maxBytes: number): Buffer {
  if (value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 || !BASE64_PATTERN.test(value)) {
    throw new CloudflareTunnelTokenError();
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < minBytes || decoded.length > maxBytes || decoded.toString('base64') !== value) {
    decoded.fill(0);
    throw new CloudflareTunnelTokenError();
  }
  return decoded;
}

export function parseCloudflareTunnelToken(token: string): ParsedCloudflareTunnelToken {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_BYTES || token.length > MAX_TOKEN_BYTES || /\s/.test(token)) {
    throw new CloudflareTunnelTokenError();
  }

  let decoded: Buffer | null = null;
  try {
    decoded = decodeCanonicalBase64(token, 2, 3072);
    const json = decoded.toString('utf8');
    if (!Buffer.from(json, 'utf8').equals(decoded)) throw new CloudflareTunnelTokenError();
    const serializedKeys = [...json.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)].map((match) => match[0].slice(0, match[0].lastIndexOf(':')).trim());
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CloudflareTunnelTokenError();
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (serializedKeys.length !== keys.length || serializedKeys.some((key) => !['"a"', '"e"', '"s"', '"t"'].includes(key))) throw new CloudflareTunnelTokenError();
    if (keys.join(',') !== 'a,s,t' && keys.join(',') !== 'a,e,s,t') throw new CloudflareTunnelTokenError();
    if (typeof record.a !== 'string' || !ACCOUNT_TAG_PATTERN.test(record.a)
      || typeof record.t !== 'string' || !UUID_PATTERN.test(record.t)
      || typeof record.s !== 'string'
      || (record.e !== undefined && record.e !== 'fed' && record.e !== 'us')) {
      throw new CloudflareTunnelTokenError();
    }
    const secretMaterial = decodeCanonicalBase64(record.s, MIN_SECRET_BYTES, MAX_SECRET_BYTES);
    const parsed = {
      accountIdentifier: record.a,
      tunnelId: record.t.toLowerCase(),
      secretFingerprint: createHash('sha256').update(secretMaterial).digest('hex'),
      endpoint: record.e === 'fed' || record.e === 'us' ? record.e : null,
    } as ParsedCloudflareTunnelToken;
    Object.defineProperty(parsed, 'secretMaterial', { value: secretMaterial, enumerable: false, writable: false });
    return parsed;
  } catch (error) {
    if (error instanceof CloudflareTunnelTokenError) throw error;
    throw new CloudflareTunnelTokenError();
  } finally {
    decoded?.fill(0);
  }
}

export function publicTunnelTokenIdentity(parsed: ParsedCloudflareTunnelToken): CloudflareTunnelTokenIdentity {
  return {
    accountIdentifier: parsed.accountIdentifier,
    tunnelId: parsed.tunnelId,
    secretFingerprint: parsed.secretFingerprint,
    endpoint: parsed.endpoint,
  };
}
