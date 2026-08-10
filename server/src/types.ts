export type Role = 'owner' | 'operator' | 'viewer';

export interface User {
  id: string;
  email: string;
  role: Role;
  passwordHash: string;
}

export interface Connector {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  cloudflareAccountId: string | null;
  tunnelId: string | null;
  deploymentStatus: 'pending' | 'deploying' | 'active' | 'failed' | 'stopped';
  runtimeStatus: 'unknown' | 'connected' | 'origin_unhealthy' | 'reconnecting' | 'stopped' | 'failed';
  lastError: string | null;
  lastDeployedAt: string | null;
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorDeployment {
  connectorId: string;
  agentId: string;
  name: string;
  enabled: boolean;
  encryptedToken: string;
  cloudflareAccountId: string | null;
  tunnelId: string | null;
}

export interface CloudflareAccount {
  id: string;
  name: string;
  accountIdentifier: string;
  configured: true;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudflareZone {
  id: string;
  cloudflareAccountId: string;
  zoneIdentifier: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudflarePublicHostname {
  id: string;
  cloudflareZoneId: string;
  cloudflareAccountId: string;
  connectorId: string;
  routeId: string;
  hostname: string;
  dnsRecordId: string | null;
  enabled: boolean;
  proxied: boolean;
  status: DeploymentStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudflareAccountSecret extends CloudflareAccount {
  encryptedApiToken: string;
}

export interface CloudflareHostnameDeployment extends CloudflarePublicHostname {
  accountIdentifier: string;
  encryptedApiToken: string;
  zoneIdentifier: string;
  tunnelId: string;
}

export type DeploymentStatus = 'pending' | 'active' | 'failed';

export interface ManagedStack {
  id: string;
  agentId: string;
  name: string;
  projectName: string;
  enabled: boolean;
  configured: boolean;
  revision: number;
  status: DeploymentStatus;
  postgresBackupConfig: { service: string; database: string; user: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface StackDeployment extends ManagedStack {
  encryptedComposeYaml: string;
}

export interface ManagedRoute {
  id: string;
  gatewayAgentId: string;
  name: string;
  hostname: string;
  exposure: 'tunnel' | 'public';
  backends: string[];
  enabled: boolean;
  revision: number;
  status: DeploymentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationSettings {
  configured: boolean;
  selectedEvents: string[];
}

export interface Agent {
  id: string;
  name: string;
  enabled: boolean;
  enrolledAt: string | null;
  lastHeartbeatAt: string | null;
  lastTelemetryAt: string | null;
  lastCommandPollAt: string | null;
  lastCommandResultAt: string | null;
  healthStatus: 'pending' | 'connected' | 'degraded' | 'offline';
  diagnostics: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentCommand {
  id: string;
  agentId: string;
  type: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'claimed' | 'succeeded' | 'failed';
  result?: Record<string, unknown> | null;
}

export const OPERATIONAL_EVENT_TYPES = ['agent.offline', 'service.unhealthy', 'deployment.failed', 'certificate.expiring', 'backup.failed', 'backup.succeeded'] as const;
export type OperationalEventType = typeof OPERATIONAL_EVENT_TYPES[number];
export type OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type BackupTarget = 'local' | 'nas';

export interface TelemetrySnapshot {
  agentId: string;
  observedAt: string;
  node: Record<string, unknown>;
  services: Array<Record<string, unknown>>;
  receivedAt: string;
}

export interface StackBackup {
  id: string;
  stackId: string;
  agentId: string;
  commandId: string;
  requestedByUserId: string;
  target: BackupTarget;
  stackRevision: number;
  status: OperationStatus;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface StackRestore {
  id: string;
  stackId: string;
  backupId: string;
  agentId: string;
  commandId: string;
  requestedByUserId: string;
  status: OperationStatus;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SystemBackup {
  id: string;
  requestedByUserId: string;
  target: BackupTarget;
  status: 'running' | 'succeeded' | 'failed';
  sizeBytes: number | null;
  checksum: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StoredSystemBackup extends SystemBackup {
  artifactPath: string;
}

export interface SystemRestore {
  id: string;
  backupId: string;
  requestedByUserId: string;
  status: 'staging' | 'staged' | 'failed';
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface NotificationDelivery {
  id: string;
  eventId: string;
  eventType: OperationalEventType;
  payload: Record<string, unknown>;
  occurredAt: string;
  attempts: number;
}

export interface Store {
  isSetupComplete(): Promise<boolean>;
  createOwner(email: string, passwordHash: string): Promise<User | null>;
  listUsers(): Promise<Omit<User, 'passwordHash'>[]>;
  createUser(email: string, passwordHash: string, role: Exclude<Role, 'owner'>): Promise<User>;
  findUserByEmail(email: string): Promise<User | null>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findSessionUser(tokenHash: string): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
  listConnectors(): Promise<Connector[]>;
  createConnector(name: string, encryptedToken: string, enabled: boolean, agentId: string, cloudflareAccountId?: string, tunnelId?: string): Promise<Connector | null>;
  updateConnector(id: string, values: { name?: string; encryptedToken?: string; enabled?: boolean; agentId?: string; cloudflareAccountId?: string | null; tunnelId?: string | null }): Promise<Connector | null>;
  getConnectorDeployment(connectorId: string): Promise<ConnectorDeployment | null>;
  listCloudflareAccounts(): Promise<CloudflareAccount[]>;
  createCloudflareAccount(values: { name: string; accountIdentifier: string; encryptedApiToken: string; enabled: boolean }): Promise<CloudflareAccount>;
  updateCloudflareAccount(id: string, values: { name?: string; accountIdentifier?: string; encryptedApiToken?: string; enabled?: boolean }): Promise<CloudflareAccount | null>;
  getCloudflareAccountSecret(id: string): Promise<CloudflareAccountSecret | null>;
  syncCloudflareZones(accountId: string, zones: Array<{ zoneIdentifier: string; name: string; status: string }>, error?: string): Promise<CloudflareZone[] | null>;
  listCloudflareZones(accountId: string): Promise<CloudflareZone[] | null>;
  listCloudflarePublicHostnames(): Promise<CloudflarePublicHostname[]>;
  createPendingCloudflarePublicHostname(values: { zoneId: string; connectorId: string; routeId: string; proxied: boolean }): Promise<CloudflarePublicHostname | null>;
  setCloudflarePublicHostnamePending(id: string, enabled: boolean): Promise<CloudflarePublicHostname | null>;
  getCloudflareHostnameDeployment(id: string): Promise<CloudflareHostnameDeployment | null>;
  markCloudflareHostnameOutcome(id: string, values: { status: 'active' | 'failed'; enabled: boolean; dnsRecordId?: string | null; lastError?: string | null }): Promise<CloudflarePublicHostname | null>;
  listStacks(): Promise<ManagedStack[]>;
  createStack(values: { agentId: string; name: string; projectName: string; encryptedComposeYaml: string; enabled: boolean; postgresBackupConfig?: { service: string; database: string; user: string } }): Promise<ManagedStack | null>;
  updateStack(id: string, values: { name?: string; encryptedComposeYaml?: string; enabled?: boolean; postgresBackupConfig?: { service: string; database: string; user: string } | null }): Promise<ManagedStack | null>;
  getStackDeployment(stackId: string): Promise<StackDeployment | null>;
  queueStackAction(stackId: string, type: 'compose.restart' | 'compose.stop'): Promise<AgentCommand | null>;
  listRoutes(): Promise<ManagedRoute[]>;
  createRoute(values: { gatewayAgentId: string; name: string; hostname: string; exposure: 'tunnel' | 'public'; backends: string[]; enabled: boolean }): Promise<ManagedRoute | null>;
  updateRoute(id: string, values: { gatewayAgentId?: string; name?: string; hostname?: string; exposure?: 'tunnel' | 'public'; backends?: string[]; enabled?: boolean }): Promise<ManagedRoute | null>;
  getRouteDeployment(routeId: string): Promise<ManagedRoute | null>;
  getNotificationSettings(): Promise<NotificationSettings>;
  getNotificationSecrets(): Promise<{ botTokenEncrypted: string; groupIdEncrypted: string } | null>;
  saveNotificationSettings(botTokenEncrypted: string, groupIdEncrypted: string, selectedEvents: string[]): Promise<void>;
  listAgents(): Promise<Agent[]>;
  createAgent(name: string, enrollmentTokenHash: string, enrollmentExpiresAt: Date): Promise<Agent>;
  removeAgent(id: string): Promise<'deleted' | 'archived' | 'blocked' | 'missing'>;
  enrollAgent(enrollmentTokenHash: string, credentialHash: string): Promise<Agent | null>;
  authenticateAgent(credentialHash: string): Promise<Agent | null>;
  heartbeatAgent(id: string, metadata: Record<string, unknown>): Promise<void>;
  recordTelemetry(agentId: string, snapshot: Omit<TelemetrySnapshot, 'agentId' | 'receivedAt'>): Promise<void>;
  getMonitoringSummary(): Promise<TelemetrySnapshot[]>;
  getAgentMonitoring(agentId: string): Promise<{ agent: Agent; latest: TelemetrySnapshot | null; history: TelemetrySnapshot[] } | null>;
  queueLogRequest(stackId: string, requestedByUserId: string, service: string, tail: number, since?: string): Promise<AgentCommand | null>;
  getLogRequest(commandId: string, requestedByUserId: string): Promise<AgentCommand | null>;
  createBackup(stackId: string, requestedByUserId: string, target: BackupTarget): Promise<StackBackup | 'active' | null>;
  listBackups(): Promise<StackBackup[]>;
  getBackupDeployment(backupId: string): Promise<{ backup: StackBackup; stack: StackDeployment } | null>;
  createRestore(backupId: string, requestedByUserId: string): Promise<StackRestore | 'active' | null>;
  listRestores(): Promise<StackRestore[]>;
  getRestoreDeployment(restoreId: string): Promise<{ restore: StackRestore; backup: StackBackup; stack: StackDeployment } | null>;
  createSystemBackup(requestedByUserId: string, target: BackupTarget, artifactPath: string): Promise<StoredSystemBackup>;
  completeSystemBackup(id: string, sizeBytes: number, checksum: string): Promise<SystemBackup>;
  failSystemBackup(id: string, error: string): Promise<SystemBackup>;
  listSystemBackups(): Promise<SystemBackup[]>;
  getSystemBackup(id: string): Promise<StoredSystemBackup | null>;
  createSystemRestore(backupId: string, requestedByUserId: string, status: 'staging' | 'failed', error?: string): Promise<SystemRestore>;
  updateSystemRestore(id: string, status: 'staged' | 'failed', error?: string): Promise<SystemRestore>;
  listSystemRestores(): Promise<SystemRestore[]>;
  claimNotificationDelivery(): Promise<NotificationDelivery | null>;
  completeNotificationDelivery(id: string): Promise<void>;
  retryNotificationDelivery(id: string, error: string, delaySeconds: number, terminal: boolean): Promise<void>;
  sweepOfflineAgents(offlineBefore: Date): Promise<number>;
  failStaleCommands(staleBefore: Date): Promise<number>;
  createCommand(agentId: string, type: string, payload: Record<string, unknown>): Promise<AgentCommand | null>;
  listCommands(agentId?: string): Promise<AgentCommand[]>;
  getCommand(id: string): Promise<AgentCommand | null>;
  claimCommands(agentId: string, limit: number): Promise<AgentCommand[]>;
  completeCommand(agentId: string, commandId: string, status: 'succeeded' | 'failed', result: Record<string, unknown>): Promise<'updated' | 'idempotent' | 'conflict' | 'missing'>;
  close(): Promise<void>;
}
