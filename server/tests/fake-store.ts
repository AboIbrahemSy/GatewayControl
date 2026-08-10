import { randomUUID } from 'node:crypto';
import type { Agent, AgentCommand, BackupTarget, CloudflareAccount, CloudflareAccountSecret, CloudflareHostnameDeployment, CloudflarePublicHostname, CloudflareZone, Connector, ConnectorDeployment, ManagedRoute, ManagedStack, NotificationDelivery, NotificationSettings, OperationalEventType, Role, StackBackup, StackDeployment, StackRestore, Store, TelemetrySnapshot, User } from '../src/types.js';

export class FakeStore implements Store {
  public users: User[] = [];
  public sessions = new Map<string, string>();
  public connectors: Array<Connector & { encryptedToken: string }> = [];
  public cloudflareAccounts: Array<CloudflareAccount & { encryptedApiToken: string }> = [];
  public cloudflareZones: CloudflareZone[] = [];
  public cloudflarePublicHostnames: CloudflarePublicHostname[] = [];
  public stacks: Array<ManagedStack & { encryptedComposeYaml: string }> = [];
  public routes: ManagedRoute[] = [];
  public agents: Array<Agent & { enrollmentTokenHash?: string; credentialHash?: string; archivedAt?: string }> = [];
  public commands: Array<AgentCommand & { createdAt?: string }> = [];
  public notificationSecrets: { botTokenEncrypted: string; groupIdEncrypted: string } | null = null;
  public selectedEvents: string[] = [];
  public telemetry: TelemetrySnapshot[] = [];
  public backups: StackBackup[] = [];
  public restores: StackRestore[] = [];
  public events: Array<{ id: string; type: OperationalEventType; payload: Record<string, unknown>; occurredAt: string }> = [];
  public deliveries: Array<NotificationDelivery & { status: 'pending' | 'dispatching' | 'succeeded' | 'failed'; error?: string }> = [];

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
  public async createConnector(name: string, encryptedToken: string, enabled: boolean, agentId: string, cloudflareAccountId?: string, tunnelId?: string): Promise<Connector | null> {
    if (!this.agents.some((agent) => agent.id === agentId && agent.enabled)) return null;
    if (cloudflareAccountId && !this.cloudflareAccounts.some((account) => account.id === cloudflareAccountId)) return null;
    const now = new Date().toISOString();
    const created = { id: randomUUID(), agentId, name, enabled, cloudflareAccountId: cloudflareAccountId ?? null, tunnelId: tunnelId ?? null, encryptedToken, createdAt: now, updatedAt: now };
    this.connectors.push(created);
    if (enabled) this.queueInternalSync(agentId, 'cloudflare.connector.sync', 'connectorId', created.id);
    const { encryptedToken: _, ...publicConnector } = created;
    return publicConnector;
  }
  public async updateConnector(id: string, values: { name?: string; encryptedToken?: string; enabled?: boolean; agentId?: string; cloudflareAccountId?: string | null; tunnelId?: string | null }): Promise<Connector | null> {
    const item = this.connectors.find((connector) => connector.id === id);
    if (!item) return null;
    const targetAgentId = values.agentId ?? item.agentId;
    if (!this.agents.some((agent) => agent.id === targetAgentId && agent.enabled)) return null;
    if (values.cloudflareAccountId && !this.cloudflareAccounts.some((account) => account.id === values.cloudflareAccountId)) return null;
    Object.assign(item, values, { updatedAt: new Date().toISOString() });
    this.queueInternalSync(item.agentId, 'cloudflare.connector.sync', 'connectorId', item.id);
    const { encryptedToken: _, ...publicConnector } = item;
    return publicConnector;
  }
  public async getConnectorDeployment(connectorId: string): Promise<ConnectorDeployment | null> {
    const item = this.connectors.find((connector) => connector.id === connectorId);
    return item ? { connectorId: item.id, agentId: item.agentId, name: item.name, enabled: item.enabled, encryptedToken: item.encryptedToken, cloudflareAccountId: item.cloudflareAccountId, tunnelId: item.tunnelId } : null;
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
  public async getCloudflareAccountSecret(id: string): Promise<CloudflareAccountSecret | null> {
    return this.cloudflareAccounts.find((account) => account.id === id) ?? null;
  }
  public async syncCloudflareZones(accountId: string, zones: Array<{ zoneIdentifier: string; name: string; status: string }>, error?: string): Promise<CloudflareZone[] | null> {
    const account = this.cloudflareAccounts.find((item) => item.id === accountId);
    if (!account) return null;
    const now = new Date().toISOString();
    Object.assign(account, error ? { lastError: error, lastErrorAt: now } : { lastSyncedAt: now, lastError: null, lastErrorAt: null }, { updatedAt: now });
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
  public async listCloudflarePublicHostnames(): Promise<CloudflarePublicHostname[]> { return this.cloudflarePublicHostnames; }
  public async createPendingCloudflarePublicHostname(values: { zoneId: string; connectorId: string; routeId: string; proxied: boolean }): Promise<CloudflarePublicHostname | null> {
    const zone = this.cloudflareZones.find((item) => item.id === values.zoneId);
    const account = zone && this.cloudflareAccounts.find((item) => item.id === zone.cloudflareAccountId && item.enabled);
    const connector = account && this.connectors.find((item) => item.id === values.connectorId && item.enabled && item.cloudflareAccountId === account.id && item.tunnelId);
    const route = this.routes.find((item) => item.id === values.routeId && item.enabled && item.exposure === 'tunnel');
    if (!zone || !account || !connector || !route || !(route.hostname === zone.name || route.hostname.endsWith(`.${zone.name}`)) || this.cloudflarePublicHostnames.some((item) => item.hostname === route.hostname || item.routeId === route.id)) return null;
    const now = new Date().toISOString();
    const created: CloudflarePublicHostname = {
      id: randomUUID(), cloudflareZoneId: zone.id, cloudflareAccountId: account.id, connectorId: connector.id,
      routeId: route.id, hostname: route.hostname, dnsRecordId: null, enabled: true, proxied: values.proxied,
      status: 'pending', lastError: null, createdAt: now, updatedAt: now,
    };
    this.cloudflarePublicHostnames.push(created);
    return created;
  }
  public async setCloudflarePublicHostnamePending(id: string, enabled: boolean): Promise<CloudflarePublicHostname | null> {
    const item = this.cloudflarePublicHostnames.find((hostname) => hostname.id === id);
    if (!item) return null;
    const isActiveNoOp = item.enabled === enabled && item.status === 'active';
    Object.assign(item, { enabled, status: isActiveNoOp ? 'active' : 'pending', lastError: isActiveNoOp ? item.lastError : null, updatedAt: new Date().toISOString() });
    return item;
  }
  public async getCloudflareHostnameDeployment(id: string): Promise<CloudflareHostnameDeployment | null> {
    const item = this.cloudflarePublicHostnames.find((hostname) => hostname.id === id);
    const account = item && this.cloudflareAccounts.find((candidate) => candidate.id === item.cloudflareAccountId);
    const zone = item && this.cloudflareZones.find((candidate) => candidate.id === item.cloudflareZoneId && candidate.cloudflareAccountId === item.cloudflareAccountId);
    const connector = item && this.connectors.find((candidate) => candidate.id === item.connectorId && candidate.cloudflareAccountId === item.cloudflareAccountId && candidate.tunnelId);
    return item && account && zone && connector?.tunnelId ? { ...item, accountIdentifier: account.accountIdentifier, encryptedApiToken: account.encryptedApiToken, zoneIdentifier: zone.zoneIdentifier, tunnelId: connector.tunnelId } : null;
  }
  public async markCloudflareHostnameOutcome(id: string, values: { status: 'active' | 'failed'; enabled: boolean; dnsRecordId?: string | null; lastError?: string | null }): Promise<CloudflarePublicHostname | null> {
    const item = this.cloudflarePublicHostnames.find((hostname) => hostname.id === id);
    if (!item) return null;
    Object.assign(item, values, { lastError: values.lastError ?? null, updatedAt: new Date().toISOString() });
    return item;
  }
  public async listStacks(): Promise<ManagedStack[]> { return this.stacks.map(({ encryptedComposeYaml: _, ...item }) => item); }
  public async createStack(values: { agentId: string; name: string; projectName: string; encryptedComposeYaml: string; enabled: boolean }): Promise<ManagedStack | null> {
    if (!this.agents.some((agent) => agent.id === values.agentId && agent.enabled)) return null;
    const now = new Date().toISOString();
    const created = { id: randomUUID(), ...values, configured: true, revision: 1, status: 'pending' as const, createdAt: now, updatedAt: now };
    this.stacks.push(created);
    this.queueInternalSync(created.agentId, 'compose.stack.sync', 'stackId', created.id);
    const { encryptedComposeYaml: _, ...publicStack } = created;
    return publicStack;
  }
  public async updateStack(id: string, values: { name?: string; encryptedComposeYaml?: string; enabled?: boolean }): Promise<ManagedStack | null> {
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
  public async listAgents(): Promise<Agent[]> { return this.agents.filter((item) => !item.archivedAt); }
  public async createAgent(name: string, enrollmentTokenHash: string): Promise<Agent> {
    const created = { id: randomUUID(), name, enabled: true, enrolledAt: null, lastHeartbeatAt: null, createdAt: new Date().toISOString(), enrollmentTokenHash };
    this.agents.push(created);
    return created;
  }
  public async removeAgent(id: string): Promise<'deleted' | 'archived' | 'blocked' | 'missing'> {
    const index = this.agents.findIndex((item) => item.id === id && !item.archivedAt);
    if (index < 0) return 'missing';
    const item = this.agents[index]!;
    const blocked = this.connectors.some((connector) => connector.agentId === id)
      || this.stacks.some((stack) => stack.agentId === id)
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
    return item;
  }
  public async authenticateAgent(credentialHash: string): Promise<Agent | null> { return this.agents.find((item) => item.credentialHash === credentialHash && item.enabled) ?? null; }
  public async heartbeatAgent(id: string): Promise<void> {
    const item = this.agents.find((agent) => agent.id === id);
    if (item) item.lastHeartbeatAt = new Date().toISOString();
  }
  public async recordTelemetry(agentId: string, snapshot: Omit<TelemetrySnapshot, 'agentId' | 'receivedAt'>): Promise<void> {
    const previous = this.telemetry.find((item) => item.agentId === agentId);
    const receivedAt = new Date().toISOString();
    this.telemetry.unshift({ agentId, ...snapshot, receivedAt });
    const agent = this.agents.find((item) => item.id === agentId);
    if (agent) agent.lastHeartbeatAt = receivedAt;
    const previousServices = new Map((previous?.services ?? []).map((service) => [service.name, service]));
    for (const service of snapshot.services) {
      if (service.status === 'unhealthy' && previousServices.get(service.name)?.status !== 'unhealthy') this.queueEvent('service.unhealthy', { service: service.name });
    }
  }
  public async getMonitoringSummary(): Promise<TelemetrySnapshot[]> {
    return [...new Map(this.telemetry.filter((item) => this.agents.some((agent) => agent.id === item.agentId && !agent.archivedAt)).map((item) => [item.agentId, item])).values()];
  }
  public async getAgentMonitoring(agentId: string): Promise<{ agent: Agent; latest: TelemetrySnapshot | null; history: TelemetrySnapshot[] } | null> {
    const found = this.agents.find((item) => item.id === agentId && !item.archivedAt);
    if (!found) return null;
    const history = this.telemetry.filter((item) => item.agentId === agentId).slice(0, 288);
    return { agent: found, latest: history[0] ?? null, history };
  }
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
  public async claimCommands(agentId: string, limit: number): Promise<AgentCommand[]> {
    const selected = this.commands.filter((item) => item.agentId === agentId && item.status === 'pending').slice(0, limit);
    selected.forEach((item) => {
      item.status = 'claimed';
      if (item.type === 'stack.backup.create') {
        const backup = this.backups.find((candidate) => candidate.id === item.payload.backupId);
        if (backup) backup.status = 'running';
      }
      if (item.type === 'stack.restore.apply') {
        const restore = this.restores.find((candidate) => candidate.id === item.payload.restoreId);
        if (restore) restore.status = 'running';
      }
    });
    return selected;
  }
  public async completeCommand(agentId: string, commandId: string, status: 'succeeded' | 'failed', result: Record<string, unknown>): Promise<'updated' | 'idempotent' | 'conflict' | 'missing'> {
    const item = this.commands.find((command) => command.id === commandId && command.agentId === agentId);
    if (!item) return 'missing';
    if (item.status === status && JSON.stringify(item.result) === JSON.stringify(result)) return 'idempotent';
    if (item.status !== 'claimed') return 'conflict';
    item.status = status;
    item.result = result;
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
    if (status === 'failed' && ['compose.stack.sync', 'traefik.route.sync', 'cloudflare.connector.sync'].includes(item.type)) this.queueEvent('deployment.failed', { commandId });
    if (item.type === 'stack.backup.create') {
      const backup = this.backups.find((candidate) => candidate.id === item.payload.backupId);
      if (backup) {
        Object.assign(backup, { status, result, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        this.queueEvent(status === 'succeeded' ? 'backup.succeeded' : 'backup.failed', { backupId: backup.id });
      }
    }
    if (item.type === 'stack.restore.apply') {
      const restore = this.restores.find((candidate) => candidate.id === item.payload.restoreId);
      if (restore) Object.assign(restore, { status, result, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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
  public async completeNotificationDelivery(id: string): Promise<void> {
    const found = this.deliveries.find((item) => item.id === id);
    if (found) found.status = 'succeeded';
  }
  public async retryNotificationDelivery(id: string, error: string, _delaySeconds: number, terminal: boolean): Promise<void> {
    const found = this.deliveries.find((item) => item.id === id);
    if (found) Object.assign(found, { status: terminal ? 'failed' : 'pending', error });
  }
  public async sweepOfflineAgents(_offlineBefore: Date): Promise<number> { return 0; }
  public async failStaleCommands(staleBefore: Date): Promise<number> {
    const stale = this.commands.filter((command) => ['stack.backup.create', 'stack.restore.apply'].includes(command.type)
      && ['pending', 'claimed'].includes(command.status) && Date.parse(command.createdAt ?? '') < staleBefore.getTime());
    const completedAt = new Date().toISOString();
    const result = { error: 'The operation exceeded the 24-hour completion window.' };
    for (const command of stale) {
      command.status = 'failed';
      command.result = result;
      if (command.type === 'stack.backup.create') {
        const backup = this.backups.find((item) => item.commandId === command.id && ['pending', 'running'].includes(item.status));
        if (backup) {
          Object.assign(backup, { status: 'failed', result, completedAt, updatedAt: completedAt });
          this.queueEvent('backup.failed', { backupId: backup.id, operation: 'backup', reason: 'stale' });
        }
      }
      if (command.type === 'stack.restore.apply') {
        const restore = this.restores.find((item) => item.commandId === command.id && ['pending', 'running'].includes(item.status));
        if (restore) {
          Object.assign(restore, { status: 'failed', result, completedAt, updatedAt: completedAt });
          this.queueEvent('backup.failed', { restoreId: restore.id, backupId: restore.backupId, operation: 'restore', reason: 'stale' });
        }
      }
    }
    return stale.length;
  }
  public async close(): Promise<void> {}

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
    this.events.push({ id, type, payload, occurredAt });
    if (this.selectedEvents.includes(type)) this.deliveries.push({ id: randomUUID(), eventId: id, eventType: type, payload, occurredAt, attempts: 0, status: 'pending' });
  }
}
