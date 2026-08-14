import { randomUUID } from 'node:crypto';
import { OPERATIONAL_EVENT_TYPES, type Agent, type AgentCommand, type BackupTarget, type CloudflareAccount, type CloudflareAccountDeletionDependencies, type CloudflareAccountSecret, type CloudflareDomainAccess, type CloudflareDomainAccessDeployment, type CloudflareZone, type Connector, type ConnectorDeployment, type ConnectorIdentityDeployment, type ConnectorIdentityExpectation, type Deployment, type DeploymentCommandSource, type DeploymentRevision, type DeploymentRun, type DomainAccessDnsRecord, type GuidedOperation, type ManagedRoute, type ManagedStack, type NotificationAgentPreference, type NotificationDelivery, type NotificationServicePreference, type NotificationSettings, type NotificationTopology, type OperationalEventType, type Role, type RuntimeAction, type RuntimeInventory, type RuntimeLogRequest, type RuntimeOperation, type RuntimeScope, type StackBackup, type StackDeployment, type StackRestore, type Store, type StoredSystemBackup, type SystemBackup, type SystemBackupImport, type SystemRestore, type TelemetrySnapshot, type TlsObservation, type TlsObservationTarget, type User } from '../src/types.js';

export class FakeStore implements Store {
  public users: User[] = [];
  public sessions = new Map<string, string>();
  public connectors: Array<Connector & { encryptedToken: string }> = [];
  public cloudflareAccounts: Array<CloudflareAccount & { encryptedApiToken: string }> = [];
  public cloudflareZones: CloudflareZone[] = [];
  public cloudflareDomainAccess: CloudflareDomainAccess[] = [];
  public cloudflarePublicHostnames = this.cloudflareDomainAccess;
  public stacks: Array<ManagedStack & { encryptedComposeYaml: string }> = [];
  public routes: ManagedRoute[] = [];
  public agents: Array<Agent & { enrollmentTokenHash?: string; credentialHash?: string; archivedAt?: string }> = [];
  public commands: Array<AgentCommand & { createdAt?: string }> = [];
  public notificationSecrets: { botTokenEncrypted: string; groupIdEncrypted: string } | null = null;
  public selectedEvents: string[] = [...OPERATIONAL_EVENT_TYPES];
  public notificationScopes: Array<{ agentId: string; projectName: string | null; serviceName: string | null; enabled: boolean; updatedByUserId: string }> = [];
  public telemetry: TelemetrySnapshot[] = [];
  public backups: StackBackup[] = [];
  public restores: StackRestore[] = [];
  public systemBackups: StoredSystemBackup[] = [];
  public systemRestores: SystemRestore[] = [];
  public systemBackupImports: SystemBackupImport[] = [];
  public systemBackupTransferEvents: Array<Record<string, unknown>> = [];
  public systemRecoveryRequests: Array<{ id: string; ownershipToken: string; status: 'publishing' | 'published' | 'failed'; error: string | null }> = [];
  public events: Array<{ id: string; type: OperationalEventType; agentId: string | null; projectName: string | null; serviceName: string | null; payload: Record<string, unknown>; occurredAt: string }> = [];
  public deliveries: Array<NotificationDelivery & { status: 'pending' | 'dispatching' | 'succeeded' | 'failed' | 'skipped'; error?: string }> = [];
  public runtimeOperations: RuntimeOperation[] = [];
  public runtimeLogRequests: RuntimeLogRequest[] = [];
  public guidedOperations: GuidedOperation[] = [];
  public deployments: Deployment[] = [];
  public deploymentRevisions: Array<DeploymentRevision & { encryptedSourceCompose: string; encryptedNormalizedCompose: string }> = [];
  public deploymentRuns: DeploymentRun[] = [];
  private readonly mutexTails = new Map<string, Promise<void>>();
  private readonly offlineNotifications = new Set<string>();

