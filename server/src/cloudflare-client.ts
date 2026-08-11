const BASE_URL = 'https://api.cloudflare.com/client/v4';
const FED_BASE_URL = 'https://api.fed.cloudflare.com/client/v4';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ZONE_PAGES = 10;
const MAX_DNS_PAGES = 10;

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

export interface CloudflareDnsRecord {
  id: string;
  type: 'A' | 'AAAA' | 'CNAME';
  name: string;
  content: string;
  proxied: boolean;
  comment: string | null;
}

export interface CloudflareTunnelMetadata {
  id: string;
  accountIdentifier: string;
  deleted: boolean;
}

export class CloudflareClientError extends Error {
  public constructor(message: string, public readonly status: number, public readonly code?: number) {
    super(message.slice(0, 500));
  }

  public isExplicitNotFound(): boolean {
    return this.status === 404 && this.code === 81044;
  }
}

interface CloudflareEnvelope {
  success?: boolean;
  result?: unknown;
  errors?: Array<{ code?: unknown }>;
  result_info?: { page?: unknown; total_pages?: unknown };
}

export class CloudflareClient {
  public constructor(private readonly apiToken: string, private readonly fetch: typeof globalThis.fetch, private readonly endpoint: 'standard' | 'fed' = 'standard') {}

  public async verifyToken(): Promise<void> {
    await this.request('GET', '/user/tokens/verify');
  }

  public async listZones(accountIdentifier: string): Promise<CloudflareZoneResult[]> {
    const zones: CloudflareZoneResult[] = [];
    const identifiers = new Set<string>();
    let expectedTotalPages: number | null = null;
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
        const identifier = zone.id.toLowerCase();
        if (identifiers.has(identifier)) throw new CloudflareClientError('Cloudflare returned duplicate zone identifiers.', 502);
        identifiers.add(identifier);
        zones.push({ id: identifier, name: zone.name, status: zone.status });
      }
      const reportedPage = envelope.result_info?.page;
      if (reportedPage !== undefined && (!Number.isInteger(Number(reportedPage)) || Number(reportedPage) !== page)) {
        throw new CloudflareClientError('Cloudflare returned invalid zone pagination metadata.', 502);
      }
      const totalPages = Number(envelope.result_info?.total_pages ?? page);
      if (!Number.isInteger(totalPages) || totalPages < page || (expectedTotalPages !== null && totalPages !== expectedTotalPages)) {
        throw new CloudflareClientError('Cloudflare returned invalid zone pagination metadata.', 502);
      }
      expectedTotalPages ??= totalPages;
      if (totalPages === page) return zones;
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

  public async getTunnelMetadata(accountIdentifier: string, tunnelId: string): Promise<CloudflareTunnelMetadata> {
    const envelope = await this.request('GET', this.tunnelPath(accountIdentifier, tunnelId));
    if (!envelope.result || typeof envelope.result !== 'object') throw new CloudflareClientError('Cloudflare returned invalid tunnel metadata.', 502);
    const result = envelope.result as Record<string, unknown>;
    if (typeof result.id !== 'string' || result.id.toLowerCase() !== tunnelId.toLowerCase()
      || typeof result.account_tag !== 'string' || !/^[a-f0-9]{32}$/i.test(result.account_tag)
      || (result.deleted_at !== null && result.deleted_at !== undefined && typeof result.deleted_at !== 'string')) {
      throw new CloudflareClientError('Cloudflare returned invalid tunnel metadata.', 502);
    }
    return { id: result.id.toLowerCase(), accountIdentifier: result.account_tag.toLowerCase(), deleted: result.deleted_at !== null && result.deleted_at !== undefined };
  }

  public async getTunnelToken(accountIdentifier: string, tunnelId: string): Promise<string> {
    const envelope = await this.request('GET', `${this.tunnelPath(accountIdentifier, tunnelId)}/token`);
    if (typeof envelope.result !== 'string' || envelope.result.length < 48 || envelope.result.length > 4096 || /\s/.test(envelope.result)) {
      throw new CloudflareClientError('Cloudflare returned an invalid tunnel token.', 502);
    }
    return envelope.result;
  }

  public async putTunnelConfig(accountIdentifier: string, tunnelId: string, ingress: CloudflareIngressRule[]): Promise<void> {
    await this.request('PUT', this.tunnelConfigPath(accountIdentifier, tunnelId), { config: { ingress } });
  }

  public async createDnsCname(zoneIdentifier: string, hostname: string, tunnelId: string, proxied: boolean, comment: string): Promise<CloudflareDnsRecord> {
    return this.createDnsRecord(zoneIdentifier, 'CNAME', hostname, `${tunnelId}.cfargotunnel.com`, proxied, comment);
  }

