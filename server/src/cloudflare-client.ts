const BASE_URL = 'https://api.cloudflare.com/client/v4';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ZONE_PAGES = 10;

export interface CloudflareZoneResult {
  id: string;
  name: string;
  status: string;
}

export interface CloudflareIngressRule {
  hostname?: string;
  service: string;
  [key: string]: unknown;
}

export class CloudflareClientError extends Error {
  public constructor(message: string, public readonly status: number, public readonly code?: number) {
    super(message.slice(0, 500));
  }

  public isExplicitNotFound(): boolean {
    return this.status === 404 && this.code !== undefined;
  }
}

interface CloudflareEnvelope {
  success?: boolean;
  result?: unknown;
  errors?: Array<{ code?: unknown }>;
  result_info?: { page?: unknown; total_pages?: unknown };
}

export class CloudflareClient {
  public constructor(private readonly apiToken: string, private readonly fetch: typeof globalThis.fetch) {}

  public async verifyToken(): Promise<void> {
    await this.request('GET', '/user/tokens/verify');
  }

  public async listZones(accountIdentifier: string): Promise<CloudflareZoneResult[]> {
    const zones: CloudflareZoneResult[] = [];
    for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
      const query = new URLSearchParams({ 'account.id': accountIdentifier, per_page: '50', page: String(page) });
      const envelope = await this.request('GET', `/zones?${query.toString()}`);
      if (!Array.isArray(envelope.result)) throw new CloudflareClientError('Cloudflare returned an invalid zones response.', 502);
      for (const item of envelope.result) {
        if (!item || typeof item !== 'object') throw new CloudflareClientError('Cloudflare returned an invalid zone.', 502);
        const zone = item as Record<string, unknown>;
        if (typeof zone.id !== 'string' || !/^[a-f0-9]{32}$/i.test(zone.id) || typeof zone.name !== 'string' || !this.isHostname(zone.name) || typeof zone.status !== 'string' || zone.status.length < 1 || zone.status.length > 64) {
          throw new CloudflareClientError('Cloudflare returned an invalid zone.', 502);
        }
        zones.push({ id: zone.id, name: zone.name, status: zone.status });
      }
      const totalPages = Number(envelope.result_info?.total_pages ?? page);
      if (!Number.isInteger(totalPages) || totalPages <= page) return zones;
    }
    throw new CloudflareClientError(`Cloudflare zone pagination exceeded the ${MAX_ZONE_PAGES}-page safety limit.`, 502);
  }

  public async getTunnelConfig(accountIdentifier: string, tunnelId: string): Promise<CloudflareIngressRule[]> {
    const envelope = await this.request('GET', this.tunnelConfigPath(accountIdentifier, tunnelId));
    const result = envelope.result as { config?: { ingress?: unknown } } | undefined;
    if (!Array.isArray(result?.config?.ingress)) throw new CloudflareClientError('Cloudflare returned an invalid tunnel configuration.', 502);
    return result.config.ingress.map((rule) => {
      if (!rule || typeof rule !== 'object' || typeof (rule as Record<string, unknown>).service !== 'string') {
        throw new CloudflareClientError('Cloudflare returned an invalid tunnel ingress rule.', 502);
      }
      return { ...(rule as CloudflareIngressRule) };
    });
  }

  public async putTunnelConfig(accountIdentifier: string, tunnelId: string, ingress: CloudflareIngressRule[]): Promise<void> {
    await this.request('PUT', this.tunnelConfigPath(accountIdentifier, tunnelId), { config: { ingress } });
  }

  public async createDnsCname(zoneIdentifier: string, hostname: string, tunnelId: string, proxied: boolean): Promise<string> {
    const envelope = await this.request('POST', `/zones/${encodeURIComponent(zoneIdentifier)}/dns_records`, {
      type: 'CNAME', name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied, ttl: 1,
    });
    const result = envelope.result as { id?: unknown } | undefined;
    if (typeof result?.id !== 'string') throw new CloudflareClientError('Cloudflare returned an invalid DNS record.', 502);
    return result.id;
  }

  public async deleteDnsRecord(zoneIdentifier: string, dnsRecordId: string): Promise<void> {
    await this.request('DELETE', `/zones/${encodeURIComponent(zoneIdentifier)}/dns_records/${encodeURIComponent(dnsRecordId)}`);
  }

  private tunnelConfigPath(accountIdentifier: string, tunnelId: string): string {
    return `/accounts/${encodeURIComponent(accountIdentifier)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`;
  }

  private isHostname(value: string): boolean {
    if (value.length < 1 || value.length > 253 || value.includes('..')) return false;
    return value.split('.').every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  }

  private async request(method: string, path: string, body?: unknown): Promise<CloudflareEnvelope> {
    let response: Response;
    try {
      response = await this.fetch(`${BASE_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new CloudflareClientError('Cloudflare could not be reached.', 502);
    }
    const envelope = await this.readEnvelope(response);
    if (response.ok && envelope.success === true) return envelope;
    const code = Array.isArray(envelope.errors) && typeof envelope.errors[0]?.code === 'number' ? envelope.errors[0].code : undefined;
    throw new CloudflareClientError(`Cloudflare request failed (HTTP ${response.status}${code === undefined ? '' : `, code ${code}`}).`, response.status, code);
  }

  private async readEnvelope(response: Response): Promise<CloudflareEnvelope> {
    const reader = response.body?.getReader();
    if (!reader) throw new CloudflareClientError('Cloudflare returned an empty response.', 502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CloudflareClientError('Cloudflare returned an oversized response.', 502);
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as CloudflareEnvelope;
    } catch {
      throw new CloudflareClientError('Cloudflare returned invalid JSON.', 502);
    }
  }
}
