import { describe, expect, it } from 'vitest';
import { classifyTlsFailure } from '../src/tls-observer.js';

describe('TLS observer trust classification', () => {
  it.each([
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'certificate_hostname_invalid'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate_untrusted'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'certificate_untrusted'],
    ['CERT_HAS_EXPIRED', 'certificate_expired'],
  ])('classifies %s without exposing certificate details', (code, expected) => {
    expect(classifyTlsFailure(Object.assign(new Error('sensitive certificate detail'), { code }))).toBe(expected);
  });
});