  public async listDnsRecordsExact(zoneIdentifier: string, hostname: string): Promise<CloudflareDnsRecord[]> {
    const records: CloudflareDnsRecord[] = [];
    for (let page = 1; page <= MAX_DNS_PAGES; page += 1) {
      const query = new URLSearchParams({ name: hostname, per_page: '100', page: String(page) });
      const envelope = await this.request('GET', `/zones/${encodeURIComponent(zoneIdentifier)}/dns_records?${query.toString()}`);
      if (!Array.isArray(envelope.result)) throw new CloudflareClientError('Cloudflare returned an invalid DNS records response.', 502);
      records.push(...envelope.result.flatMap((value) => {
        if (!value || typeof value !== 'object' || !['A', 'AAAA', 'CNAME'].includes(String((value as Record<string, unknown>).type))) return [];
        return [this.dnsRecord(value, hostname)];
      }));
      const totalPages = Number(envelope.result_info?.total_pages ?? page);
      if (!Number.isInteger(totalPages) || totalPages < page) throw new CloudflareClientError('Cloudflare returned invalid DNS pagination metadata.', 502);
      if (totalPages === page) return records;
    }
    throw new CloudflareClientError(`Cloudflare DNS pagination exceeded the ${MAX_DNS_PAGES}-page safety limit.`, 502);
  }

  public async createDnsAddress(zoneIdentifier: string, type: 'A' | 'AAAA', hostname: string, content: string, proxied: boolean, comment: string): Promise<CloudflareDnsRecord> {
    return this.createDnsRecord(zoneIdentifier, type, hostname, content, proxied, comment);
  }

  public async getDnsRecord(zoneIdentifier: string, dnsRecordId: string, expectedHostname: string): Promise<CloudflareDnsRecord> {
    const envelope = await this.request('GET', `/zones/${encodeURIComponent(zoneIdentifier)}/dns_records/${encodeURIComponent(dnsRecordId)}`);
    return this.dnsRecord(envelope.result, expectedHostname);
  }

  public async deleteDnsRecord(zoneIdentifier: string, dnsRecordId: string): Promise<void> {
    await this.request('DELETE', `/zones/${encodeURIComponent(zoneIdentifier)}/dns_records/${encodeURIComponent(dnsRecordId)}`);
  }

  private tunnelConfigPath(accountIdentifier: string, tunnelId: string): string {
    return `${this.tunnelPath(accountIdentifier, tunnelId)}/configurations`;
  }

  private tunnelPath(accountIdentifier: string, tunnelId: string): string {
    return `/accounts/${encodeURIComponent(accountIdentifier)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`;
  }

  private async createDnsRecord(zoneIdentifier: string, type: CloudflareDnsRecord['type'], hostname: string, content: string, proxied: boolean, comment: string): Promise<CloudflareDnsRecord> {
    const envelope = await this.request('POST', `/zones/${encodeURIComponent(zoneIdentifier)}/dns_records`, {
      type, name: hostname, content, proxied, ttl: 1, comment,
    });
    return this.dnsRecord(envelope.result, hostname);
  }

  private dnsRecord(value: unknown, expectedHostname: string): CloudflareDnsRecord {
    if (!value || typeof value !== 'object') throw new CloudflareClientError('Cloudflare returned an invalid DNS record.', 502);
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !['A', 'AAAA', 'CNAME'].includes(String(record.type)) || typeof record.name !== 'string' || record.name.toLowerCase() !== expectedHostname.toLowerCase() || typeof record.content !== 'string' || typeof record.proxied !== 'boolean') {
      throw new CloudflareClientError('Cloudflare returned an invalid DNS record.', 502);
    }
    if (record.comment !== undefined && record.comment !== null && typeof record.comment !== 'string') throw new CloudflareClientError('Cloudflare returned an invalid DNS record comment.', 502);
    return { id: record.id, type: record.type as CloudflareDnsRecord['type'], name: record.name.toLowerCase(), content: record.content, proxied: record.proxied, comment: typeof record.comment === 'string' ? record.comment : null };
  }

  private isHostname(value: string): boolean {
    if (value.length < 1 || value.length > 253 || value.includes('..')) return false;
    return value.split('.').every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  }

  private async request(method: string, path: string, body?: unknown): Promise<CloudflareEnvelope> {
    let response: Response;
    try {
      response = await this.fetch(`${this.endpoint === 'fed' ? FED_BASE_URL : BASE_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new CloudflareClientError('Cloudflare could not be reached.', 0);
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
