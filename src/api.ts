export type Role = 'owner' | 'operator' | 'viewer'

export type User = {
  id: string
  email: string
  role: Role
}

export type Connector = {
  id: string
  agentId: string
  name: string
  enabled: boolean
  cloudflareAccountId: string | null
  tunnelId: string | null
  desiredRevision: number
  tokenAccountIdentifier: string | null
  tokenTunnelId: string | null
  identityStatus: 'parsed' | 'pending' | 'verified' | 'unmatched' | 'mismatch' | 'invalid' | 'failed'
  identityVerifiedAt: string | null
  identityError: string | null
  deploymentStatus: 'pending' | 'deploying' | 'active' | 'failed' | 'stopping' | 'stopped'
  runtimeStatus: 'unknown' | 'connected' | 'origin_unhealthy' | 'reconnecting' | 'stopped' | 'failed'
  lastError: string | null
  lastDeployedAt: string | null
  lastObservedAt: string | null
  createdAt?: string
  updatedAt?: string
}

export type CloudflareAccount = {
  id: string
  name: string
  accountIdentifier: string
  configured: true
  enabled: boolean
  lastSyncedAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type CloudflareZone = {
  id: string
  cloudflareAccountId: string
  zoneIdentifier: string
  name: string
  status: string
  createdAt: string
  updatedAt: string
}

export type DomainAccessDnsRecord = {
  type: 'A' | 'AAAA' | 'CNAME'
  content: string
  cloudflareRecordId: string
  status: 'active' | 'deleted'
}

export type CloudflareDomainAccess = {
  id: string
  cloudflareZoneId: string
  cloudflareAccountId: string
  connectorId: string | null
  routeId: string
  hostname: string
  accessMethod: 'tunnel' | 'public_ip'
  publicIpv4: string[]
  publicIpv6: string[]
  ownedDnsRecords: DomainAccessDnsRecord[]
  dnsRecordId: string | null
  enabled: boolean
  proxied: boolean
  status: DeploymentStatus | 'disabled'
  lastError: string | null
  lastReconciledAt: string | null
  tlsStatus: 'not_observed' | 'valid' | 'expiring' | 'expired' | 'error'
  tlsIssuer: string | null
  tlsValidTo: string | null
  tlsObservedAt: string | null
  tlsError: string | null
  createdAt: string
  updatedAt: string
}

export type GuidedOperation = {
  id: string
  kind: 'cloudflare_bootstrap' | 'domain_publish'
  status: 'pending' | 'waiting' | 'succeeded' | 'failed'
  stage: string
  routeId: string | null
  domainAccessId: string | null
  error: string | null
}

export type CloudflarePublicHostname = CloudflareDomainAccess

export type Agent = {
  id: string
  name: string
  enrolledAt?: string | null
  enrollmentExpiresAt?: string | null
  lastHeartbeatAt?: string | null
  lastTelemetryAt?: string | null
  lastCommandPollAt?: string | null
  lastCommandResultAt?: string | null
  healthStatus: 'pending' | 'connected' | 'degraded' | 'offline'
  diagnostics?: { checks?: Record<string, { state?: 'ready' | 'failed' | 'not_configured'; detail?: string }> } | null
  enabled?: boolean
  metadata?: unknown
  createdAt?: string
}

export type TelegramSettings = {
  configured: boolean
  selectedEvents: string[]
}

export type NotificationServicePreference = {
  projectName: string
  serviceName: string
  status: RuntimeServiceStatus
  discovered: boolean
  enabled: boolean
  inherited: boolean
  directlyEnabled: boolean
}

export type NotificationAgentPreference = {
  id: string
  name: string
  healthStatus: Agent['healthStatus']
  lastTelemetryAt: string | null
  enabled: boolean
  services: NotificationServicePreference[]
}

export type NotificationTopology = TelegramSettings & {
  agents: NotificationAgentPreference[]
  truncated: { agents: boolean; services: boolean; scopes: boolean }
}

export type DeploymentStatus = 'pending' | 'active' | 'failed'
export type CommandStatus = 'pending' | 'claimed' | 'succeeded' | 'failed'
export type OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed'
export type RuntimeServiceStatus = 'healthy' | 'unhealthy' | 'starting' | 'completed' | 'running' | 'stopped' | 'unknown'

export type ManagedStack = {
  id: string
  agentId: string
  name: string
  projectName: string
  enabled: boolean
  configured: boolean
  revision: number
  status: DeploymentStatus
  postgresBackupConfig: { service: string; database: string; user: string } | null
  createdAt: string
  updatedAt: string
}

export type ManagedRoute = {
  id: string
  gatewayAgentId: string
  name: string
  hostname: string
  exposure: 'tunnel' | 'public'
  backends: string[]
  enabled: boolean
  revision: number
  status: DeploymentStatus
  createdAt: string
  updatedAt: string
}

export type TelemetryNode = {
  uptimeSeconds: number
  load1: number
  load5: number
  load15: number
  memoryTotalBytes: number
  memoryAvailableBytes: number
}

export type TelemetryService = {
  name: string
  status: RuntimeServiceStatus
  projectName: string
  serviceName: string
  total: number
  running: number
  healthy: number
  unhealthy: number
  starting: number
  stopped: number
  completed: number
}

export type RuntimeService = Omit<TelemetryService, 'name' | 'projectName' | 'serviceName'> & { name: string }
export type RuntimeProject = {
  agentId: string; agentName: string; projectName: string; observedAt: string; receivedAt: string
  stale: boolean; protected: boolean; actionable: boolean; status: RuntimeServiceStatus; services: RuntimeService[]
}
export type RuntimeOperation = {
  id: string; agentId: string; action: 'start' | 'stop' | 'restart'; scope: 'project' | 'service'
  projectName: string; serviceName: string | null; status: OperationStatus; result: Record<string, unknown> | null
  error: string | null; createdAt: string; updatedAt: string; completedAt: string | null
}

export type DeploymentRevision = {
  id: string; deploymentId: string; commitSha: string; composePath: string; checksum: string; policyVersion: number
  policyResult: { services: Array<{ name: string; image: string; digestPinned: boolean; healthcheck: boolean }>; warnings: Array<{ code: string; service?: string }> }
  createdByUserId: string; createdAt: string
}
export type DeploymentRun = {
  id: string; deploymentId: string; revisionId: string; priorRevisionId: string | null; agentId: string; commandId: string
  action: 'deploy' | 'rollback' | 'stop'; status: OperationStatus; result: Record<string, unknown> | null; error: string | null
  startedAt: string | null; completedAt: string | null; createdAt: string; updatedAt: string
}
export type Deployment = {
  id: string; agentId: string; displayName: string; projectName: string; sourceRepository: string; enabled: boolean
  currentRevisionId: string | null; status: 'pending' | 'deploying' | 'active' | 'stopping' | 'stopped' | 'failed'
  revisions: DeploymentRevision[]; latestRun: DeploymentRun | null; createdAt: string; updatedAt: string
}
export type DeploymentSourceInput = { repository: string; commitSha: string; composePath: string; projectName: string; parameters?: Record<string, string | number | boolean> }
export type DeploymentPreview = { source: { repository: string; commitSha: string; composePath: string }; policy: { policyVersion: number; checksum: string; services: DeploymentRevision['policyResult']['services']; warnings: DeploymentRevision['policyResult']['warnings'] } }
export type RuntimeLogRequest = {
  id: string; agentId: string; projectName: string; serviceName: string; tail: number; since: string | null
  status: OperationStatus; result: null | { logs?: string; truncated?: boolean }; error: string | null
}

export type TelemetrySnapshot = {
  agentId: string
  observedAt: string
  receivedAt: string
  node: TelemetryNode
  services: TelemetryService[]
}

export type StackCommand = {
  id: string
  status: CommandStatus
}

export type LogRequest = {
  id: string
  status: CommandStatus
  result: null | { logs: string; truncated: boolean }
}

export type BackupResult = {
  sizeBytes?: number
  fileCount?: number
  durationMs?: number
  checksum?: string
  startedAt?: string
  completedAt?: string
  message?: string
  artifacts?: Array<{ type: 'volume_archive' | 'postgres_dump'; name: string; sizeBytes: number; sha256: string }>
}

export type StackBackup = {
  id: string
  stackId: string
  agentId: string
  commandId: string
  target: 'local' | 'nas'
  stackRevision: number
  status: OperationStatus
  result: BackupResult | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type StackRestore = {
  id: string
  stackId: string
  backupId: string
  agentId: string
  commandId: string
  status: OperationStatus
  result: BackupResult | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type SystemBackup = {
  id: string
  target: 'local' | 'nas'
  status: 'running' | 'succeeded' | 'failed'
  sizeBytes: number | null
  checksum: string | null
  error: string | null
  createdAt: string
  completedAt: string | null
  source: 'created' | 'imported'
  metadata: Record<string, unknown>
}

export type SystemBackupImport = {
  id: string
  status: 'uploading' | 'uploaded' | 'validating' | 'imported' | 'rejected'
  sizeBytes: number | null
  checksum: string | null
  backupId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type SystemRestore = {
  id: string
  backupId: string
  status: 'staging' | 'staged' | 'failed'
  error: string | null
  createdAt: string
  completedAt: string | null
}

export type CreateStackInput = Pick<ManagedStack, 'agentId' | 'name' | 'projectName' | 'enabled'> & { composeYaml: string; postgresBackupConfig?: ManagedStack['postgresBackupConfig'] }
export type UpdateStackInput = Partial<Pick<ManagedStack, 'name' | 'enabled' | 'postgresBackupConfig'>> & { composeYaml?: string }
export type CreateRouteInput = Pick<ManagedRoute, 'gatewayAgentId' | 'name' | 'hostname' | 'exposure' | 'backends' | 'enabled'>
export type UpdateRouteInput = Partial<CreateRouteInput>
export type CreateConnectorInput = Pick<Connector, 'agentId' | 'name' | 'enabled'> & { token: string }
export type UpdateConnectorInput = Partial<Pick<Connector, 'agentId' | 'name' | 'enabled'>> & { token?: string }
export type CreateCloudflareAccountInput = Pick<CloudflareAccount, 'name' | 'accountIdentifier' | 'enabled'> & { apiToken: string; createManagedTunnel?: boolean; agentId?: string; connectorName?: string }
export type UpdateCloudflareAccountInput = Partial<Pick<CloudflareAccount, 'name' | 'accountIdentifier' | 'enabled'>> & { apiToken?: string }
export type CreateCloudflareDomainAccessInput = Pick<CloudflareDomainAccess, 'routeId' | 'accessMethod' | 'proxied'> & {
  accountId: string
  zoneId: string
  connectorId?: string
  publicIpv4?: string[]
  publicIpv6?: string[]
}

export class ApiError extends Error {
  public constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    let message = 'The request could not be completed.'
    let code: string | undefined

    try {
      const body = (await response.json()) as { error?: unknown; code?: unknown }
      if (typeof body.error === 'string' && body.error.length <= 500) {
        message = body.error
      }
      if (typeof body.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(body.code)) code = body.code
    } catch {
      // Do not expose proxy responses or untrusted HTML as application errors.
    }

    throw new ApiError(response.status, message, code)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export const api = {
  setupStatus: () => request<{ setupComplete: boolean }>('/setup/status'),
  setup: (email: string, password: string) =>
    request<{ user: User }>('/setup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    request<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<{ user: User }>('/auth/me'),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  configuration: () => request<{ agentImage: string; recoverySupervisorEnabled: boolean }>('/configuration'),
  connectors: () => request<{ connectors: Connector[] }>('/connectors'),
  createConnector: (input: CreateConnectorInput) =>
    request<{ connector: Connector }>('/connectors', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateConnector: (id: string, input: UpdateConnectorInput) =>
    request<{ connector: Connector }>(`/connectors/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  verifyConnector: (id: string) =>
    request<{ connector: Connector }>(`/connectors/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
  cloudflareAccounts: () => request<{ accounts: CloudflareAccount[] }>('/cloudflare/accounts'),
  createCloudflareAccount: (input: CreateCloudflareAccountInput) =>
    request<{ account: CloudflareAccount; zoneCount?: number; tunnel?: { id: string; name: string }; connector?: Connector; operation?: GuidedOperation }>('/cloudflare/accounts', { method: 'POST', headers: input.createManagedTunnel ? { 'Idempotency-Key': crypto.randomUUID() } : {}, body: JSON.stringify(input) }),
  updateCloudflareAccount: (id: string, input: UpdateCloudflareAccountInput) =>
    request<{ account: CloudflareAccount }>(`/cloudflare/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  testCloudflareAccount: (id: string) =>
    request<{ verified: true; zoneCount?: number }>(`/cloudflare/accounts/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  syncCloudflareAccount: (id: string) =>
    request<{ zones: CloudflareZone[]; zoneCount?: number }>(`/cloudflare/accounts/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  cloudflareZones: (accountId: string) =>
    request<{ zones: CloudflareZone[] }>(`/cloudflare/accounts/${encodeURIComponent(accountId)}/zones`),
  cloudflareDomainAccess: () => request<{ domainAccess: CloudflareDomainAccess[] }>('/cloudflare/domain-access'),
  createCloudflareDomainAccess: (input: CreateCloudflareDomainAccessInput) =>
    request<{ domainAccess: CloudflareDomainAccess }>('/cloudflare/domain-access', { method: 'POST', body: JSON.stringify(input) }),
  updateCloudflareDomainAccess: (id: string, enabled: boolean) =>
    request<{ domainAccess: CloudflareDomainAccess }>(`/cloudflare/domain-access/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  reconcileCloudflareDomainAccess: (id: string) =>
    request<{ domainAccess: CloudflareDomainAccess }>(`/cloudflare/domain-access/${encodeURIComponent(id)}/reconcile`, { method: 'POST' }),
  guidedPublishDomain: (input: { accountId: string; zoneId: string; hostname: string; agentId: string; targetKind: 'host_port' | 'url'; target: string; accessMethod: 'tunnel' | 'public_ip'; connectorId?: string; publicIpv4?: string[]; publicIpv6?: string[] }, idempotencyKey: string) =>
    request<{ operation: GuidedOperation; route: ManagedRoute; domainAccess?: CloudflareDomainAccess; nextAction?: string; certificateMode?: string; trafficPath?: string }>('/cloudflare/domain-publish', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input) }),
  reconcileGuidedPublish: (id: string) =>
    request<{ operation: GuidedOperation; route: ManagedRoute; domainAccess?: CloudflareDomainAccess; nextAction?: string; certificateMode?: string; trafficPath?: string }>(`/cloudflare/domain-publish/${encodeURIComponent(id)}/reconcile`, { method: 'POST' }),
  agents: () => request<{ agents: Agent[] }>('/agents'),
  createAgent: (name: string, baseUrl: string, image: string) =>
    request<{
      agent: Agent
      enrollmentToken: string
      enrollmentExpiresAt: string
      enrollmentCommand?: string
    }>('/agents', { method: 'POST', body: JSON.stringify({ name, baseUrl, image }) }),
  removeAgent: (id: string) =>
    request<{ mode: 'deleted' | 'archived'; cleanupCommand: string }>(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runAgentDiagnostics: (id: string) =>
    request<{ command: { id: string; status: CommandStatus } }>(`/agents/${encodeURIComponent(id)}/diagnostics`, { method: 'POST' }),
  command: (id: string) => request<{ command: { id: string; status: CommandStatus; result?: Record<string, unknown> | null } }>(`/commands/${encodeURIComponent(id)}`),
  stacks: () => request<{ stacks: ManagedStack[] }>('/stacks'),
  createStack: (input: CreateStackInput) =>
    request<{ stack: ManagedStack }>('/stacks', { method: 'POST', body: JSON.stringify(input) }),
  updateStack: (id: string, input: UpdateStackInput) =>
    request<{ stack: ManagedStack }>(`/stacks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  restartStack: (id: string) => request<{ command: StackCommand }>(`/stacks/${encodeURIComponent(id)}/restart`, { method: 'POST' }),
  stopStack: (id: string) => request<{ command: StackCommand }>(`/stacks/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  requestLogs: (id: string, service: string, tail: number, since?: string) =>
    request<{ commandId: string; status: CommandStatus }>(`/stacks/${encodeURIComponent(id)}/logs`, {
      method: 'POST',
      body: JSON.stringify({ service, tail, ...(since ? { since } : {}) }),
    }),
  logRequest: (commandId: string) =>
    request<{ command: LogRequest }>(`/log-requests/${encodeURIComponent(commandId)}`),
  runtimeProjects: () => request<{ projects: RuntimeProject[] }>('/runtime-projects'),
  runtimeOperations: () => request<{ operations: RuntimeOperation[] }>('/runtime-operations'),
  runtimeAction: (input: { agentId: string; projectName: string; serviceName?: string; action: RuntimeOperation['action']; scope: RuntimeOperation['scope'] }) =>
    request<{ operation: RuntimeOperation }>('/runtime-actions', { method: 'POST', body: JSON.stringify(input) }),
  requestRuntimeLogs: (input: { agentId: string; projectName: string; serviceName: string; tail: number; since?: string }) =>
    request<{ request: RuntimeLogRequest }>('/runtime-log-requests', { method: 'POST', body: JSON.stringify(input) }),
  runtimeLogRequest: (id: string) => request<{ request: RuntimeLogRequest }>(`/runtime-log-requests/${encodeURIComponent(id)}`),
  deployments: () => request<{ deployments: Deployment[] }>('/deployments'),
  previewDeployment: (input: DeploymentSourceInput) => request<DeploymentPreview>('/deployments/preview', { method: 'POST', body: JSON.stringify(input) }),
  createDeployment: (input: DeploymentSourceInput & { agentId: string; displayName: string }) => request<{ deployment: Deployment }>('/deployments', { method: 'POST', body: JSON.stringify(input) }),
  createDeploymentRevision: (id: string, input: Omit<DeploymentSourceInput, 'projectName'>) => request<{ revision: DeploymentRevision }>(`/deployments/${encodeURIComponent(id)}/revisions`, { method: 'POST', body: JSON.stringify(input) }),
  deployRevision: (id: string, revisionId: string) => request<{ run: DeploymentRun }>(`/deployments/${encodeURIComponent(id)}/deploy`, { method: 'POST', body: JSON.stringify({ revisionId }) }),
  rollbackDeployment: (id: string, revisionId: string) => request<{ run: DeploymentRun }>(`/deployments/${encodeURIComponent(id)}/rollback`, { method: 'POST', body: JSON.stringify({ revisionId }) }),
  stopDeployment: (id: string) => request<{ run: DeploymentRun }>(`/deployments/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify({}) }),
  deploymentRun: (id: string) => request<{ run: DeploymentRun }>(`/deployment-runs/${encodeURIComponent(id)}`),
  monitoringSummary: () => request<{ agents: TelemetrySnapshot[] }>('/monitoring/summary'),
  monitoringAgent: (id: string) =>
    request<{ agent: Agent; latest: TelemetrySnapshot | null; history: TelemetrySnapshot[] }>(`/monitoring/agents/${encodeURIComponent(id)}`),
  backups: () => request<{ backups: StackBackup[] }>('/backups'),
  restores: () => request<{ restores: StackRestore[] }>('/restores'),
  createBackup: (id: string, target: StackBackup['target']) =>
    request<{ backup: StackBackup }>(`/stacks/${encodeURIComponent(id)}/backups`, {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
  restoreBackup: (id: string) =>
    request<{ restore: StackRestore }>(`/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  systemBackups: () => request<{ backups: SystemBackup[]; restores: SystemRestore[]; imports: SystemBackupImport[]; recoverySupervisorEnabled: boolean }>('/system-backups'),
  createSystemBackup: (target: SystemBackup['target'], passphrase: string) =>
    request<{ backup: SystemBackup }>('/system-backups', { method: 'POST', body: JSON.stringify({ target, passphrase }) }),
  stageSystemRestore: (id: string, passphrase: string) =>
    request<{ restore: SystemRestore; manualRestoreRequired: true; restoreCommand: string }>(`/system-backups/${encodeURIComponent(id)}/stage-restore`, { method: 'POST', body: JSON.stringify({ passphrase }) }),
  exportSystemBackupUrl: (id: string) => `/api/system-backups/${encodeURIComponent(id)}/export`,
  uploadSystemBackup: (file: File, onProgress: (percent: number) => void) => new Promise<{ import: SystemBackupImport }>((resolve, reject) => {
    const upload = new XMLHttpRequest()
    upload.open('POST', '/api/system-backup-imports')
    upload.withCredentials = true
    upload.setRequestHeader('Accept', 'application/json')
    upload.setRequestHeader('Content-Type', 'application/octet-stream')
    upload.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)) }
    upload.onerror = () => reject(new ApiError(0, 'The upload could not be completed.'))
    upload.onload = () => {
      let body: { import?: SystemBackupImport; error?: string; code?: string } = {}
      try { body = JSON.parse(upload.responseText) as typeof body } catch { /* Ignore untrusted non-JSON responses. */ }
      if (upload.status >= 200 && upload.status < 300 && body.import) resolve({ import: body.import })
      else reject(new ApiError(upload.status, body.error || 'The upload could not be completed.', body.code))
    }
    upload.send(file)
  }),
  validateSystemBackupImport: (id: string, passphrase: string) =>
    request<{ import: SystemBackupImport; backup: SystemBackup; idempotent: boolean }>(`/system-backup-imports/${encodeURIComponent(id)}/validate`, { method: 'POST', body: JSON.stringify({ passphrase }) }),
  requestSystemRestoreApply: (id: string, confirmation: string, passphrase: string) =>
    request<{ queued: true; browserMayDisconnect: true }>(`/system-restores/${encodeURIComponent(id)}/request-apply`, { method: 'POST', body: JSON.stringify({ confirmation, passphrase }) }),
  routes: () => request<{ routes: ManagedRoute[] }>('/routes'),
  createRoute: (input: CreateRouteInput) =>
    request<{ route: ManagedRoute }>('/routes', { method: 'POST', body: JSON.stringify(input) }),
  updateRoute: (id: string, input: UpdateRouteInput) =>
    request<{ route: ManagedRoute }>(`/routes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  telegram: () => request<TelegramSettings>('/notifications/telegram'),
  notificationTopology: () => request<NotificationTopology>('/notifications/topology'),
  setAgentNotifications: (agentId: string, enabled: boolean) =>
    request<{ agent: NotificationAgentPreference }>(`/notifications/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  setServiceNotifications: (agentId: string, projectName: string, serviceName: string, enabled: boolean) =>
    request<{ service: NotificationServicePreference }>('/notifications/services', { method: 'PATCH', body: JSON.stringify({ agentId, projectName, serviceName, enabled }) }),
  saveTelegram: (botToken: string | undefined, groupId: string | undefined, selectedEvents: string[]) =>
    request<TelegramSettings>('/notifications/telegram', {
      method: 'PUT',
      body: JSON.stringify({ ...(botToken && groupId ? { botToken, groupId } : {}), selectedEvents }),
    }),
  testTelegram: () => request<{ sent: true }>('/notifications/telegram/test', { method: 'POST' }),
}
