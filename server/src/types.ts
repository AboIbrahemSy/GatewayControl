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
  desiredRevision: number;
  tokenAccountIdentifier: string | null;
  tokenTunnelId: string | null;
  identityStatus: 'parsed' | 'pending' | 'verified' | 'unmatched' | 'mismatch' | 'invalid' | 'failed';
  identityVerifiedAt: string | null;
  identityError: string | null;
  deploymentStatus: 'pending' | 'deploying' | 'active' | 'failed' | 'stopping' | 'stopped';
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
  desiredRevision: number;
  encryptedToken: string;
  cloudflareAccountId: string | null;
  tunnelId: string | null;
  tokenAccountIdentifier: string | null;
  tokenTunnelId: string | null;
  identityStatus: Connector['identityStatus'];
}

export interface ConnectorIdentityDeployment extends ConnectorDeployment {
  identityStatus: Connector['identityStatus'];
}

export interface ConnectorIdentityExpectation {
  desiredRevision: number;
  encryptedToken: string;
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

export interface CloudflareAccountDeletionDependencies {
  connectors: number;
  domainAccess: number;
  guidedOperations: number;
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

export interface DomainAccessDnsRecord {
  type: 'A' | 'AAAA' | 'CNAME';
  content: string;
  cloudflareRecordId: string;
  ownershipMarker: string;
  status: 'active' | 'cleanup_pending' | 'deleted';
  lastError: string | null;
}

export interface CloudflareDomainAccess {
  id: string;
  cloudflareZoneId: string;
  cloudflareAccountId: string;
  connectorId: string | null;
  routeId: string;
  hostname: string;
  accessMethod: 'tunnel' | 'public_ip';
  publicIpv4: string[];
  publicIpv6: string[];
  ownedDnsRecords: DomainAccessDnsRecord[];
  dnsRecordId: string | null;
  enabled: boolean;
  revision: number;
  proxied: boolean;
  status: DeploymentStatus | 'disabled';
  lastError: string | null;
  lastReconciledAt: string | null;
  tlsStatus: 'not_observed' | 'valid' | 'expiring' | 'expired' | 'error';
  tlsIssuer: string | null;
  tlsValidTo: string | null;
  tlsObservedAt: string | null;
  tlsError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuidedOperation {
  id: string;
  kind: 'cloudflare_bootstrap' | 'domain_publish';
  idempotencyKey: string;
  requestedByUserId: string;
  requestHash: string;
  encryptedRequest: string | null;
  status: 'pending' | 'waiting' | 'succeeded' | 'failed';
  stage: string;
  cloudflareAccountId: string | null;
  connectorId: string | null;
  routeId: string | null;
  domainAccessId: string | null;
  remoteTunnelId: string | null;
  remoteTunnelName: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  verificationDeadlineAt: string | null;
  verificationAttempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TlsObservationTarget {
  domainAccessId: string;
  hostname: string;
  agentId: string;
}

export interface TlsObservation {
  status: 'valid' | 'expiring' | 'expired' | 'error';
  issuer?: string;
  validTo?: string;
  error?: string;
}

export type CloudflarePublicHostname = CloudflareDomainAccess;

export interface CloudflareAccountSecret extends CloudflareAccount {
  encryptedApiToken: string;
}

export interface CloudflareDomainAccessDeployment extends CloudflareDomainAccess {
  accountIdentifier: string;
  encryptedApiToken: string;
  zoneIdentifier: string;
  zoneName: string;
  zoneStatus: string;
  zoneAccountId: string;
  accountEnabled: boolean;
  routeEnabled: boolean;
  routeStatus: DeploymentStatus;
  routeExposure: 'tunnel' | 'public';
  routeAgentId: string;
  routeHostname: string;
  connectorEnabled: boolean | null;
  connectorAgentId: string | null;
  connectorAccountId: string | null;
  connectorIdentityStatus: Connector['identityStatus'] | null;
  connectorTokenAccountIdentifier: string | null;
  connectorTokenTunnelId: string | null;
  tunnelId: string | null;
}

export type CloudflareHostnameDeployment = CloudflareDomainAccessDeployment;

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

export interface NotificationServicePreference {
  projectName: string;
  serviceName: string;
  status: RuntimeServiceStatus;
  discovered: boolean;
  enabled: boolean;
  inherited: boolean;
  directlyEnabled: boolean;
}

export interface NotificationAgentPreference {
  id: string;
  name: string;
  healthStatus: Agent['healthStatus'];
  lastTelemetryAt: string | null;
  enabled: boolean;
  services: NotificationServicePreference[];
}

export interface NotificationTopology extends NotificationSettings {
  agents: NotificationAgentPreference[];
  truncated: {
    agents: boolean;
    services: boolean;
    scopes: boolean;
  };
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

export interface DeploymentRevision {
  id: string; deploymentId: string; commitSha: string; composePath: string; checksum: string; policyVersion: number;
  policyResult: { services: Array<{ name: string; image: string; digestPinned: boolean; healthcheck: boolean }>; warnings: Array<{ code: string; service?: string }> };
  createdByUserId: string; createdAt: string;
}

export interface Deployment {
  id: string; agentId: string; displayName: string; projectName: string; sourceRepository: string; enabled: boolean;
  currentRevisionId: string | null; status: 'pending' | 'deploying' | 'active' | 'stopping' | 'stopped' | 'failed';
  revisions: DeploymentRevision[]; latestRun: DeploymentRun | null; createdAt: string; updatedAt: string;
}

export interface DeploymentRun {
  id: string; deploymentId: string; revisionId: string; priorRevisionId: string | null; agentId: string;
  commandId: string; action: 'deploy' | 'rollback' | 'stop'; status: OperationStatus; result: Record<string, unknown> | null;
  error: string | null; startedAt: string | null; completedAt: string | null; createdAt: string; updatedAt: string;
}

export interface DeploymentCommandSource extends DeploymentRevision {
  agentId: string; projectName: string; encryptedNormalizedCompose: string; priorRevisionId: string | null;
  encryptedPriorNormalizedCompose: string | null; action: DeploymentRun['action']; runId: string; commandId: string;
}

export const OPERATIONAL_EVENT_TYPES = ['agent.offline', 'agent.recovered', 'service.unhealthy', 'service.stopped', 'service.recovered', 'deployment.failed', 'deployment.succeeded', 'certificate.expiring', 'backup.failed', 'backup.succeeded', 'runtime.action.succeeded', 'runtime.action.failed'] as const;
export type OperationalEventType = typeof OPERATIONAL_EVENT_TYPES[number];
const OPERATIONAL_EVENT_TYPE_SET = new Set<string>(OPERATIONAL_EVENT_TYPES);

export function sanitizeOperationalEventTypes(value: unknown): OperationalEventType[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is OperationalEventType => typeof item === 'string' && OPERATIONAL_EVENT_TYPE_SET.has(item)))];
}
export type OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type BackupTarget = 'local' | 'nas';
export type RuntimeServiceStatus = 'healthy' | 'unhealthy' | 'starting' | 'completed' | 'running' | 'stopped' | 'unknown';

export interface TelemetrySnapshot {
  agentId: string;
  observedAt: string;
  node: Record<string, unknown>;
  services: Array<Record<string, unknown>>;
  receivedAt: string;
}

export type RuntimeAction = 'start' | 'stop' | 'restart';
export type RuntimeScope = 'project' | 'service';
export interface RuntimeOperation {
  id: string; requestedByUserId: string; agentId: string; commandId: string | null;
  action: RuntimeAction; scope: RuntimeScope; projectName: string; serviceName: string | null;
  status: OperationStatus; result: Record<string, unknown> | null; error: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface RuntimeLogRequest {
  id: string; requestedByUserId: string; agentId: string; commandId: string | null;
  projectName: string; serviceName: string; tail: number; since: string | null;
  status: OperationStatus; result: Record<string, unknown> | null; error: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface RuntimeInventory {
  agent: Agent;
  latest: TelemetrySnapshot | null;
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
  source?: 'created' | 'imported';
  metadata?: Record<string, unknown>;
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

export interface SystemBackupImport {
  id: string;
  requestedByUserId: string;
  status: 'uploading' | 'uploaded' | 'validating' | 'imported' | 'rejected';
  quarantinePath: string;
  sizeBytes: number | null;
  checksum: string | null;
  backupId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  validationRevision: number;
}

export interface NotificationDelivery {
  id: string;
  eventId: string;
  eventType: OperationalEventType;
  payload: Record<string, unknown>;
  occurredAt: string;
  attempts: number;
  agentId: string | null;
  projectName: string | null;
  serviceName: string | null;
}

export interface Store {
  checkReady(): Promise<void>;
  isSetupComplete(): Promise<boolean>;
  createOwner(email: string, passwordHash: string): Promise<User | null>;
  listUsers(): Promise<Omit<User, 'passwordHash'>[]>;
  createUser(email: string, passwordHash: string, role: Exclude<Role, 'owner'>): Promise<User>;
  findUserByEmail(email: string): Promise<User | null>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findSessionUser(tokenHash: string): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
  listConnectors(): Promise<Connector[]>;
  createConnector(values: { name: string; encryptedToken: string; enabled: boolean; agentId: string; accountId?: string; accountIdentifier: string; tunnelId: string; identityStatus: Connector['identityStatus']; identityError?: string }): Promise<Connector | null>;
  updateConnector(id: string, values: { name?: string; encryptedToken?: string; enabled?: boolean; agentId?: string; accountId?: string; accountIdentifier?: string; tunnelId?: string }): Promise<Connector | null>;
  getConnectorDeployment(connectorId: string): Promise<ConnectorDeployment | null>;
  getCloudflareAccountSecretByIdentifier(accountIdentifier: string): Promise<CloudflareAccountSecret | null>;
  listConnectorIdentityDeployments(limit: number): Promise<ConnectorIdentityDeployment[]>;
  markConnectorIdentity(id: string, expected: ConnectorIdentityExpectation, values: { status: Connector['identityStatus']; accountId?: string; accountIdentifier?: string; tunnelId?: string; error?: string }): Promise<Connector | null>;
  listCloudflareAccounts(): Promise<CloudflareAccount[]>;
  createCloudflareAccount(values: { name: string; accountIdentifier: string; encryptedApiToken: string; enabled: boolean }): Promise<CloudflareAccount>;
  updateCloudflareAccount(id: string, values: { name?: string; accountIdentifier?: string; encryptedApiToken?: string; enabled?: boolean }): Promise<CloudflareAccount | null>;
  deleteCloudflareAccount(id: string): Promise<{ deleted: true; dependencies: CloudflareAccountDeletionDependencies } | { deleted: false; dependencies: CloudflareAccountDeletionDependencies } | null>;
  getCloudflareAccountSecret(id: string): Promise<CloudflareAccountSecret | null>;
  syncCloudflareZones(accountId: string, zones: Array<{ zoneIdentifier: string; name: string; status: string }>, error?: string): Promise<CloudflareZone[] | null>;
  listCloudflareZones(accountId: string): Promise<CloudflareZone[] | null>;
  listCloudflareDomainAccess(): Promise<CloudflareDomainAccess[]>;
  createOrGetGuidedOperation(values: { kind: GuidedOperation['kind']; idempotencyKey: string; requestedByUserId: string; requestHash: string; encryptedRequest: string }): Promise<{ operation: GuidedOperation; created: boolean }>;
  updateGuidedOperation(id: string, values: { status?: GuidedOperation['status']; stage?: string; accountId?: string; connectorId?: string; routeId?: string; domainAccessId?: string; remoteTunnelId?: string; remoteTunnelName?: string; result?: Record<string, unknown>; error?: string | null; clearEncryptedRequest?: boolean; verificationDeadlineAt?: string; incrementVerificationAttempts?: boolean }): Promise<GuidedOperation | null>;
  getGuidedOperation(id: string): Promise<GuidedOperation | null>;
  listGuidedOperationsPendingVerification(limit: number): Promise<GuidedOperation[]>;
  withGuidedOperationLock<T>(kind: GuidedOperation['kind'], requestedByUserId: string, idempotencyKey: string, callback: () => Promise<T>): Promise<T>;
  listTlsObservationTargets(limit: number): Promise<TlsObservationTarget[]>;
  saveTlsObservation(domainAccessId: string, observation: TlsObservation): Promise<void>;
  withDomainAccessLock<T>(id: string, callback: () => Promise<T>): Promise<T>;
  hasEnabledDomainAccessDependency(dependency: 'account' | 'connector' | 'route', id: string): Promise<boolean>;
  createPendingDomainAccess(values: { accountId: string; zoneId: string; routeId: string; accessMethod: 'tunnel' | 'public_ip'; connectorId?: string; publicIpv4: string[]; publicIpv6: string[]; proxied: boolean }): Promise<CloudflareDomainAccess | null>;
  setDomainAccessPending(id: string, enabled?: boolean): Promise<CloudflareDomainAccess | null>;
  getCloudflareDomainAccessDeployment(id: string): Promise<CloudflareDomainAccessDeployment | null>;
  saveDomainAccessDnsRecord(id: string, revision: number, record: Pick<DomainAccessDnsRecord, 'type' | 'content' | 'cloudflareRecordId' | 'ownershipMarker'>): Promise<CloudflareDomainAccess | null>;
  markDomainAccessDnsRecordStatus(id: string, revision: number, cloudflareRecordId: string, status: 'cleanup_pending' | 'deleted', lastError?: string): Promise<boolean>;
  markDomainAccessOutcome(id: string, revision: number, values: { status: 'pending' | 'active' | 'failed' | 'disabled'; lastError?: string | null }): Promise<CloudflareDomainAccess | null>;
  listStacks(): Promise<ManagedStack[]>;
  createStack(values: { agentId: string; name: string; projectName: string; encryptedComposeYaml: string; enabled: boolean; postgresBackupConfig?: { service: string; database: string; user: string } }): Promise<ManagedStack | null>;
  updateStack(id: string, values: { name?: string; encryptedComposeYaml?: string; enabled?: boolean; postgresBackupConfig?: { service: string; database: string; user: string } | null }): Promise<ManagedStack | null>;
  getStackDeployment(stackId: string): Promise<StackDeployment | null>;
  queueStackAction(stackId: string, type: 'compose.restart' | 'compose.stop'): Promise<AgentCommand | null>;
  listDeployments(): Promise<Deployment[]>;
  createDeployment(values: { agentId: string; displayName: string; projectName: string; sourceRepository: string; commitSha: string; composePath: string; encryptedSourceCompose: string; encryptedNormalizedCompose: string; checksum: string; policyVersion: number; policyResult: DeploymentRevision['policyResult']; requestedByUserId: string }): Promise<Deployment | null>;
  createDeploymentRevision(deploymentId: string, values: { sourceRepository: string; commitSha: string; composePath: string; encryptedSourceCompose: string; encryptedNormalizedCompose: string; checksum: string; policyVersion: number; policyResult: DeploymentRevision['policyResult']; requestedByUserId: string }): Promise<DeploymentRevision | null>;
  createDeploymentRun(deploymentId: string, revisionId: string, action: DeploymentRun['action'], requestedByUserId: string): Promise<DeploymentRun | 'active' | null>;
  getDeploymentRun(id: string): Promise<DeploymentRun | null>;
  getDeploymentCommandSource(runId: string): Promise<DeploymentCommandSource | null>;
  listRoutes(): Promise<ManagedRoute[]>;
  createRoute(values: { gatewayAgentId: string; name: string; hostname: string; exposure: 'tunnel' | 'public'; backends: string[]; enabled: boolean }): Promise<ManagedRoute | null>;
  updateRoute(id: string, values: { gatewayAgentId?: string; name?: string; hostname?: string; exposure?: 'tunnel' | 'public'; backends?: string[]; enabled?: boolean }): Promise<ManagedRoute | null>;
  getRouteDeployment(routeId: string): Promise<ManagedRoute | null>;
  getNotificationSettings(): Promise<NotificationSettings>;
  getNotificationSecrets(): Promise<{ botTokenEncrypted: string; groupIdEncrypted: string } | null>;
  saveNotificationSettings(botTokenEncrypted: string, groupIdEncrypted: string, selectedEvents: string[]): Promise<void>;
  getNotificationTopology(): Promise<NotificationTopology>;
  setAgentNotificationPreference(agentId: string, enabled: boolean, updatedByUserId: string): Promise<NotificationAgentPreference | null>;
  setServiceNotificationPreference(agentId: string, projectName: string, serviceName: string, enabled: boolean, updatedByUserId: string): Promise<NotificationServicePreference | null>;
  listAgents(): Promise<Agent[]>;
  createAgent(name: string, enrollmentTokenHash: string, enrollmentExpiresAt: Date): Promise<Agent>;
  removeAgent(id: string): Promise<'deleted' | 'archived' | 'blocked' | 'missing'>;
  enrollAgent(enrollmentTokenHash: string, credentialHash: string): Promise<Agent | null>;
  authenticateAgent(credentialHash: string): Promise<Agent | null>;
  heartbeatAgent(id: string, metadata: Record<string, unknown>): Promise<void>;
  recordTelemetry(agentId: string, snapshot: Omit<TelemetrySnapshot, 'agentId' | 'receivedAt'>): Promise<void>;
  getMonitoringSummary(): Promise<TelemetrySnapshot[]>;
  getAgentMonitoring(agentId: string): Promise<{ agent: Agent; latest: TelemetrySnapshot | null; history: TelemetrySnapshot[] } | null>;
  getLatestRuntimeInventory(): Promise<RuntimeInventory[]>;
  createRuntimeOperation(values: { requestedByUserId: string; agentId: string; action: RuntimeAction; scope: RuntimeScope; projectName: string; serviceName?: string }): Promise<RuntimeOperation | 'active' | null>;
  listRuntimeOperations(): Promise<RuntimeOperation[]>;
  getRuntimeOperation(id: string): Promise<RuntimeOperation | null>;
  createRuntimeLogRequest(values: { requestedByUserId: string; agentId: string; projectName: string; serviceName: string; tail: number; since?: string }): Promise<RuntimeLogRequest | null>;
  getRuntimeLogRequest(id: string, requestedByUserId?: string): Promise<RuntimeLogRequest | null>;
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
  importSystemBackup(values: { id: string; requestedByUserId: string; artifactPath: string; sizeBytes: number; checksum: string; importId: string }): Promise<'created' | 'idempotent' | 'conflict'>;
  createSystemBackupImport(requestedByUserId: string, quarantinePath: string): Promise<SystemBackupImport | 'active'>;
  updateSystemBackupImport(id: string, status: SystemBackupImport['status'], values?: { sizeBytes?: number; checksum?: string; backupId?: string; error?: string }): Promise<SystemBackupImport>;
  claimSystemBackupImport(id: string, requestedByUserId: string): Promise<SystemBackupImport | 'validating' | null>;
  finishSystemBackupImport(id: string, validationRevision: number, status: 'imported' | 'rejected', values?: { backupId?: string; error?: string }): Promise<SystemBackupImport | null>;
  getSystemBackupImport(id: string): Promise<SystemBackupImport | null>;
  listSystemBackupImports(): Promise<SystemBackupImport[]>;
  rejectStaleSystemBackupImports(before: Date): Promise<SystemBackupImport[]>;
  recordSystemBackupTransferEvent(values: { requestedByUserId: string; operation: 'export' | 'import' | 'restore_apply_requested'; backupId?: string; restoreId?: string; importId?: string; metadata?: Record<string, unknown> }): Promise<void>;
  createSystemRecoveryRequest(restoreId: string, requestedByUserId: string, ownershipToken: string): Promise<{ id: string; ownershipToken: string } | 'active'>;
  finishSystemRecoveryRequest(id: string, ownershipToken: string, status: 'published' | 'failed', error?: string): Promise<boolean>;
  createSystemRestore(backupId: string, requestedByUserId: string, status: 'staging' | 'failed', error?: string): Promise<SystemRestore>;
  updateSystemRestore(id: string, status: 'staged' | 'failed', error?: string): Promise<SystemRestore>;
  listSystemRestores(): Promise<SystemRestore[]>;
  getSystemRestore(id: string): Promise<SystemRestore | null>;
  claimNotificationDelivery(): Promise<NotificationDelivery | null>;
  isNotificationDeliveryEnabled(delivery: NotificationDelivery): Promise<boolean>;
  skipNotificationDelivery(id: string): Promise<void>;
  completeNotificationDelivery(id: string): Promise<void>;
  retryNotificationDelivery(id: string, error: string, delaySeconds: number, terminal: boolean): Promise<void>;
  sweepOfflineAgents(offlineBefore: Date): Promise<number>;
  failStaleCommands(staleBefore: Date): Promise<number>;
  purgeRuntimeLogResults(completedBefore: Date): Promise<number>;
  createCommand(agentId: string, type: string, payload: Record<string, unknown>): Promise<AgentCommand | null>;
  listCommands(agentId?: string): Promise<AgentCommand[]>;
  getCommand(id: string): Promise<AgentCommand | null>;
  claimCommands(agentId: string, limit: number): Promise<AgentCommand[]>;
  completeCommand(agentId: string, commandId: string, status: 'succeeded' | 'failed', result: Record<string, unknown>): Promise<'updated' | 'idempotent' | 'conflict' | 'missing'>;
  close(): Promise<void>;
}