  public async checkReady(): Promise<void> {}
  public async isSetupComplete(): Promise<boolean> { return this.users.some((item) => item.role === 'owner'); }
  public async createOwner(email: string, passwordHash: string): Promise<User | null> {
    if (await this.isSetupComplete()) return null;
    const created: User = { id: randomUUID(), email, passwordHash, role: 'owner' };
    this.users.push(created);
    return created;
  }
  public async listUsers(): Promise<Omit<User, 'passwordHash'>[]> { return this.users.map(({ passwordHash: _, ...item }) => item); }
  public async createUser(email: string, passwordHash: string, role: Exclude<Role, 'owner'>): Promise<User> {
    const created: User = { id: randomUUID(), email, passwordHash, role };
    this.users.push(created);
    return created;
  }
  public async findUserByEmail(email: string): Promise<User | null> { return this.users.find((item) => item.email === email) ?? null; }
  public async createSession(userId: string, tokenHash: string): Promise<void> { this.sessions.set(tokenHash, userId); }
  public async findSessionUser(tokenHash: string): Promise<User | null> {
    const id = this.sessions.get(tokenHash);
    return this.users.find((item) => item.id === id) ?? null;
  }
  public async deleteSession(tokenHash: string): Promise<void> { this.sessions.delete(tokenHash); }
  public async listConnectors(): Promise<Connector[]> { return this.connectors.map(({ encryptedToken: _, ...item }) => item); }
  public async createConnector(values: { name: string; encryptedToken: string; enabled: boolean; agentId: string; accountId?: string; accountIdentifier: string; tunnelId: string; identityStatus: Connector['identityStatus']; identityError?: string }): Promise<Connector | null> {
    if (!this.agents.some((agent) => agent.id === values.agentId && agent.enabled && agent.enrolledAt)) return null;
    if (values.accountId && !this.cloudflareAccounts.some((account) => account.id === values.accountId && account.enabled && account.accountIdentifier === values.accountIdentifier)) return null;
    const now = new Date().toISOString();
    const created = {
      id: randomUUID(), agentId: values.agentId, name: values.name, enabled: values.enabled,
      cloudflareAccountId: values.accountId ?? null, tunnelId: values.accountId ? values.tunnelId : null, desiredRevision: 1,
      tokenAccountIdentifier: values.accountIdentifier, tokenTunnelId: values.tunnelId,
      identityStatus: values.identityStatus, identityVerifiedAt: values.identityStatus === 'verified' ? now : null, identityError: values.identityError ?? null,
      deploymentStatus: 'pending' as const, runtimeStatus: 'unknown' as const, lastError: null, lastDeployedAt: null,
      lastObservedAt: null, encryptedToken: values.encryptedToken, createdAt: now, updatedAt: now,
    };
    this.connectors.push(created);
    if (values.enabled) this.queueConnectorSync(created.agentId, created.id, created.desiredRevision);
    const { encryptedToken: _, ...publicConnector } = created;
    return publicConnector;
  }
  public async updateConnector(id: string, values: { name?: string; encryptedToken?: string; enabled?: boolean; agentId?: string; accountId?: string; accountIdentifier?: string; tunnelId?: string }): Promise<Connector | null> {
    const item = this.connectors.find((connector) => connector.id === id);
    if (!item) return null;
    const targetAgentId = values.agentId ?? item.agentId;
    if (!this.agents.some((agent) => agent.id === targetAgentId && agent.enabled && agent.enrolledAt)) return null;
    if (values.accountId && !this.cloudflareAccounts.some((account) => account.id === values.accountId && account.enabled && account.accountIdentifier === values.accountIdentifier)) return null;
    if (values.enabled === true && !values.encryptedToken
      && (!['verified', 'parsed', 'unmatched', 'mismatch', 'failed'].includes(item.identityStatus) || !item.tokenAccountIdentifier || !item.tokenTunnelId)) return null;
    const oldAgentId = item.agentId;
    const nextRevision = item.desiredRevision + 1;
    Object.assign(item, values, {
      ...(values.accountId ? { cloudflareAccountId: values.accountId, tokenAccountIdentifier: values.accountIdentifier!, tokenTunnelId: values.tunnelId!, tunnelId: values.tunnelId!, identityStatus: 'verified' as const, identityVerifiedAt: new Date().toISOString(), identityError: null } : {}),
      desiredRevision: nextRevision, deploymentStatus: (values.enabled ?? item.enabled) ? 'pending' : 'stopping',
      runtimeStatus: (values.enabled ?? item.enabled) ? 'unknown' : item.runtimeStatus, lastError: null, updatedAt: new Date().toISOString(),
    });
    if (values.agentId && values.agentId !== oldAgentId) this.commands.push({ id: randomUUID(), agentId: oldAgentId, type: 'cloudflare.connector.remove', payload: { connectorId: item.id, revision: nextRevision }, status: 'pending', createdAt: new Date().toISOString() });
    this.queueConnectorSync(item.agentId, item.id, nextRevision);
    const { encryptedToken: _, ...publicConnector } = item;
    return publicConnector;
  }
  public async getConnectorDeployment(connectorId: string): Promise<ConnectorDeployment | null> {
    const item = this.connectors.find((connector) => connector.id === connectorId);
    return item ? { connectorId: item.id, agentId: item.agentId, name: item.name, enabled: item.enabled, desiredRevision: item.desiredRevision, encryptedToken: item.encryptedToken, cloudflareAccountId: item.cloudflareAccountId, tunnelId: item.tunnelId, tokenAccountIdentifier: item.tokenAccountIdentifier, tokenTunnelId: item.tokenTunnelId, identityStatus: item.identityStatus } : null;
  }
  public async listCloudflareAccounts(): Promise<CloudflareAccount[]> { return this.cloudflareAccounts.map(({ encryptedApiToken: _, ...item }) => item); }
  public async createCloudflareAccount(values: { name: string; accountIdentifier: string; encryptedApiToken: string; enabled: boolean }): Promise<CloudflareAccount> {
    const now = new Date().toISOString();
    const created = { id: randomUUID(), ...values, configured: true as const, lastSyncedAt: null, lastErrorAt: null, lastError: null, createdAt: now, updatedAt: now };
    this.cloudflareAccounts.push(created);
    const { encryptedApiToken: _, ...account } = created;
    return account;
  }
  public async updateCloudflareAccount(id: string, values: { name?: string; accountIdentifier?: string; encryptedApiToken?: string; enabled?: boolean }): Promise<CloudflareAccount | null> {
    const item = this.cloudflareAccounts.find((account) => account.id === id);
    if (!item) return null;
    Object.assign(item, values, { updatedAt: new Date().toISOString() });
    const { encryptedApiToken: _, ...account } = item;
    return account;
  }
  public async deleteCloudflareAccount(id: string): Promise<{ deleted: true; dependencies: CloudflareAccountDeletionDependencies } | { deleted: false; dependencies: CloudflareAccountDeletionDependencies } | null> {
    const index = this.cloudflareAccounts.findIndex((account) => account.id === id);
    if (index === -1) return null;
    const dependencies = {
      connectors: this.connectors.filter((item) => item.cloudflareAccountId === id).length,
      domainAccess: this.cloudflareDomainAccess.filter((item) => item.cloudflareAccountId === id).length,
      guidedOperations: this.guidedOperations.filter((item) => item.cloudflareAccountId === id).length,
    };
    if (dependencies.connectors + dependencies.domainAccess + dependencies.guidedOperations > 0) return { deleted: false, dependencies };
    this.cloudflareAccounts.splice(index, 1);
    this.cloudflareZones = this.cloudflareZones.filter((zone) => zone.cloudflareAccountId !== id);
    return { deleted: true, dependencies };
  }
  public async getCloudflareAccountSecret(id: string): Promise<CloudflareAccountSecret | null> {
    return this.cloudflareAccounts.find((account) => account.id === id) ?? null;
  }
  public async getCloudflareAccountSecretByIdentifier(accountIdentifier: string): Promise<CloudflareAccountSecret | null> {
    return this.cloudflareAccounts.find((account) => account.enabled && account.accountIdentifier === accountIdentifier) ?? null;
  }
  public async listConnectorIdentityDeployments(limit: number): Promise<ConnectorIdentityDeployment[]> {
    return this.connectors.filter((item) => ['pending', 'parsed', 'failed'].includes(item.identityStatus)
      || item.identityStatus === 'unmatched' && Date.parse(item.updatedAt) < Date.now() - 3_600_000).slice(0, Math.max(1, Math.min(limit, 50))).map((item) => ({
      connectorId: item.id, agentId: item.agentId, name: item.name, enabled: item.enabled, desiredRevision: item.desiredRevision,
      encryptedToken: item.encryptedToken, cloudflareAccountId: item.cloudflareAccountId, tunnelId: item.tunnelId,
      tokenAccountIdentifier: item.tokenAccountIdentifier, tokenTunnelId: item.tokenTunnelId, identityStatus: item.identityStatus,
    }));
  }
  public async markConnectorIdentity(id: string, expected: ConnectorIdentityExpectation, values: { status: Connector['identityStatus']; accountId?: string; accountIdentifier?: string; tunnelId?: string; error?: string }): Promise<Connector | null> {
    const item = this.connectors.find((connector) => connector.id === id && connector.desiredRevision === expected.desiredRevision && connector.encryptedToken === expected.encryptedToken);
    if (!item) return null;
    const topologyMatches = (item.cloudflareAccountId === null || item.cloudflareAccountId === values.accountId)
      && (item.tunnelId === null || item.tunnelId.toLowerCase() === values.tunnelId?.toLowerCase());
    const verified = values.status === 'verified' && topologyMatches;
    const mismatch = values.status === 'verified' && !topologyMatches;
    Object.assign(item, {
      identityStatus: mismatch ? 'mismatch' : values.status, identityVerifiedAt: verified ? new Date().toISOString() : null,
      identityError: mismatch ? 'connector_identity_mismatch' : verified ? null : values.error ?? null,
      cloudflareAccountId: verified ? item.cloudflareAccountId ?? values.accountId ?? null : item.cloudflareAccountId,
      tunnelId: verified ? item.tunnelId ?? values.tunnelId ?? null : item.tunnelId,
      tokenAccountIdentifier: values.accountIdentifier ?? null,
      tokenTunnelId: values.tunnelId ?? null,
      updatedAt: new Date().toISOString(),
    });
    const { encryptedToken: _, ...publicConnector } = item;
    return publicConnector;
  }
  public async syncCloudflareZones(accountId: string, zones: Array<{ zoneIdentifier: string; name: string; status: string }>, error?: string): Promise<CloudflareZone[] | null> {
    const account = this.cloudflareAccounts.find((item) => item.id === accountId);
    if (!account) return null;
    const now = new Date().toISOString();
    Object.assign(account, error ? { lastError: error, lastErrorAt: now } : { lastSyncedAt: now, lastError: null, lastErrorAt: null }, { updatedAt: now });
    if (!error) {
      const identifiers = new Set(zones.map((zone) => zone.zoneIdentifier));
      for (const zone of this.cloudflareZones.filter((item) => item.cloudflareAccountId === accountId && !identifiers.has(item.zoneIdentifier))) {
        Object.assign(zone, { status: 'unavailable', updatedAt: now });
      }
    }
    if (!error) for (const zone of zones) {
      const existing = this.cloudflareZones.find((item) => item.zoneIdentifier === zone.zoneIdentifier);
      if (existing && existing.cloudflareAccountId === accountId) Object.assign(existing, zone, { updatedAt: now });
      else if (!existing) this.cloudflareZones.push({ id: randomUUID(), cloudflareAccountId: accountId, ...zone, createdAt: now, updatedAt: now });
    }
    return this.cloudflareZones.filter((zone) => zone.cloudflareAccountId === accountId);
  }
  public async listCloudflareZones(accountId: string): Promise<CloudflareZone[] | null> {
    return this.cloudflareAccounts.some((account) => account.id === accountId) ? this.cloudflareZones.filter((zone) => zone.cloudflareAccountId === accountId) : null;
  }
  public async listCloudflareDomainAccess(): Promise<CloudflareDomainAccess[]> { return this.cloudflareDomainAccess; }
  public async createOrGetGuidedOperation(values: { kind: GuidedOperation['kind']; idempotencyKey: string; requestedByUserId: string; requestHash: string; encryptedRequest: string }): Promise<{ operation: GuidedOperation; created: boolean }> {
    const existing = this.guidedOperations.find((item) => item.kind === values.kind && item.idempotencyKey === values.idempotencyKey && item.requestedByUserId === values.requestedByUserId);
    if (existing) return { operation: existing, created: false };
    const now = new Date().toISOString();
    const operation: GuidedOperation = { id: randomUUID(), ...values, status: 'pending', stage: 'created', cloudflareAccountId: null, connectorId: null, routeId: null, domainAccessId: null, remoteTunnelId: null, remoteTunnelName: null, result: null, error: null, verificationDeadlineAt: null, verificationAttempts: 0, createdAt: now, updatedAt: now, completedAt: null };
    this.guidedOperations.push(operation);
    return { operation, created: true };
  }
  public async updateGuidedOperation(id: string, values: { status?: GuidedOperation['status']; stage?: string; accountId?: string; connectorId?: string; routeId?: string; domainAccessId?: string; remoteTunnelId?: string; remoteTunnelName?: string; result?: Record<string, unknown>; error?: string | null; clearEncryptedRequest?: boolean; verificationDeadlineAt?: string; incrementVerificationAttempts?: boolean }): Promise<GuidedOperation | null> {
    const operation = this.guidedOperations.find((item) => item.id === id); if (!operation) return null;
    Object.assign(operation, values, { cloudflareAccountId: values.accountId ?? operation.cloudflareAccountId, connectorId: values.connectorId ?? operation.connectorId, routeId: values.routeId ?? operation.routeId, domainAccessId: values.domainAccessId ?? operation.domainAccessId, updatedAt: new Date().toISOString() });
    if (values.clearEncryptedRequest) operation.encryptedRequest = null;
    if (values.verificationDeadlineAt) operation.verificationDeadlineAt = values.verificationDeadlineAt;
    if (values.incrementVerificationAttempts) operation.verificationAttempts += 1;
    if (values.status === 'succeeded') operation.completedAt = new Date().toISOString();
    return operation;
  }
  public async getGuidedOperation(id: string): Promise<GuidedOperation | null> { return this.guidedOperations.find((item) => item.id === id) ?? null; }
  public async listGuidedOperationsPendingVerification(limit: number): Promise<GuidedOperation[]> { return this.guidedOperations.filter((item) => item.kind === 'domain_publish' && item.status === 'waiting' && item.stage === 'pending_https_verification').slice(0, limit); }
  public async withGuidedOperationLock<T>(kind: GuidedOperation['kind'], requestedByUserId: string, idempotencyKey: string, callback: () => Promise<T>): Promise<T> {
    const release = await this.acquireMutex(`guided-operation:${kind}:${requestedByUserId}:${idempotencyKey}`);
    try { return await callback(); } finally { release(); }
  }
  public async listTlsObservationTargets(limit: number): Promise<TlsObservationTarget[]> { return this.cloudflareDomainAccess.filter((item) => item.enabled && item.status === 'active' && item.accessMethod === 'public_ip' && !item.proxied).slice(0, limit).map((item) => ({ domainAccessId: item.id, hostname: item.hostname, agentId: this.routes.find((route) => route.id === item.routeId)!.gatewayAgentId })); }
  public async saveTlsObservation(domainAccessId: string, observation: TlsObservation): Promise<void> { const item = this.cloudflareDomainAccess.find((access) => access.id === domainAccessId); if (!item) return; const prior = item.tlsStatus; Object.assign(item, { tlsStatus: observation.status, tlsIssuer: observation.issuer ?? null, tlsValidTo: observation.validTo ?? null, tlsObservedAt: new Date().toISOString(), tlsError: observation.error ?? null }); if (observation.status === 'expiring' && prior !== 'expiring') this.queueEvent('certificate.expiring', { domainAccessId, agentId: this.routes.find((route) => route.id === item.routeId)?.gatewayAgentId, validTo: observation.validTo }); }
  public async withDomainAccessLock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const releases = [await this.acquireMutex(`domain-access:${id}`)];
    try {
      const access = this.cloudflareDomainAccess.find((item) => item.id === id);
      const connector = access?.connectorId ? this.connectors.find((item) => item.id === access.connectorId) : undefined;
      const account = access ? this.cloudflareAccounts.find((item) => item.id === access.cloudflareAccountId) : undefined;
      if (access?.accessMethod === 'tunnel' && connector?.tunnelId && account?.accountIdentifier) {
        releases.push(await this.acquireMutex(`cloudflare-tunnel:${account.accountIdentifier}:${connector.tunnelId}`));
      }
      return await callback();
    } finally {
      releases.reverse().forEach((release) => release());
    }
  }
  public async hasEnabledDomainAccessDependency(dependency: 'account' | 'connector' | 'route', id: string): Promise<boolean> {
    return this.cloudflareDomainAccess.some((item) => item.enabled && (dependency === 'account' ? item.cloudflareAccountId : dependency === 'connector' ? item.connectorId : item.routeId) === id);
  }
  public async createPendingDomainAccess(values: { accountId: string; zoneId: string; routeId: string; accessMethod: 'tunnel' | 'public_ip'; connectorId?: string; publicIpv4: string[]; publicIpv6: string[]; proxied: boolean }): Promise<CloudflareDomainAccess | null> {
    const zone = this.cloudflareZones.find((item) => item.id === values.zoneId);
    const account = zone && this.cloudflareAccounts.find((item) => item.id === values.accountId && item.id === zone.cloudflareAccountId && item.enabled);
    const connector = values.connectorId ? this.connectors.find((item) => item.id === values.connectorId) : undefined;
    const route = this.routes.find((item) => item.id === values.routeId);
    const tunnelValid = values.accessMethod === 'tunnel' && connector?.enabled && connector.identityStatus === 'verified' && connector.cloudflareAccountId === account?.id && connector.tokenAccountIdentifier === account?.accountIdentifier && connector.tunnelId === connector.tokenTunnelId && connector.agentId === route?.gatewayAgentId && route?.exposure === 'tunnel';
    const publicValid = values.accessMethod === 'public_ip' && !connector && route?.exposure === 'public' && values.publicIpv4.length + values.publicIpv6.length > 0;
    if (!zone || zone.status !== 'active' || !account || !route?.enabled || route.status !== 'active' || (!tunnelValid && !publicValid) || !(route.hostname === zone.name || route.hostname.endsWith(`.${zone.name}`)) || this.cloudflareDomainAccess.some((item) => item.hostname === route.hostname || item.routeId === route.id)) return null;
    const now = new Date().toISOString();
    const created: CloudflareDomainAccess = {
      id: randomUUID(), cloudflareZoneId: zone.id, cloudflareAccountId: account.id, connectorId: connector?.id ?? null,
      routeId: route.id, hostname: route.hostname, accessMethod: values.accessMethod,
      publicIpv4: values.publicIpv4, publicIpv6: values.publicIpv6, ownedDnsRecords: [], dnsRecordId: null,
      enabled: true, revision: 1, proxied: values.proxied, status: 'pending', lastError: null, lastReconciledAt: null,
      tlsStatus: 'not_observed', tlsIssuer: null, tlsValidTo: null, tlsObservedAt: null, tlsError: null, createdAt: now, updatedAt: now,
    };
    this.cloudflareDomainAccess.push(created);
    return created;
  }
  public async setDomainAccessPending(id: string, enabled?: boolean): Promise<CloudflareDomainAccess | null> {
    const item = this.cloudflareDomainAccess.find((access) => access.id === id);
    if (!item) return null;
    Object.assign(item, { ...(enabled === undefined ? {} : { enabled }), revision: item.revision + 1, status: 'pending', lastError: null, updatedAt: new Date().toISOString() });
    return item;
  }
  public async getCloudflareDomainAccessDeployment(id: string): Promise<CloudflareDomainAccessDeployment | null> {
    const item = this.cloudflareDomainAccess.find((access) => access.id === id);
    const account = item && this.cloudflareAccounts.find((candidate) => candidate.id === item.cloudflareAccountId);
    const zone = item && this.cloudflareZones.find((candidate) => candidate.id === item.cloudflareZoneId && candidate.cloudflareAccountId === item.cloudflareAccountId);
    const connector = item?.connectorId ? this.connectors.find((candidate) => candidate.id === item.connectorId) : undefined;
    const route = item && this.routes.find((candidate) => candidate.id === item.routeId);
    return item && account && zone && route ? {
      ...item, accountIdentifier: account.accountIdentifier, encryptedApiToken: account.encryptedApiToken,
      zoneIdentifier: zone.zoneIdentifier, zoneName: zone.name, zoneStatus: zone.status, zoneAccountId: zone.cloudflareAccountId, accountEnabled: account.enabled,
      routeEnabled: route.enabled, routeStatus: route.status, routeExposure: route.exposure, routeAgentId: route.gatewayAgentId, routeHostname: route.hostname,
      connectorEnabled: connector?.enabled ?? null, connectorAgentId: connector?.agentId ?? null,
      connectorAccountId: connector?.cloudflareAccountId ?? null, tunnelId: connector?.tunnelId ?? null,
      connectorIdentityStatus: connector?.identityStatus ?? null,
      connectorTokenAccountIdentifier: connector?.tokenAccountIdentifier ?? null,
      connectorTokenTunnelId: connector?.tokenTunnelId ?? null,
    } : null;
  }
  public async saveDomainAccessDnsRecord(id: string, revision: number, record: Pick<DomainAccessDnsRecord, 'type' | 'content' | 'cloudflareRecordId' | 'ownershipMarker'>): Promise<CloudflareDomainAccess | null> {
    const item = this.cloudflareDomainAccess.find((access) => access.id === id && access.revision === revision);
    if (!item) return null;
    const existing = item.ownedDnsRecords.find((candidate) => candidate.cloudflareRecordId === record.cloudflareRecordId);
    if (existing) Object.assign(existing, record, { status: 'active', lastError: null });
    else item.ownedDnsRecords.push({ ...record, status: 'active', lastError: null });
    item.dnsRecordId = item.ownedDnsRecords.find((candidate) => candidate.type === 'CNAME' && candidate.status === 'active')?.cloudflareRecordId ?? null;
    return item;
  }
  public async markDomainAccessDnsRecordStatus(id: string, revision: number, cloudflareRecordId: string, status: 'cleanup_pending' | 'deleted', lastError?: string): Promise<boolean> {
    const record = this.cloudflareDomainAccess.find((access) => access.id === id && access.revision === revision)?.ownedDnsRecords.find((candidate) => candidate.cloudflareRecordId === cloudflareRecordId);
    if (!record) return false;
    Object.assign(record, { status, lastError: status === 'cleanup_pending' ? lastError ?? 'Cloudflare DNS cleanup failed.' : null });
    return true;
  }
  public async markDomainAccessOutcome(id: string, revision: number, values: { status: 'pending' | 'active' | 'failed' | 'disabled'; lastError?: string | null }): Promise<CloudflareDomainAccess | null> {
    const item = this.cloudflareDomainAccess.find((access) => access.id === id && access.revision === revision);
    if (!item) return null;
    Object.assign(item, values, { dnsRecordId: item.ownedDnsRecords.find((record) => record.type === 'CNAME' && record.status === 'active')?.cloudflareRecordId ?? null, lastError: values.lastError ?? null, lastReconciledAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    return item;
  }
  public async listStacks(): Promise<ManagedStack[]> { return this.stacks.map(({ encryptedComposeYaml: _, ...item }) => item); }
  public async createStack(values: { agentId: string; name: string; projectName: string; encryptedComposeYaml: string; enabled: boolean; postgresBackupConfig?: { service: string; database: string; user: string } }): Promise<ManagedStack | null> {
    if (!this.agents.some((agent) => agent.id === values.agentId && agent.enabled)) return null;
    const now = new Date().toISOString();
    const created = { id: randomUUID(), ...values, postgresBackupConfig: values.postgresBackupConfig ?? null, configured: true, revision: 1, status: 'pending' as const, createdAt: now, updatedAt: now };
    this.stacks.push(created);
    this.queueInternalSync(created.agentId, 'compose.stack.sync', 'stackId', created.id);
    const { encryptedComposeYaml: _, ...publicStack } = created;
    return publicStack;
  }
  public async updateStack(id: string, values: { name?: string; encryptedComposeYaml?: string; enabled?: boolean; postgresBackupConfig?: { service: string; database: string; user: string } | null }): Promise<ManagedStack | null> {
    const item = this.stacks.find((stack) => stack.id === id);
    if (!item || !this.agents.some((agent) => agent.id === item.agentId && agent.enabled)) return null;
    Object.assign(item, values, { revision: item.revision + 1, status: 'pending', updatedAt: new Date().toISOString() });
    this.queueInternalSync(item.agentId, 'compose.stack.sync', 'stackId', item.id);
    const { encryptedComposeYaml: _, ...publicStack } = item;
    return publicStack;
  }
  public async getStackDeployment(stackId: string): Promise<StackDeployment | null> { return this.stacks.find((stack) => stack.id === stackId) ?? null; }
  public async queueStackAction(stackId: string, type: 'compose.restart' | 'compose.stop'): Promise<AgentCommand | null> {
    const item = this.stacks.find((stack) => stack.id === stackId && stack.enabled);
    if (!item) return null;
    return this.createCommand(item.agentId, type, { composePath: `${item.id}/compose.yaml`, stack: item.name, project: item.projectName });
  }
  public async listDeployments(): Promise<Deployment[]> {
    return this.deployments.map((item) => ({
      ...item,
      revisions: this.deploymentRevisions.filter((revision) => revision.deploymentId === item.id).map(({ encryptedSourceCompose: _, encryptedNormalizedCompose: __, ...revision }) => revision),
      latestRun: this.deploymentRuns.filter((run) => run.deploymentId === item.id).at(-1) ?? null,
    }));
  }
  public async createDeployment(values: { agentId: string; displayName: string; projectName: string; sourceRepository: string; commitSha: string; composePath: string; encryptedSourceCompose: string; encryptedNormalizedCompose: string; checksum: string; policyVersion: number; policyResult: DeploymentRevision['policyResult']; requestedByUserId: string }): Promise<Deployment | null> {
    if (!this.agents.some((agent) => agent.id === values.agentId && agent.enabled && agent.enrolledAt) || this.deployments.some((item) => item.agentId === values.agentId && item.projectName === values.projectName && item.enabled)) return null;
    const now = new Date().toISOString();
    const id = randomUUID();
    const revision = { id: randomUUID(), deploymentId: id, commitSha: values.commitSha, composePath: values.composePath, checksum: values.checksum, policyVersion: values.policyVersion, policyResult: values.policyResult, createdByUserId: values.requestedByUserId, createdAt: now, encryptedSourceCompose: values.encryptedSourceCompose, encryptedNormalizedCompose: values.encryptedNormalizedCompose };
    const created: Deployment = { id, agentId: values.agentId, displayName: values.displayName, projectName: values.projectName, sourceRepository: values.sourceRepository, enabled: true, currentRevisionId: null, status: 'pending', revisions: [], latestRun: null, createdAt: now, updatedAt: now };
    this.deploymentRevisions.push(revision); this.deployments.push(created);
    const { encryptedSourceCompose: _, encryptedNormalizedCompose: __, ...publicRevision } = revision;
    return { ...created, revisions: [publicRevision], latestRun: null };
  }
  public async createDeploymentRevision(deploymentId: string, values: { sourceRepository: string; commitSha: string; composePath: string; encryptedSourceCompose: string; encryptedNormalizedCompose: string; checksum: string; policyVersion: number; policyResult: DeploymentRevision['policyResult']; requestedByUserId: string }): Promise<DeploymentRevision | null> {
    const target = this.deployments.find((item) => item.id === deploymentId && item.enabled);
    if (!target || target.sourceRepository !== values.sourceRepository || this.deploymentRevisions.some((item) => item.deploymentId === deploymentId && item.checksum === values.checksum)) return null;
    const revision = { id: randomUUID(), deploymentId, commitSha: values.commitSha, composePath: values.composePath, checksum: values.checksum, policyVersion: values.policyVersion, policyResult: values.policyResult, createdByUserId: values.requestedByUserId, createdAt: new Date().toISOString(), encryptedSourceCompose: values.encryptedSourceCompose, encryptedNormalizedCompose: values.encryptedNormalizedCompose };
    target.updatedAt = new Date().toISOString(); this.deploymentRevisions.push(revision);
    const { encryptedSourceCompose: _, encryptedNormalizedCompose: __, ...publicRevision } = revision;
    return publicRevision;
  }
  public async createDeploymentRun(deploymentId: string, revisionId: string, action: DeploymentRun['action'], requestedByUserId: string): Promise<DeploymentRun | 'active' | null> {
    const target = this.deployments.find((item) => item.id === deploymentId && item.enabled);
    if (!target || !this.agents.some((agent) => agent.id === target.agentId && agent.enabled && agent.enrolledAt) || !this.deploymentRevisions.some((revision) => revision.id === revisionId && revision.deploymentId === deploymentId)) return null;
    if (this.deploymentRuns.some((run) => run.deploymentId === deploymentId && ['pending', 'running'].includes(run.status))) return 'active';
    const id = randomUUID(); const command = await this.createCommand(target.agentId, 'deployment.compose.apply', { runId: id }); if (!command) return null;
    const now = new Date().toISOString();
    const run: DeploymentRun = { id, deploymentId, revisionId, priorRevisionId: target.currentRevisionId, agentId: target.agentId, commandId: command.id, action, status: 'pending', result: null, error: null, startedAt: null, completedAt: null, createdAt: now, updatedAt: now };
    this.deploymentRuns.push(run); Object.assign(target, { status: action === 'stop' ? 'stopping' : 'deploying', updatedAt: now }); return run;
  }
  public async getDeploymentRun(id: string): Promise<DeploymentRun | null> { return this.deploymentRuns.find((item) => item.id === id) ?? null; }
  public async getDeploymentCommandSource(runId: string): Promise<DeploymentCommandSource | null> {
    const run = this.deploymentRuns.find((item) => item.id === runId); const target = run && this.deployments.find((item) => item.id === run.deploymentId); const revision = run && this.deploymentRevisions.find((item) => item.id === run.revisionId && item.deploymentId === run.deploymentId); const prior = run?.priorRevisionId ? this.deploymentRevisions.find((item) => item.id === run.priorRevisionId && item.deploymentId === run.deploymentId) : undefined;
    return run && target && revision ? { ...revision, agentId: target.agentId, projectName: target.projectName, encryptedNormalizedCompose: revision.encryptedNormalizedCompose, priorRevisionId: run.priorRevisionId, encryptedPriorNormalizedCompose: prior?.encryptedNormalizedCompose ?? null, action: run.action, runId: run.id, commandId: run.commandId } : null;
  }
  public async listRoutes(): Promise<ManagedRoute[]> { return this.routes; }
  public async createRoute(values: { gatewayAgentId: string; name: string; hostname: string; exposure: 'tunnel' | 'public'; backends: string[]; enabled: boolean }): Promise<ManagedRoute | null> {
    if (!this.agents.some((agent) => agent.id === values.gatewayAgentId && agent.enabled)) return null;
    const now = new Date().toISOString();
    const created: ManagedRoute = { id: randomUUID(), ...values, revision: 1, status: 'pending', createdAt: now, updatedAt: now };
    this.routes.push(created);
    this.queueInternalSync(created.gatewayAgentId, 'traefik.route.sync', 'routeId', created.id);
    return created;
  }
  public async updateRoute(id: string, values: { gatewayAgentId?: string; name?: string; hostname?: string; exposure?: 'tunnel' | 'public'; backends?: string[]; enabled?: boolean }): Promise<ManagedRoute | null> {
    const item = this.routes.find((route) => route.id === id);
    if (!item) return null;
    const targetAgentId = values.gatewayAgentId ?? item.gatewayAgentId;
    if (!this.agents.some((agent) => agent.id === targetAgentId && agent.enabled)) return null;
    Object.assign(item, values, { revision: item.revision + 1, status: 'pending', updatedAt: new Date().toISOString() });
    this.queueInternalSync(item.gatewayAgentId, 'traefik.route.sync', 'routeId', item.id);
    return item;
  }
  public async getRouteDeployment(routeId: string): Promise<ManagedRoute | null> { return this.routes.find((route) => route.id === routeId) ?? null; }
  public async getNotificationSettings(): Promise<NotificationSettings> { return { configured: this.notificationSecrets !== null, selectedEvents: this.selectedEvents }; }
  public async getNotificationSecrets(): Promise<{ botTokenEncrypted: string; groupIdEncrypted: string } | null> { return this.notificationSecrets; }
  public async saveNotificationSettings(botTokenEncrypted: string, groupIdEncrypted: string, selectedEvents: string[]): Promise<void> {
    this.notificationSecrets = { botTokenEncrypted, groupIdEncrypted };
    this.selectedEvents = selectedEvents;
  }
  public async getNotificationTopology(): Promise<NotificationTopology> {
    const maxAgents = 100; const maxServices = 5_000; const maxScopes = 5_000;
    const availableAgents = this.agents.filter((item) => !item.archivedAt);
    const availableScopes = this.notificationScopes.slice(0, maxScopes);
    const agentScopes = new Map(availableScopes.filter((scope) => scope.projectName === null).map((scope) => [scope.agentId, scope.enabled]));
    const serviceScopes = new Map(availableScopes.filter((scope) => scope.projectName && scope.serviceName).map((scope) => [`${scope.agentId}\u0000${scope.projectName}\u0000${scope.serviceName}`, scope.enabled]));
    let includedServices = 0;
    const agents = availableAgents.slice(0, maxAgents).map((item): NotificationAgentPreference => {
      const enabled = agentScopes.get(item.id) ?? true;
      const latest = this.telemetry.find((snapshot) => snapshot.agentId === item.id);
      const services = new Map<string, NotificationServicePreference>();
      for (const service of latest?.services ?? []) {
        if (includedServices >= maxServices) break;
        includedServices += 1;
        const projectName = String(service.projectName);
        const serviceName = String(service.serviceName);
        const status = String(service.status) as NotificationServicePreference['status'];
        const direct = serviceScopes.get(`${item.id}\u0000${projectName}\u0000${serviceName}`) ?? true;
        services.set(`${projectName}\u0000${serviceName}`, { projectName, serviceName, status, discovered: true, enabled: enabled && direct, inherited: !enabled && direct, directlyEnabled: direct });
      }
      for (const scope of availableScopes) {
        if (scope.agentId !== item.id || !scope.projectName || !scope.serviceName) continue;
        const key = `${scope.projectName}\u0000${scope.serviceName}`;
        if (!services.has(key)) services.set(key, { projectName: scope.projectName!, serviceName: scope.serviceName!, status: 'unknown', discovered: false, enabled: enabled && scope.enabled, inherited: !enabled && scope.enabled, directlyEnabled: scope.enabled });
      }
      return { id: item.id, name: item.name, healthStatus: item.healthStatus, lastTelemetryAt: item.lastTelemetryAt, enabled, services: [...services.values()] };
    });
    const totalServices = availableAgents.reduce((total, item) => total + (this.telemetry.find((snapshot) => snapshot.agentId === item.id)?.services.length ?? 0), 0);
    return { ...(await this.getNotificationSettings()), agents, truncated: { agents: availableAgents.length > maxAgents, services: totalServices > maxServices, scopes: this.notificationScopes.length > maxScopes } };
  }
  public async setAgentNotificationPreference(agentId: string, enabled: boolean, updatedByUserId: string): Promise<NotificationAgentPreference | null> {
    if (!this.agents.some((item) => item.id === agentId && !item.archivedAt)) return null;
    const scope = this.notificationScopes.find((item) => item.agentId === agentId && item.projectName === null);
    if (scope) Object.assign(scope, { enabled, updatedByUserId }); else this.notificationScopes.push({ agentId, projectName: null, serviceName: null, enabled, updatedByUserId });
    return (await this.getNotificationTopology()).agents.find((item) => item.id === agentId) ?? null;
  }
  public async setServiceNotificationPreference(agentId: string, projectName: string, serviceName: string, enabled: boolean, updatedByUserId: string): Promise<NotificationServicePreference | null> {
    const retained = this.notificationScopes.find((item) => item.agentId === agentId && item.projectName === projectName && item.serviceName === serviceName);
    const discovered = this.telemetry.find((snapshot) => snapshot.agentId === agentId)?.services.some((service) => service.projectName === projectName && service.serviceName === serviceName);
    if (!this.agents.some((item) => item.id === agentId && !item.archivedAt) || (!retained && !discovered)) return null;
    if (retained) Object.assign(retained, { enabled, updatedByUserId }); else this.notificationScopes.push({ agentId, projectName, serviceName, enabled, updatedByUserId });
    return (await this.getNotificationTopology()).agents.find((item) => item.id === agentId)?.services.find((item) => item.projectName === projectName && item.serviceName === serviceName) ?? null;
  }
  public async listAgents(): Promise<Agent[]> { return this.agents.filter((item) => !item.archivedAt); }
  public async createAgent(name: string, enrollmentTokenHash: string): Promise<Agent> {
    const created = {
      id: randomUUID(), name, enabled: true, enrolledAt: null, lastHeartbeatAt: null, lastTelemetryAt: null,
      lastCommandPollAt: null, lastCommandResultAt: null, healthStatus: 'pending' as const,
      diagnostics: null, metadata: null, createdAt: new Date().toISOString(), enrollmentTokenHash,
    };
    this.agents.push(created);
    return created;
  }
  public async removeAgent(id: string): Promise<'deleted' | 'archived' | 'blocked' | 'missing'> {
    const index = this.agents.findIndex((item) => item.id === id && !item.archivedAt);
    if (index < 0) return 'missing';
    const item = this.agents[index]!;
    const blocked = this.connectors.some((connector) => connector.agentId === id)
      || this.stacks.some((stack) => stack.agentId === id)
      || this.deployments.some((deployment) => deployment.agentId === id)
      || this.routes.some((route) => route.gatewayAgentId === id)
      || this.backups.some((backup) => backup.agentId === id)
      || this.restores.some((restore) => restore.agentId === id)
      || this.commands.some((command) => command.agentId === id && ['pending', 'claimed'].includes(command.status));
    if (blocked) return 'blocked';
    const hasHistory = this.commands.some((command) => command.agentId === id)
      || this.telemetry.some((snapshot) => snapshot.agentId === id);
    if (!item.enrolledAt && !hasHistory) {
      this.agents.splice(index, 1);
      return 'deleted';
    }
    item.enabled = false;
    item.archivedAt = new Date().toISOString();
    delete item.enrollmentTokenHash;
    delete item.credentialHash;
    return 'archived';
  }
  public async enrollAgent(enrollmentTokenHash: string, credentialHash: string): Promise<Agent | null> {
    const item = this.agents.find((agent) => agent.enrollmentTokenHash === enrollmentTokenHash && !agent.enrolledAt);
    if (!item) return null;
    delete item.enrollmentTokenHash;
    item.credentialHash = credentialHash;
    item.enrolledAt = new Date().toISOString();
    item.healthStatus = 'offline';
    return item;
  }
  public async authenticateAgent(credentialHash: string): Promise<Agent | null> { return this.agents.find((item) => item.credentialHash === credentialHash && item.enabled) ?? null; }
  public async heartbeatAgent(id: string, metadata: Record<string, unknown> = {}): Promise<void> {
    const item = this.agents.find((agent) => agent.id === id);
    if (item) {
      const recovered = this.offlineNotifications.has(item.id);
      item.lastHeartbeatAt = new Date().toISOString();
      item.metadata = metadata;
      item.diagnostics = metadata.diagnostics && typeof metadata.diagnostics === 'object' && !Array.isArray(metadata.diagnostics) ? metadata.diagnostics as Record<string, unknown> : item.diagnostics;
      item.healthStatus = 'connected';
      if (recovered) { this.offlineNotifications.delete(item.id); this.queueEvent('agent.recovered', { agentId: item.id, agentName: item.name }); }
      const connectors = metadata.diagnostics && typeof metadata.diagnostics === 'object' && !Array.isArray(metadata.diagnostics)
        ? (metadata.diagnostics as { connectors?: unknown }).connectors : null;
      if (connectors && typeof connectors === 'object' && !Array.isArray(connectors)) for (const [connectorId, value] of Object.entries(connectors).slice(0, 100)) {
        const connector = this.connectors.find((candidate) => candidate.id === connectorId && candidate.agentId === id && candidate.enabled);
        const diagnostic = value && typeof value === 'object' && !Array.isArray(value) ? value as { status?: unknown; error?: unknown } : null;
        if (connector && diagnostic && ['connected', 'origin_unhealthy', 'reconnecting', 'stopped', 'failed'].includes(String(diagnostic.status))) Object.assign(connector, { runtimeStatus: diagnostic.status as Connector['runtimeStatus'], lastError: typeof diagnostic.error === 'string' ? diagnostic.error.slice(0, 1000) : null, lastObservedAt: new Date().toISOString() });
      }
    }
  }
  public async recordTelemetry(agentId: string, snapshot: Omit<TelemetrySnapshot, 'agentId' | 'receivedAt'>): Promise<void> {
    const previous = this.telemetry.find((item) => item.agentId === agentId);
    const receivedAt = new Date().toISOString();
    this.telemetry.unshift({ agentId, ...snapshot, receivedAt });
    const agent = this.agents.find((item) => item.id === agentId);
    if (agent) { agent.lastTelemetryAt = receivedAt; agent.healthStatus = 'connected'; }
    const previousServices = new Map((previous?.services ?? []).map((service) => [service.name, service]));
    for (const service of snapshot.services) {
      if (service.status === 'unhealthy' && previousServices.get(service.name)?.status !== 'unhealthy') this.queueEvent('service.unhealthy', { agentId, projectName: service.projectName, serviceName: service.serviceName, service: service.name });
      const previousStatus = String(previousServices.get(service.name)?.status ?? 'unknown');
      if (service.status === 'stopped' && previousStatus !== 'stopped') this.queueEvent('service.stopped', { agentId, projectName: service.projectName, serviceName: service.serviceName, service: service.name });
      if (['healthy', 'running'].includes(String(service.status)) && ['unhealthy', 'stopped'].includes(previousStatus)) this.queueEvent('service.recovered', { agentId, projectName: service.projectName, serviceName: service.serviceName, service: service.name, previousStatus });
    }
  }
  public async getMonitoringSummary(): Promise<TelemetrySnapshot[]> {
    const latest = new Map<string, TelemetrySnapshot>();
    for (const item of this.telemetry) {
      if (!latest.has(item.agentId) && this.agents.some((agent) => agent.id === item.agentId && !agent.archivedAt)) latest.set(item.agentId, item);
    }
    return [...latest.values()];
  }
  public async getAgentMonitoring(agentId: string): Promise<{ agent: Agent; latest: TelemetrySnapshot | null; history: TelemetrySnapshot[] } | null> {
    const found = this.agents.find((item) => item.id === agentId && !item.archivedAt);
    if (!found) return null;
    const history = this.telemetry.filter((item) => item.agentId === agentId).slice(0, 288);
    return { agent: found, latest: history[0] ?? null, history };
  }
  public async getLatestRuntimeInventory(): Promise<RuntimeInventory[]> {
    return this.agents.filter((item) => !item.archivedAt).map((item) => ({ agent: item, latest: this.telemetry.find((snapshot) => snapshot.agentId === item.id) ?? null }));
  }
  public async createRuntimeOperation(values: { requestedByUserId: string; agentId: string; action: RuntimeAction; scope: RuntimeScope; projectName: string; serviceName?: string }): Promise<RuntimeOperation | 'active' | null> {
    if (!this.agents.some((item) => item.id === values.agentId && item.enabled && item.enrolledAt)) return null;
    if (this.runtimeOperations.some((item) => item.agentId === values.agentId && item.projectName === values.projectName && (item.serviceName === null || values.serviceName === undefined || item.serviceName === values.serviceName) && ['pending', 'running'].includes(item.status))) return 'active';
    const now = new Date().toISOString();
    const operation: RuntimeOperation = { id: randomUUID(), ...values, serviceName: values.serviceName ?? null, commandId: null, status: 'pending', result: null, error: null, createdAt: now, updatedAt: now, completedAt: null };
    const command = await this.createCommand(values.agentId, 'compose.runtime.action', { operationId: operation.id });
    if (!command) return null;
    operation.commandId = command.id; this.runtimeOperations.unshift(operation); return operation;
  }
  public async listRuntimeOperations(): Promise<RuntimeOperation[]> { return this.runtimeOperations; }
  public async getRuntimeOperation(id: string): Promise<RuntimeOperation | null> { return this.runtimeOperations.find((item) => item.id === id) ?? null; }
  public async createRuntimeLogRequest(values: { requestedByUserId: string; agentId: string; projectName: string; serviceName: string; tail: number; since?: string }): Promise<RuntimeLogRequest | null> {
    if (!this.agents.some((item) => item.id === values.agentId && item.enabled && item.enrolledAt)) return null;
    const now = new Date().toISOString();
    const request: RuntimeLogRequest = { id: randomUUID(), ...values, since: values.since ?? null, commandId: null, status: 'pending', result: null, error: null, createdAt: now, updatedAt: now, completedAt: null };
    const command = await this.createCommand(values.agentId, 'compose.runtime.logs', { requestId: request.id });
    if (!command) return null;
    request.commandId = command.id; this.runtimeLogRequests.unshift(request); return request;
  }
  public async getRuntimeLogRequest(id: string, requestedByUserId?: string): Promise<RuntimeLogRequest | null> { return this.runtimeLogRequests.find((item) => item.id === id && (!requestedByUserId || item.requestedByUserId === requestedByUserId)) ?? null; }
  public async queueLogRequest(stackId: string, requestedByUserId: string, service: string, tail: number, since?: string): Promise<AgentCommand | null> {
    const item = this.stacks.find((stack) => stack.id === stackId && stack.enabled);
    if (!item) return null;
    return this.createCommand(item.agentId, 'service.logs.read', { stackId, requestedByUserId, service, tail, ...(since ? { since } : {}) });
  }
  public async getLogRequest(commandId: string, requestedByUserId: string): Promise<AgentCommand | null> {
    return this.commands.find((item) => item.id === commandId && item.type === 'service.logs.read' && item.payload.requestedByUserId === requestedByUserId) ?? null;
  }
  public async createBackup(stackId: string, requestedByUserId: string, target: BackupTarget): Promise<StackBackup | 'active' | null> {
    const stack = this.stacks.find((item) => item.id === stackId && item.enabled && this.agents.some((agent) => agent.id === item.agentId && agent.enabled));
    if (!stack) return null;
    if (this.hasActiveOperation(stackId)) return 'active';
    const now = new Date().toISOString();
    const id = randomUUID();
    const command = await this.createCommand(stack.agentId, 'stack.backup.create', { backupId: id });
    const created: StackBackup = {
      id, stackId, agentId: stack.agentId, commandId: command!.id, requestedByUserId, target, stackRevision: stack.revision,
      status: 'pending', result: null, createdAt: now, updatedAt: now, completedAt: null,
    };
    this.backups.push(created);
    return created;
  }
  public async listBackups(): Promise<StackBackup[]> { return this.backups; }
  public async getBackupDeployment(backupId: string): Promise<{ backup: StackBackup; stack: StackDeployment } | null> {
    const found = this.backups.find((item) => item.id === backupId);
    const stack = found ? this.stacks.find((item) => item.id === found.stackId) : undefined;
    return found && stack ? { backup: found, stack } : null;
  }
  public async createRestore(backupId: string, requestedByUserId: string): Promise<StackRestore | 'active' | null> {
    const source = this.backups.find((item) => item.id === backupId && item.status === 'succeeded');
    if (!source) return null;
    if (this.hasActiveOperation(source.stackId)) return 'active';
    const now = new Date().toISOString();
    const id = randomUUID();
    const command = await this.createCommand(source.agentId, 'stack.restore.apply', { restoreId: id });
    const created: StackRestore = {
      id, stackId: source.stackId, backupId, agentId: source.agentId, commandId: command!.id, requestedByUserId,
      status: 'pending', result: null, createdAt: now, updatedAt: now, completedAt: null,
    };
    this.restores.push(created);
    return created;
  }
  public async listRestores(): Promise<StackRestore[]> { return this.restores; }
  public async createSystemBackup(requestedByUserId: string, target: BackupTarget, artifactPath: string): Promise<StoredSystemBackup> {
    const created: StoredSystemBackup = { id: randomUUID(), requestedByUserId, target, artifactPath, status: 'running', sizeBytes: null, checksum: null, error: null, source: 'created', metadata: {}, createdAt: new Date().toISOString(), completedAt: null };
    this.systemBackups.unshift(created);
    return created;
  }
  public async completeSystemBackup(id: string, sizeBytes: number, checksum: string): Promise<SystemBackup> {
    const found = this.systemBackups.find((item) => item.id === id)!;
    Object.assign(found, { status: 'succeeded', sizeBytes, checksum, completedAt: new Date().toISOString() });
    return found;
  }
  public async failSystemBackup(id: string, error: string): Promise<SystemBackup> {
    const found = this.systemBackups.find((item) => item.id === id)!;
    Object.assign(found, { status: 'failed', error, completedAt: new Date().toISOString() });
    return found;
  }
  public async listSystemBackups(): Promise<SystemBackup[]> { return this.systemBackups; }
  public async getSystemBackup(id: string): Promise<StoredSystemBackup | null> { return this.systemBackups.find((item) => item.id === id && item.status === 'succeeded') ?? null; }
  public async importSystemBackup(values: { id: string; requestedByUserId: string; artifactPath: string; sizeBytes: number; checksum: string; importId: string }): Promise<'created' | 'idempotent' | 'conflict'> {
    const existing = this.systemBackups.find((item) => item.id === values.id);
    if (existing) return existing.checksum === values.checksum && existing.sizeBytes === values.sizeBytes ? 'idempotent' : 'conflict';
    const now = new Date().toISOString();
    this.systemBackups.unshift({ id: values.id, requestedByUserId: values.requestedByUserId, target: 'local', artifactPath: values.artifactPath, status: 'succeeded', sizeBytes: values.sizeBytes, checksum: values.checksum, error: null, source: 'imported', metadata: { importId: values.importId }, createdAt: now, completedAt: now });
    return 'created';
  }
  public async createSystemBackupImport(requestedByUserId: string, quarantinePath: string): Promise<SystemBackupImport | 'active'> {
    if (this.systemBackupImports.some((item) => ['uploading', 'uploaded', 'validating'].includes(item.status))) return 'active';
    const now = new Date().toISOString();
    const created: SystemBackupImport = { id: randomUUID(), requestedByUserId, status: 'uploading', quarantinePath, sizeBytes: null, checksum: null, backupId: null, error: null, createdAt: now, updatedAt: now, completedAt: null, validationRevision: 0 };
    this.systemBackupImports.unshift(created); return created;
  }
  public async updateSystemBackupImport(id: string, status: SystemBackupImport['status'], values: { sizeBytes?: number; checksum?: string; backupId?: string; error?: string } = {}): Promise<SystemBackupImport> {
    const found = this.systemBackupImports.find((item) => item.id === id); if (!found) throw new Error('Import not found.');
    Object.assign(found, values, { status, error: values.error ?? null, updatedAt: new Date().toISOString(), completedAt: ['imported', 'rejected'].includes(status) ? new Date().toISOString() : null }); return found;
  }
  public async claimSystemBackupImport(id: string, requestedByUserId: string): Promise<SystemBackupImport | 'validating' | null> {
    const found = this.systemBackupImports.find((item) => item.id === id && item.requestedByUserId === requestedByUserId);
    if (!found) return null;
    if (found.status === 'validating') return 'validating';
    if (found.status !== 'uploaded') return null;
    Object.assign(found, { status: 'validating', validationRevision: found.validationRevision + 1, updatedAt: new Date().toISOString() });
    return found;
  }
  public async finishSystemBackupImport(id: string, validationRevision: number, status: 'imported' | 'rejected', values: { backupId?: string; error?: string } = {}): Promise<SystemBackupImport | null> {
    const found = this.systemBackupImports.find((item) => item.id === id && item.status === 'validating' && item.validationRevision === validationRevision);
    if (!found) return null;
    Object.assign(found, values, { status, error: values.error ?? null, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    return found;
  }
  public async getSystemBackupImport(id: string): Promise<SystemBackupImport | null> { return this.systemBackupImports.find((item) => item.id === id) ?? null; }
  public async listSystemBackupImports(): Promise<SystemBackupImport[]> { return this.systemBackupImports; }
  public async rejectStaleSystemBackupImports(before: Date): Promise<SystemBackupImport[]> { const stale = this.systemBackupImports.filter((item) => ['uploading', 'uploaded', 'validating'].includes(item.status) && Date.parse(item.updatedAt) < before.getTime()); stale.forEach((item) => Object.assign(item, { status: 'rejected', error: 'upload_interrupted', completedAt: new Date().toISOString() })); return stale; }
  public async recordSystemBackupTransferEvent(values: { requestedByUserId: string; operation: 'export' | 'import' | 'restore_apply_requested'; backupId?: string; restoreId?: string; importId?: string; metadata?: Record<string, unknown> }): Promise<void> { this.systemBackupTransferEvents.push(values); }
  public async createSystemRecoveryRequest(_restoreId: string, _requestedByUserId: string, ownershipToken: string): Promise<{ id: string; ownershipToken: string } | 'active'> {
    if (this.systemRecoveryRequests.some((item) => ['publishing', 'published'].includes(item.status))) return 'active';
    const created = { id: randomUUID(), ownershipToken, status: 'publishing' as 'publishing' | 'published' | 'failed', error: null as string | null };
    this.systemRecoveryRequests.push(created);
    return created;
  }
  public async finishSystemRecoveryRequest(id: string, ownershipToken: string, status: 'published' | 'failed', error?: string): Promise<boolean> {
    const found = this.systemRecoveryRequests.find((item) => item.id === id && item.ownershipToken === ownershipToken && item.status === 'publishing');
    if (!found) return false;
    Object.assign(found, { status, error: error ?? null });
    return true;
  }
  public async createSystemRestore(backupId: string, requestedByUserId: string, status: 'staging' | 'failed', error?: string): Promise<SystemRestore> {
    const now = new Date().toISOString();
    const created: SystemRestore = { id: randomUUID(), backupId, requestedByUserId, status, error: error ?? null, createdAt: now, completedAt: status === 'failed' ? now : null };
    this.systemRestores.unshift(created);
    return created;
  }
  public async updateSystemRestore(id: string, status: 'staged' | 'failed', error?: string): Promise<SystemRestore> {
    const found = this.systemRestores.find((item) => item.id === id && item.status === 'staging');
    if (!found) throw new Error('The system restore audit record could not be transitioned.');
    Object.assign(found, { status, error: error ?? null, completedAt: new Date().toISOString() });
    return found;
  }
  public async listSystemRestores(): Promise<SystemRestore[]> { return this.systemRestores; }
  public async getSystemRestore(id: string): Promise<SystemRestore | null> { return this.systemRestores.find((item) => item.id === id) ?? null; }
  public async getRestoreDeployment(restoreId: string): Promise<{ restore: StackRestore; backup: StackBackup; stack: StackDeployment } | null> {
    const found = this.restores.find((item) => item.id === restoreId);
    const source = found ? this.backups.find((item) => item.id === found.backupId) : undefined;
    const stack = found ? this.stacks.find((item) => item.id === found.stackId) : undefined;
    return found && source && stack ? { restore: found, backup: source, stack } : null;
  }
  public async createCommand(agentId: string, type: string, payload: Record<string, unknown>): Promise<AgentCommand | null> {
    if (!this.agents.some((item) => item.id === agentId && item.enabled)) return null;
    const created: AgentCommand & { createdAt: string } = { id: randomUUID(), agentId, type, payload, status: 'pending', createdAt: new Date().toISOString() };
    this.commands.push(created);
    return created;
  }
  public async listCommands(agentId?: string): Promise<AgentCommand[]> { return this.commands.filter((item) => !agentId || item.agentId === agentId); }
  public async getCommand(id: string): Promise<AgentCommand | null> { return this.commands.find((item) => item.id === id) ?? null; }
  public async claimCommands(agentId: string, limit: number): Promise<AgentCommand[]> {
    const agent = this.agents.find((item) => item.id === agentId);
    if (agent) agent.lastCommandPollAt = new Date().toISOString();
    const selected = this.commands.filter((item) => item.agentId === agentId && item.status === 'pending').slice(0, limit);
    selected.forEach((item) => {
      item.status = 'claimed';
      if (item.type === 'cloudflare.connector.sync') {
        const connector = this.connectors.find((candidate) => candidate.id === item.payload.connectorId && candidate.agentId === agentId && candidate.desiredRevision === item.payload.revision);
        if (connector) connector.deploymentStatus = connector.enabled ? 'deploying' : 'stopping';
      }
      if (item.type === 'stack.backup.create') {
        const backup = this.backups.find((candidate) => candidate.id === item.payload.backupId);
        if (backup) backup.status = 'running';
      }
      if (item.type === 'stack.restore.apply') {
        const restore = this.restores.find((candidate) => candidate.id === item.payload.restoreId);
        if (restore) restore.status = 'running';
      }
      if (item.type === 'compose.runtime.action') { const operation = this.runtimeOperations.find((candidate) => candidate.id === item.payload.operationId && candidate.agentId === agentId); if (operation) operation.status = 'running'; }
      if (item.type === 'compose.runtime.logs') { const request = this.runtimeLogRequests.find((candidate) => candidate.id === item.payload.requestId && candidate.agentId === agentId); if (request) request.status = 'running'; }
      if (item.type === 'deployment.compose.apply') { const run = this.deploymentRuns.find((candidate) => candidate.id === item.payload.runId && candidate.agentId === agentId); if (run) { run.status = 'running'; run.startedAt = new Date().toISOString(); } }
    });
    return selected;
  }
  public async completeCommand(agentId: string, commandId: string, status: 'succeeded' | 'failed', result: Record<string, unknown>): Promise<'updated' | 'idempotent' | 'conflict' | 'missing'> {
    const item = this.commands.find((command) => command.id === commandId && command.agentId === agentId);
    if (!item) return 'missing';
    const commandResult = item.type === 'compose.runtime.logs' ? { truncated: result.truncated === true } : result;
    const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, itemValue: unknown) => itemValue && typeof itemValue === 'object' && !Array.isArray(itemValue)
      ? Object.fromEntries(Object.entries(itemValue as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
      : itemValue);
    if (item.status === status && canonicalJson(item.result) === canonicalJson(commandResult)) return 'idempotent';
    if (item.status !== 'claimed') return 'conflict';
    item.status = status;
    item.result = commandResult;
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (agent) {
      agent.lastCommandResultAt = new Date().toISOString();
      if (item.type === 'agent.diagnostics.run' && status === 'succeeded' && result.diagnostics && typeof result.diagnostics === 'object') agent.diagnostics = result.diagnostics as Record<string, unknown>;
    }
    if (item.type === 'cloudflare.connector.sync' && typeof item.payload.connectorId === 'string') {
      const connector = this.connectors.find((candidate) => candidate.id === item.payload.connectorId && candidate.agentId === agentId && candidate.desiredRevision === item.payload.revision);
      if (connector) Object.assign(connector, {
        deploymentStatus: status === 'succeeded' ? (result.runtimeStatus === 'stopped' ? 'stopped' : 'active') : 'failed',
        runtimeStatus: status === 'failed' ? 'failed' : result.runtimeStatus === 'origin_unhealthy' ? 'origin_unhealthy' : result.runtimeStatus === 'stopped' ? 'stopped' : result.runtimeStatus === 'connected' ? 'connected' : 'reconnecting',
        lastError: status === 'failed' ? String(result.error || 'Connector deployment failed.') : null,
        lastDeployedAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(),
      });
    }
    const deploymentStatus = status === 'succeeded' ? 'active' : 'failed';
    if (item.type === 'compose.stack.sync' && typeof item.payload.stackId === 'string') {
      const stack = this.stacks.find((candidate) => candidate.id === item.payload.stackId && candidate.agentId === agentId);
      const hasPending = this.commands.some((candidate) => candidate.type === item.type && candidate.status === 'pending' && candidate.payload.stackId === item.payload.stackId);
      if (stack && !hasPending) stack.status = deploymentStatus;
    }
    if (item.type === 'traefik.route.sync' && typeof item.payload.routeId === 'string') {
      const route = this.routes.find((candidate) => candidate.id === item.payload.routeId && candidate.gatewayAgentId === agentId);
      const hasPending = this.commands.some((candidate) => candidate.type === item.type && candidate.status === 'pending' && candidate.payload.routeId === item.payload.routeId);
      if (route && !hasPending) route.status = deploymentStatus;
    }
    if (status === 'failed' && ['compose.stack.sync', 'traefik.route.sync', 'cloudflare.connector.sync'].includes(item.type)) {
      const stack = item.type === 'compose.stack.sync' ? this.stacks.find((candidate) => candidate.id === item.payload.stackId) : undefined;
      this.queueEvent('deployment.failed', { agentId, ...(stack ? { projectName: stack.projectName } : {}), commandId, commandType: item.type });
    }
    if (item.type === 'stack.backup.create') {
      const backup = this.backups.find((candidate) => candidate.id === item.payload.backupId);
      if (backup) {
        Object.assign(backup, { status, result, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        const stack = this.stacks.find((candidate) => candidate.id === backup.stackId);
        this.queueEvent(status === 'succeeded' ? 'backup.succeeded' : 'backup.failed', { agentId, ...(stack ? { projectName: stack.projectName } : {}), backupId: backup.id });
      }
    }
    if (item.type === 'stack.restore.apply') {
      const restore = this.restores.find((candidate) => candidate.id === item.payload.restoreId);
      if (restore) Object.assign(restore, { status, result, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    if (item.type === 'compose.runtime.action') {
      const operation = this.runtimeOperations.find((candidate) => candidate.id === item.payload.operationId && ['pending', 'running'].includes(candidate.status));
      if (operation) { const safeResult = Object.fromEntries(['matched', 'succeeded', 'failed', 'message'].flatMap((key) => typeof result[key] === 'string' || typeof result[key] === 'number' ? [[key, result[key]]] : [])); Object.assign(operation, { status, result: safeResult, error: status === 'failed' ? String(result.error || 'Runtime action failed.') : null, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); this.queueEvent(status === 'succeeded' ? 'runtime.action.succeeded' : 'runtime.action.failed', { agentId, projectName: operation.projectName, ...(operation.serviceName ? { serviceName: operation.serviceName } : {}), action: operation.action, scope: operation.scope }); }
    }
    if (item.type === 'compose.runtime.logs') {
      const request = this.runtimeLogRequests.find((candidate) => candidate.id === item.payload.requestId && ['pending', 'running'].includes(candidate.status));
      if (request) Object.assign(request, { status, result: status === 'succeeded' ? { logs: typeof result.logs === 'string' ? result.logs : '', truncated: result.truncated === true } : null, error: status === 'failed' ? String(result.error || 'Runtime log request failed.') : null, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    if (item.type === 'deployment.compose.apply') {
      const run = this.deploymentRuns.find((candidate) => candidate.id === item.payload.runId && ['pending', 'running'].includes(candidate.status));
      const target = run && this.deployments.find((candidate) => candidate.id === run.deploymentId && candidate.agentId === agentId);
      if (run && target) {
        const now = new Date().toISOString(); const safeResult = Object.fromEntries(['matched', 'succeeded', 'failed', 'message'].flatMap((key) => typeof result[key] === 'string' || typeof result[key] === 'number' ? [[key, result[key]]] : []));
        Object.assign(run, { status, result: safeResult, error: status === 'failed' ? String(result.error || 'Deployment failed.') : null, completedAt: now, updatedAt: now });
        Object.assign(target, { status: status === 'succeeded' ? run.action === 'stop' ? 'stopped' : 'active' : 'failed', ...(status === 'succeeded' && run.action !== 'stop' ? { currentRevisionId: run.revisionId } : {}), updatedAt: now });
        this.queueEvent(status === 'succeeded' ? 'deployment.succeeded' : 'deployment.failed', { agentId, projectName: target.projectName, deploymentId: target.id, runId: run.id, action: run.action });
      }
    }
    return 'updated';
  }
  public async claimNotificationDelivery(): Promise<NotificationDelivery | null> {
    const found = this.deliveries.find((item) => item.status === 'pending');
    if (!found) return null;
    found.status = 'dispatching';
    found.attempts += 1;
    return found;
  }
  public async isNotificationDeliveryEnabled(delivery: NotificationDelivery): Promise<boolean> {
    if (!this.notificationSecrets || !this.selectedEvents.includes(delivery.eventType)) return false;
    if (delivery.agentId && this.notificationScopes.some((scope) => scope.agentId === delivery.agentId && scope.projectName === null && !scope.enabled)) return false;
    return !(delivery.agentId && delivery.serviceName && this.notificationScopes.some((scope) => scope.agentId === delivery.agentId && scope.projectName === delivery.projectName && scope.serviceName === delivery.serviceName && !scope.enabled));
  }
  public async skipNotificationDelivery(id: string): Promise<void> {
    const found = this.deliveries.find((item) => item.id === id);
    if (found) found.status = 'skipped';
  }
  public async purgeRuntimeLogResults(completedBefore: Date): Promise<number> {
    let purged = 0;
    for (const request of this.runtimeLogRequests) {
      if (request.result && request.completedAt && Date.parse(request.completedAt) < completedBefore.getTime()) {
        request.result = null;
        const command = this.commands.find((item) => item.id === request.commandId && item.type === 'compose.runtime.logs');
        if (command?.result) delete command.result.logs;
        purged += 1;
      }
    }
    return purged;
  }
  public async completeNotificationDelivery(id: string): Promise<void> {
    const found = this.deliveries.find((item) => item.id === id);
    if (found) found.status = 'succeeded';
  }
  public async retryNotificationDelivery(id: string, error: string, _delaySeconds: number, terminal: boolean): Promise<void> {
    const found = this.deliveries.find((item) => item.id === id);
    if (found) Object.assign(found, { status: terminal ? 'failed' : 'pending', error });
  }
  public async sweepOfflineAgents(offlineBefore: Date): Promise<number> {
    const offline = this.agents.filter((agent) => agent.enabled && agent.enrolledAt && agent.lastHeartbeatAt && Date.parse(agent.lastHeartbeatAt) < offlineBefore.getTime() && !this.offlineNotifications.has(agent.id));
    for (const agent of offline) { this.offlineNotifications.add(agent.id); this.queueEvent('agent.offline', { agentId: agent.id, agentName: agent.name }); }
    return offline.length;
  }
  public async failStaleCommands(staleBefore: Date): Promise<number> {
    const stale = this.commands.filter((command) => ['pending', 'claimed'].includes(command.status) && (
      (['stack.backup.create', 'stack.restore.apply', 'compose.runtime.action', 'compose.runtime.logs', 'deployment.compose.apply'].includes(command.type) && Date.parse(command.createdAt ?? '') < staleBefore.getTime())
      || (['cloudflare.connector.sync', 'cloudflare.connector.remove'].includes(command.type) && Date.parse(command.createdAt ?? '') < Date.now() - 30 * 60_000)
    ));
    const completedAt = new Date().toISOString();
    const result = { error: 'The operation exceeded the 24-hour completion window.' };
    for (const command of stale) {
      command.status = 'failed';
      command.result = result;
      if (command.type === 'cloudflare.connector.sync') {
        const connector = this.connectors.find((item) => item.id === command.payload.connectorId && item.agentId === command.agentId && item.desiredRevision === command.payload.revision);
        if (connector) Object.assign(connector, { deploymentStatus: 'failed', lastError: result.error, updatedAt: completedAt });
      }
      if (command.type === 'stack.backup.create') {
        const backup = this.backups.find((item) => item.commandId === command.id && ['pending', 'running'].includes(item.status));
        if (backup) {
          Object.assign(backup, { status: 'failed', result, completedAt, updatedAt: completedAt });
          const stack = this.stacks.find((item) => item.id === backup.stackId);
          this.queueEvent('backup.failed', { agentId: backup.agentId, ...(stack ? { projectName: stack.projectName } : {}), backupId: backup.id, operation: 'backup', reason: 'stale' });
        }
      }
      if (command.type === 'stack.restore.apply') {
        const restore = this.restores.find((item) => item.commandId === command.id && ['pending', 'running'].includes(item.status));
        if (restore) {
          Object.assign(restore, { status: 'failed', result, completedAt, updatedAt: completedAt });
          const stack = this.stacks.find((item) => item.id === restore.stackId);
          this.queueEvent('backup.failed', { agentId: restore.agentId, ...(stack ? { projectName: stack.projectName } : {}), restoreId: restore.id, backupId: restore.backupId, operation: 'restore', reason: 'stale' });
        }
      }
      if (command.type === 'compose.runtime.action') {
        const operation = this.runtimeOperations.find((item) => item.commandId === command.id && ['pending', 'running'].includes(item.status));
        if (operation) { Object.assign(operation, { status: 'failed', result, error: result.error, completedAt, updatedAt: completedAt }); this.queueEvent('runtime.action.failed', { agentId: operation.agentId, projectName: operation.projectName, ...(operation.serviceName ? { serviceName: operation.serviceName } : {}), action: operation.action, scope: operation.scope }); }
      }
      if (command.type === 'compose.runtime.logs') {
        const request = this.runtimeLogRequests.find((item) => item.commandId === command.id && ['pending', 'running'].includes(item.status));
        if (request) Object.assign(request, { status: 'failed', result, error: result.error, completedAt, updatedAt: completedAt });
      }
      if (command.type === 'deployment.compose.apply') {
        const run = this.deploymentRuns.find((item) => item.commandId === command.id && ['pending', 'running'].includes(item.status));
        const target = run && this.deployments.find((item) => item.id === run.deploymentId);
        if (run) Object.assign(run, { status: 'failed', result, error: result.error, completedAt, updatedAt: completedAt });
        if (target) Object.assign(target, { status: 'failed', updatedAt: completedAt });
      }
    }
    return stale.length;
  }
  public async close(): Promise<void> {}

  private async acquireMutex(key: string): Promise<() => void> {
    const previous = this.mutexTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.mutexTails.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.mutexTails.get(key) === tail) this.mutexTails.delete(key);
    };
  }

  private queueConnectorSync(agentId: string, connectorId: string, revision: number): AgentCommand {
    const existing = this.commands.find((command) => command.agentId === agentId && command.type === 'cloudflare.connector.sync' && command.status === 'pending' && command.payload.connectorId === connectorId);
    if (existing) {
      existing.payload = { connectorId, revision };
      existing.createdAt = new Date().toISOString();
      return existing;
    }
    const command: AgentCommand & { createdAt: string } = { id: randomUUID(), agentId, type: 'cloudflare.connector.sync', payload: { connectorId, revision }, status: 'pending', createdAt: new Date().toISOString() };
    this.commands.push(command);
    return command;
  }

  private queueInternalSync(agentId: string, type: string, entityKey: string, entityId: string): AgentCommand {
    const existing = this.commands.find((command) => command.agentId === agentId && command.type === type && command.status === 'pending' && command.payload[entityKey] === entityId);
    if (existing) return existing;
    const command: AgentCommand & { createdAt: string } = { id: randomUUID(), agentId, type, payload: { [entityKey]: entityId }, status: 'pending', createdAt: new Date().toISOString() };
    this.commands.push(command);
    return command;
  }

  private hasActiveOperation(stackId: string): boolean {
    return this.backups.some((item) => item.stackId === stackId && ['pending', 'running'].includes(item.status))
      || this.restores.some((item) => item.stackId === stackId && ['pending', 'running'].includes(item.status));
  }

  private queueEvent(type: OperationalEventType, payload: Record<string, unknown>): void {
    const id = randomUUID();
    const occurredAt = new Date().toISOString();
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : null;
    const projectName = typeof payload.projectName === 'string' ? payload.projectName : null;
    const serviceName = typeof payload.serviceName === 'string' ? payload.serviceName : null;
    this.events.push({ id, type, agentId, projectName, serviceName, payload, occurredAt });
    const agentMuted = agentId && this.notificationScopes.some((scope) => scope.agentId === agentId && scope.projectName === null && !scope.enabled);
    const serviceMuted = agentId && serviceName && this.notificationScopes.some((scope) => scope.agentId === agentId && scope.projectName === projectName && scope.serviceName === serviceName && !scope.enabled);
    if (this.notificationSecrets && this.selectedEvents.includes(type) && !agentMuted && !serviceMuted) this.deliveries.push({ id: randomUUID(), eventId: id, eventType: type, payload, occurredAt, attempts: 0, status: 'pending', agentId, projectName, serviceName });
  }
}
