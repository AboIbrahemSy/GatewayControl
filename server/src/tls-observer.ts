import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { TlsObservation } from './types.js';

const EXPIRING_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

export type TlsObserver = (hostname: string) => Promise<TlsObservation>;

export function classifyTlsFailure(error: NodeJS.ErrnoException): string {
  if (error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'certificate_hostname_invalid';
  if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED'].includes(error.code ?? '')) return 'certificate_untrusted';
  if (error.code === 'CERT_HAS_EXPIRED') return 'certificate_expired';
  if (error.code === 'ETIMEDOUT') return 'tls_timeout';
  return 'tls_connection_failed';
}

export const observeTlsCertificate: TlsObserver = async (hostname) => new Promise((resolve) => {
  let settled = false;
  const finish = (observation: TlsObservation): void => {
    if (settled) return;
    settled = true;
    request.destroy();
    resolve(observation);
  };
  const request = https.request({ hostname, port: 443, servername: hostname, method: 'GET', path: '/', rejectUnauthorized: true, timeout: 5_000, agent: false, headers: { 'user-agent': 'GatewayControl-HTTPS-Observer/1.0', connection: 'close' } }, (response) => {
    response.resume();
    if ((response.statusCode ?? 500) >= 500) return finish({ status: 'error', error: 'https_upstream_unavailable' });
    const socket = response.socket as TLSSocket;
    const certificate = socket.getPeerCertificate();
    const validToTime = Date.parse(certificate.valid_to ?? '');
    if (!certificate.raw || !Number.isFinite(validToTime)) return finish({ status: 'error', error: 'certificate_unavailable' });
    const validTo = new Date(validToTime).toISOString();
    const remaining = validToTime - Date.now();
    const status = remaining <= 0 ? 'expired' : remaining <= EXPIRING_WITHIN_MS ? 'expiring' : 'valid';
    const issuer = [certificate.issuer?.O, certificate.issuer?.CN].filter(Boolean).join(' / ').slice(0, 255) || 'Unknown issuer';
    finish({ status, issuer, validTo });
  });
  request.once('timeout', () => finish({ status: 'error', error: 'tls_timeout' }));
  request.once('error', (error: NodeJS.ErrnoException) => finish({ status: error.code === 'CERT_HAS_EXPIRED' ? 'expired' : 'error', error: classifyTlsFailure(error) }));
  request.end();
});
