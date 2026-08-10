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

export type CloudflarePublicHostname = {
  id: string
  cloudflareZoneId: string
  cloudflareAccountId: string
  connectorId: string
  routeId: string
  hostname: string
  dnsRecordId: string | null
  enabled: boolean
  proxied: boolean
  status: DeploymentStatus
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type Agent = {
  id: string
  name: string
  enrolledAt?: string | null
  enrollmentExpiresAt?: string | null
  lastHeartbeatAt?: string | null
  enabled?: boolean
  metadata?: unknown
  createdAt?: string
}

export type TelegramSettings = {
  configured: boolean
  selectedEvents: string[]
}

export type DeploymentStatus = 'pending' | 'active' | 'failed'
export type CommandStatus = 'pending' | 'claimed' | 'succeeded' | 'failed'
export type OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed'
export type RuntimeServiceStatus = 'healthy' | 'unhealthy' | 'starting' | 'stopped' | 'unknown'

export type ManagedStack = {
  id: string
  agentId: string
  name: string
  projectName: string
  enabled: boolean
  configured: boolean
  revision: number
  status: DeploymentStatus
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

export type CreateStackInput = Pick<ManagedStack, 'agentId' | 'name' | 'projectName' | 'enabled'> & { composeYaml: string }
export type UpdateStackInput = Partial<Pick<ManagedStack, 'name' | 'enabled'>> & { composeYaml?: string }
export type CreateRouteInput = Pick<ManagedRoute, 'gatewayAgentId' | 'name' | 'hostname' | 'exposure' | 'backends' | 'enabled'>
export type UpdateRouteInput = Partial<CreateRouteInput>
export type CreateConnectorInput = Pick<Connector, 'agentId' | 'name' | 'enabled'> & {
  token: string
  cloudflareAccountId?: string
  tunnelId?: string
}
export type UpdateConnectorInput = Partial<Pick<Connector, 'agentId' | 'name' | 'enabled' | 'cloudflareAccountId' | 'tunnelId'>> & { token?: string }
export type CreateCloudflareAccountInput = Pick<CloudflareAccount, 'name' | 'accountIdentifier' | 'enabled'> & { apiToken: string }
export type UpdateCloudflareAccountInput = Partial<Pick<CloudflareAccount, 'name' | 'accountIdentifier' | 'enabled'>> & { apiToken?: string }
export type CreateCloudflarePublicHostnameInput = Pick<CloudflarePublicHostname, 'connectorId' | 'routeId' | 'proxied'> & { zoneId: string }

export class ApiError extends Error {
  public constructor(public readonly status: number, message: string) {
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

    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === 'string' && body.error.length <= 500) {
        message = body.error
      }
    } catch {
      // Do not expose proxy responses or untrusted HTML as application errors.
    }

    throw new ApiError(response.status, message)
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
  configuration: () => request<{ agentImage: string }>('/configuration'),
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
  cloudflareAccounts: () => request<{ accounts: CloudflareAccount[] }>('/cloudflare/accounts'),
  createCloudflareAccount: (input: CreateCloudflareAccountInput) =>
    request<{ account: CloudflareAccount }>('/cloudflare/accounts', { method: 'POST', body: JSON.stringify(input) }),
  updateCloudflareAccount: (id: string, input: UpdateCloudflareAccountInput) =>
    request<{ account: CloudflareAccount }>(`/cloudflare/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  testCloudflareAccount: (id: string) =>
    request<{ verified: true }>(`/cloudflare/accounts/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  syncCloudflareAccount: (id: string) =>
    request<{ zones: CloudflareZone[] }>(`/cloudflare/accounts/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  cloudflareZones: (accountId: string) =>
    request<{ zones: CloudflareZone[] }>(`/cloudflare/accounts/${encodeURIComponent(accountId)}/zones`),
  cloudflarePublicHostnames: () => request<{ publicHostnames: CloudflarePublicHostname[] }>('/cloudflare/public-hostnames'),
  createCloudflarePublicHostname: (input: CreateCloudflarePublicHostnameInput) =>
    request<{ publicHostname: CloudflarePublicHostname }>('/cloudflare/public-hostnames', { method: 'POST', body: JSON.stringify(input) }),
  updateCloudflarePublicHostname: (id: string, enabled: boolean) =>
    request<{ publicHostname: CloudflarePublicHostname }>(`/cloudflare/public-hostnames/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
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
  routes: () => request<{ routes: ManagedRoute[] }>('/routes'),
  createRoute: (input: CreateRouteInput) =>
    request<{ route: ManagedRoute }>('/routes', { method: 'POST', body: JSON.stringify(input) }),
  updateRoute: (id: string, input: UpdateRouteInput) =>
    request<{ route: ManagedRoute }>(`/routes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  telegram: () => request<TelegramSettings>('/notifications/telegram'),
  saveTelegram: (botToken: string | undefined, groupId: string | undefined, selectedEvents: string[]) =>
    request<TelegramSettings>('/notifications/telegram', {
      method: 'PUT',
      body: JSON.stringify({ ...(botToken && groupId ? { botToken, groupId } : {}), selectedEvents }),
    }),
  testTelegram: () => request<{ sent: true }>('/notifications/telegram/test', { method: 'POST' }),
}
