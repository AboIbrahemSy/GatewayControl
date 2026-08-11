import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { OPERATIONAL_EVENT_TYPES, sanitizeOperationalEventTypes, type Agent, type AgentCommand, type BackupTarget, type CloudflareAccount, type CloudflareAccountSecret, type CloudflareDomainAccess, type CloudflareDomainAccessDeployment, type CloudflareZone, type Connector, type ConnectorDeployment, type ConnectorIdentityDeployment, type ConnectorIdentityExpectation, type Deployment, type DeploymentCommandSource, type DeploymentRevision, type DeploymentRun, type DomainAccessDnsRecord, type GuidedOperation, type ManagedRoute, type ManagedStack, type NotificationAgentPreference, type NotificationDelivery, type NotificationServicePreference, type NotificationSettings, type NotificationTopology, type OperationalEventType, type RuntimeInventory, type RuntimeLogRequest, type RuntimeOperation, type RuntimeAction, type RuntimeScope, type StackBackup, type StackDeployment, type StackRestore, type Store, type StoredSystemBackup, type SystemBackup, type SystemBackupImport, type SystemRestore, type TelemetrySnapshot, type TlsObservation, type TlsObservationTarget, type User } from './types.js';

function user(row: QueryResultRow): User {
  return { id: row.id, email: row.email, role: row.role, passwordHash: row.password_hash } as User;
}

function connector(row: QueryResultRow): Connector {
  return {
    id: row.id, agentId: row.agent_id, name: row.name, enabled: row.enabled,
    cloudflareAccountId: row.cloudflare_account_id ?? null, tunnelId: row.tunnel_id ?? null,
    desiredRevision: Number(row.desired_revision), tokenAccountIdentifier: row.token_account_identifier ?? null,
    tokenTunnelId: row.token_tunnel_id ?? null, identityStatus: row.identity_status,
    identityVerifiedAt: row.identity_verified_at?.toISOString() ?? null, identityError: row.identity_error ?? null,
    deploymentStatus: row.deployment_status, runtimeStatus: row.runtime_status,
    lastError: row.last_error ?? null, lastDeployedAt: row.last_deployed_at?.toISOString() ?? null,
    lastObservedAt: row.last_observed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function cloudflareAccount(row: QueryResultRow): CloudflareAccount {
  return {
    id: row.id, name: row.name, accountIdentifier: row.account_identifier, configured: true, enabled: row.enabled,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null, lastErrorAt: row.last_error_at?.toISOString() ?? null,
    lastError: row.last_error ?? null, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function cloudflareZone(row: QueryResultRow): CloudflareZone {
  return {
    id: row.id, cloudflareAccountId: row.cloudflare_account_id, zoneIdentifier: row.zone_identifier,
    name: row.name, status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function cloudflareDomainAccess(row: QueryResultRow): CloudflareDomainAccess {
  return {
    id: row.id, cloudflareZoneId: row.cloudflare_zone_id, cloudflareAccountId: row.cloudflare_account_id,
    connectorId: row.connector_id ?? null, routeId: row.route_id, hostname: row.hostname,
    accessMethod: row.access_method, publicIpv4: row.public_ipv4 ?? [], publicIpv6: row.public_ipv6 ?? [],
    ownedDnsRecords: row.owned_dns_records ?? [], dnsRecordId: row.dns_record_id ?? null,
    enabled: row.enabled, revision: Number(row.revision), proxied: row.proxied, status: row.status, lastError: row.last_error ?? null,
    lastReconciledAt: row.last_reconciled_at?.toISOString() ?? null,
    tlsStatus: row.tls_status, tlsIssuer: row.tls_issuer ?? null, tlsValidTo: row.tls_valid_to?.toISOString() ?? null,
    tlsObservedAt: row.tls_observed_at?.toISOString() ?? null, tlsError: row.tls_error ?? null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  } as CloudflareDomainAccess;
}

function guidedOperation(row: QueryResultRow): GuidedOperation {
  return {
    id: row.id, kind: row.kind, idempotencyKey: row.idempotency_key, requestedByUserId: row.requested_by_user_id,
    requestHash: row.request_hash, encryptedRequest: row.request_encrypted ?? null, status: row.status, stage: row.stage,
    cloudflareAccountId: row.cloudflare_account_id ?? null, connectorId: row.connector_id ?? null,
    routeId: row.route_id ?? null, domainAccessId: row.domain_access_id ?? null,
    remoteTunnelId: row.remote_tunnel_id ?? null, remoteTunnelName: row.remote_tunnel_name ?? null,
    result: row.result ?? null, error: row.error ?? null, verificationDeadlineAt: row.verification_deadline_at?.toISOString() ?? null,
    verificationAttempts: Number(row.verification_attempts ?? 0), createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function agent(row: QueryResultRow): Agent {
  const lastHeartbeatAt = row.last_heartbeat_at?.toISOString() ?? null;
  const lastTelemetryAt = row.last_telemetry_at?.toISOString() ?? null;
  const lastCommandPollAt = row.last_command_poll_at?.toISOString() ?? null;
  const channelTimes = [lastHeartbeatAt, lastTelemetryAt, lastCommandPollAt].filter((value): value is string => value !== null).map(Date.parse);
  const latestChannelAt = channelTimes.length > 0 ? Math.max(...channelTimes) : 0;
  const diagnostics = row.last_diagnostics ?? row.last_metadata?.diagnostics ?? null;
  const checks = diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics)
    ? (diagnostics as { checks?: unknown }).checks : null;
  const hasFailedCheck = checks && typeof checks === 'object' && !Array.isArray(checks)
    ? Object.values(checks).some((check) => check && typeof check === 'object' && (check as { state?: unknown }).state === 'failed') : false;
  const healthStatus: Agent['healthStatus'] = !row.enrolled_at ? 'pending'
    : latestChannelAt === 0 || latestChannelAt < Date.now() - 3 * 60_000 ? 'offline'
      : hasFailedCheck ? 'degraded' : 'connected';
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    enrolledAt: row.enrolled_at?.toISOString() ?? null,
    lastHeartbeatAt,
    lastTelemetryAt,
    lastCommandPollAt,
    lastCommandResultAt: row.last_command_result_at?.toISOString() ?? null,
    healthStatus,
    diagnostics,
    metadata: row.last_metadata ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function command(row: QueryResultRow): AgentCommand {
  return { id: row.id, agentId: row.agent_id, type: row.type, payload: row.payload, status: row.status, result: row.result } as AgentCommand;
}

function stack(row: QueryResultRow): ManagedStack {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    projectName: row.project_name,
    enabled: row.enabled,
    configured: Boolean(row.compose_yaml_encrypted),
    revision: row.revision,
    status: row.status,
    postgresBackupConfig: row.postgres_backup_config ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  } as ManagedStack;
}

function deploymentRevision(row: QueryResultRow): DeploymentRevision {
  return {
    id: row.id, deploymentId: row.deployment_id, commitSha: row.commit_sha, composePath: row.compose_path,
    checksum: row.checksum, policyVersion: Number(row.policy_version), policyResult: row.policy_result,
    createdByUserId: row.created_by_user_id, createdAt: isoTime(row.created_at),
  };
}

function deploymentRun(row: QueryResultRow): DeploymentRun {
  return {
    id: row.id, deploymentId: row.deployment_id, revisionId: row.revision_id, priorRevisionId: row.prior_revision_id ?? null,
    agentId: row.agent_id, commandId: row.command_id, action: row.action, status: row.status, result: row.result ?? null,
    error: row.error ?? null, startedAt: row.started_at ? isoTime(row.started_at) : null, completedAt: row.completed_at ? isoTime(row.completed_at) : null,
    createdAt: isoTime(row.created_at), updatedAt: isoTime(row.updated_at),
  };
}

function deployment(row: QueryResultRow): Deployment {
  return {
    id: row.id, agentId: row.agent_id, displayName: row.display_name, projectName: row.project_name,
    sourceRepository: row.source_repository, enabled: row.enabled, currentRevisionId: row.current_revision_id ?? null,
    status: row.status, revisions: (row.revisions ?? []).map(deploymentRevision),
    latestRun: row.latest_run ? deploymentRun(row.latest_run) : null,
    createdAt: isoTime(row.created_at), updatedAt: isoTime(row.updated_at),
  };
}

function isoTime(value: Date | string): string { return value instanceof Date ? value.toISOString() : value; }

function route(row: QueryResultRow): ManagedRoute {
  return {
    id: row.id,
    gatewayAgentId: row.gateway_agent_id,
    name: row.name,
    hostname: row.hostname,
    exposure: row.exposure,
    backends: row.backends,
    enabled: row.enabled,
    revision: row.revision,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  } as ManagedRoute;
}

function telemetry(row: QueryResultRow): TelemetrySnapshot {
  return { agentId: row.agent_id, observedAt: row.observed_at.toISOString(), node: row.node, services: row.services, receivedAt: row.created_at.toISOString() };
}

function runtimeOperation(row: QueryResultRow): RuntimeOperation {
  return {
    id: row.id, requestedByUserId: row.requested_by_user_id, agentId: row.agent_id, commandId: row.command_id ?? null,
    action: row.action, scope: row.scope, projectName: row.project_name, serviceName: row.service_name ?? null,
    status: row.status, result: row.result ?? null, error: row.error ?? null, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
  } as RuntimeOperation;
}

function runtimeLogRequest(row: QueryResultRow): RuntimeLogRequest {
  return {
    id: row.id, requestedByUserId: row.requested_by_user_id, agentId: row.agent_id, commandId: row.command_id ?? null,
    projectName: row.project_name, serviceName: row.service_name, tail: row.tail, since: row.since?.toISOString() ?? null,
    status: row.status, result: row.result ?? null, error: row.error ?? null, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
  } as RuntimeLogRequest;
}

function backup(row: QueryResultRow): StackBackup {
  return {
    id: row.id, stackId: row.stack_id, agentId: row.agent_id, commandId: row.command_id,
    requestedByUserId: row.requested_by_user_id, target: row.target, stackRevision: row.stack_revision,
    status: row.status, result: row.result, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  } as StackBackup;
}

function restore(row: QueryResultRow): StackRestore {
  return {
    id: row.id, stackId: row.stack_id, backupId: row.backup_id, agentId: row.agent_id, commandId: row.command_id,
    requestedByUserId: row.requested_by_user_id, status: row.status, result: row.result,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
  } as StackRestore;
}

function systemBackup(row: QueryResultRow): StoredSystemBackup {
  return {
    id: row.id, requestedByUserId: row.requested_by_user_id, target: row.target, status: row.status,
    artifactPath: row.artifact_path, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    checksum: row.checksum ?? null, error: row.error ?? null, source: row.source ?? 'created', metadata: row.metadata ?? {}, createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  } as StoredSystemBackup;
}

function systemBackupImport(row: QueryResultRow): SystemBackupImport {
  return {
    id: row.id, requestedByUserId: row.requested_by_user_id, status: row.status, quarantinePath: row.quarantine_path,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes), checksum: row.checksum ?? null,
    backupId: row.backup_id ?? null, error: row.error ?? null, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
    validationRevision: Number(row.validation_revision ?? 0),
  };
}

function systemRestore(row: QueryResultRow): SystemRestore {
  return {
    id: row.id, backupId: row.backup_id, requestedByUserId: row.requested_by_user_id,
    status: row.status, error: row.error ?? null, createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  } as SystemRestore;
}

export class PgStore implements Store {
  private readonly pool: Pool;
  private readonly notificationTopologyLimits: { maxAgents: number; maxServices: number; maxScopes: number };

  public constructor(connectionString: string, notificationTopologyLimits = { maxAgents: 100, maxServices: 5_000, maxScopes: 5_000 }) {
    this.notificationTopologyLimits = notificationTopologyLimits;
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_500,
      query_timeout: 2_500,
      statement_timeout: 2_000,
    });
    this.pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error.', { message: error.message }));
  }

  public async checkReady(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  public async isSetupComplete(): Promise<boolean> {
    const result = await this.pool.query("SELECT EXISTS (SELECT 1 FROM users WHERE role = 'owner') AS complete");
    return result.rows[0].complete;
  }

  public async createOwner(email: string, passwordHash: string): Promise<User | null> {
    const result = await this.pool.query(
      `INSERT INTO users (email, password_hash, role)
       SELECT $1, $2, 'owner' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')
       ON CONFLICT DO NOTHING RETURNING *`,
      [email, passwordHash],
    );
    return result.rows[0] ? user(result.rows[0]) : null;
  }

  public async findUserByEmail(email: string): Promise<User | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    return result.rows[0] ? user(result.rows[0]) : null;
  }

  public async listUsers(): Promise<Omit<User, 'passwordHash'>[]> {
    const result = await this.pool.query('SELECT id, email, role FROM users ORDER BY created_at');
    return result.rows.map((row) => ({ id: row.id, email: row.email, role: row.role } as Omit<User, 'passwordHash'>));
  }

  public async createUser(email: string, passwordHash: string, role: 'operator' | 'viewer'): Promise<User> {
    const result = await this.pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING *', [email, passwordHash, role]);
    return user(result.rows[0]);
  }

  public async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [userId, tokenHash, expiresAt]);
  }

  public async findSessionUser(tokenHash: string): Promise<User | null> {
    const result = await this.pool.query(
      `UPDATE sessions SET last_seen_at = now()
       WHERE token_hash = $1 AND expires_at > now()
       RETURNING (SELECT row_to_json(u) FROM users u WHERE u.id = sessions.user_id) AS user`,
      [tokenHash],
    );
    const row = result.rows[0]?.user;
    return row ? user(row) : null;
  }

  public async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  public async listConnectors(): Promise<Connector[]> {
    const result = await this.pool.query('SELECT * FROM cloudflare_connectors ORDER BY name');
    return result.rows.map(connector);
  }

  public async createConnector(values: { name: string; encryptedToken: string; enabled: boolean; agentId: string; accountId?: string; accountIdentifier: string; tunnelId: string; identityStatus: Connector['identityStatus']; identityError?: string }): Promise<Connector | null> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO cloudflare_connectors
            (name, token_encrypted, enabled, agent_id, cloudflare_account_id, tunnel_id, desired_revision,
             token_account_identifier, token_tunnel_id, identity_status, identity_verified_at, identity_error)
          SELECT $1, $2, $3, a.id, cf.id, CASE WHEN cf.id IS NULL THEN NULL ELSE $7 END, 1, $6, $7::uuid, $8,
            CASE WHEN $8 = 'verified' THEN now() ELSE NULL END, $9
          FROM agents a
          LEFT JOIN cloudflare_accounts cf ON cf.id = $5 AND cf.enabled AND lower(cf.account_identifier) = lower($6)
          WHERE a.id = $4 AND a.enabled AND a.enrolled_at IS NOT NULL AND ($5::uuid IS NULL OR cf.id IS NOT NULL)
          RETURNING *`,
        [values.name, values.encryptedToken, values.enabled, values.agentId, values.accountId ?? null, values.accountIdentifier,
          values.tunnelId, values.identityStatus, values.identityError?.slice(0, 100) ?? null],
      );
      if (!result.rows[0]) return null;
      const created = connector(result.rows[0]);
      if (values.enabled) await this.queueConnectorSync(client, created.agentId, created.id, created.desiredRevision);
      return created;
    });
  }

  public async updateConnector(id: string, values: { name?: string; encryptedToken?: string; enabled?: boolean; agentId?: string; accountId?: string; accountIdentifier?: string; tunnelId?: string }): Promise<Connector | null> {
    return this.transaction(async (client) => {
      const current = await client.query('SELECT agent_id, identity_status, token_account_identifier, token_tunnel_id, desired_revision FROM cloudflare_connectors WHERE id = $1 FOR UPDATE', [id]);
      if (!current.rows[0]) return null;
      const targetAgentId = values.agentId ?? current.rows[0].agent_id;
      const targetAgent = await client.query('SELECT 1 FROM agents WHERE id = $1 AND enabled AND enrolled_at IS NOT NULL', [targetAgentId]);
      if (!targetAgent.rows[0]) return null;
      if (values.accountId && !(await client.query('SELECT 1 FROM cloudflare_accounts WHERE id = $1 AND enabled AND lower(account_identifier) = lower($2)', [values.accountId, values.accountIdentifier])).rows[0]) return null;
      if (values.enabled === true && !values.encryptedToken
        && (!['verified', 'parsed', 'unmatched', 'mismatch', 'failed'].includes(current.rows[0].identity_status)
          || !current.rows[0].token_account_identifier || !current.rows[0].token_tunnel_id)) return null;
      if (values.agentId && values.agentId !== current.rows[0].agent_id) {
        await client.query(
          `INSERT INTO agent_commands (agent_id, type, payload)
           VALUES ($1, 'cloudflare.connector.remove', jsonb_build_object('connectorId', $2::text, 'revision', $3::bigint))`,
          [current.rows[0].agent_id, id, Number(current.rows[0].desired_revision) + 1],
        );
      }
      const result = await client.query(
        `UPDATE cloudflare_connectors SET
           name = COALESCE($2, name), token_encrypted = COALESCE($3, token_encrypted),
           enabled = COALESCE($4, enabled), agent_id = COALESCE($5, agent_id),
            cloudflare_account_id = CASE WHEN $6 THEN $7::uuid ELSE cloudflare_account_id END,
            tunnel_id = CASE WHEN $6 THEN $9::text ELSE tunnel_id END,
            token_account_identifier = CASE WHEN $6 THEN $8 ELSE token_account_identifier END,
            token_tunnel_id = CASE WHEN $6 THEN $9::uuid ELSE token_tunnel_id END,
            identity_status = CASE WHEN $6 THEN 'verified' ELSE identity_status END,
            identity_verified_at = CASE WHEN $6 THEN now() ELSE identity_verified_at END,
            identity_error = CASE WHEN $6 THEN NULL ELSE identity_error END,
            desired_revision = desired_revision + 1,
            deployment_status = CASE WHEN COALESCE($4, enabled) THEN 'pending' ELSE 'stopping' END,
            runtime_status = CASE WHEN COALESCE($4, enabled) THEN 'unknown' ELSE runtime_status END,
            last_error = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, values.name ?? null, values.encryptedToken ?? null, values.enabled ?? null, values.agentId ?? null,
          values.accountId !== undefined, values.accountId ?? null, values.accountIdentifier ?? null, values.tunnelId ?? null],
      );
      const updated = connector(result.rows[0]);
      await this.queueConnectorSync(client, updated.agentId, updated.id, updated.desiredRevision, !updated.enabled);
      return updated;
    });
  }

  public async getConnectorDeployment(connectorId: string): Promise<ConnectorDeployment | null> {
    const result = await this.pool.query(
      'SELECT id, agent_id, name, enabled, desired_revision, token_encrypted, cloudflare_account_id, tunnel_id, token_account_identifier, token_tunnel_id, identity_status FROM cloudflare_connectors WHERE id = $1',
      [connectorId],
    );
    const row = result.rows[0];
    return row ? { connectorId: row.id, agentId: row.agent_id, name: row.name, enabled: row.enabled, desiredRevision: Number(row.desired_revision), encryptedToken: row.token_encrypted, cloudflareAccountId: row.cloudflare_account_id ?? null, tunnelId: row.tunnel_id ?? null, tokenAccountIdentifier: row.token_account_identifier ?? null, tokenTunnelId: row.token_tunnel_id ?? null, identityStatus: row.identity_status } : null;
  }

  public async listCloudflareAccounts(): Promise<CloudflareAccount[]> {
    const result = await this.pool.query('SELECT * FROM cloudflare_accounts ORDER BY name');
    return result.rows.map(cloudflareAccount);
  }

  public async createCloudflareAccount(values: { name: string; accountIdentifier: string; encryptedApiToken: string; enabled: boolean }): Promise<CloudflareAccount> {
    const result = await this.pool.query(
      `INSERT INTO cloudflare_accounts (name, account_identifier, api_token_encrypted, enabled)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [values.name, values.accountIdentifier, values.encryptedApiToken, values.enabled],
    );
    return cloudflareAccount(result.rows[0]);
  }

  public async updateCloudflareAccount(id: string, values: { name?: string; accountIdentifier?: string; encryptedApiToken?: string; enabled?: boolean }): Promise<CloudflareAccount | null> {
    const result = await this.pool.query(
      `UPDATE cloudflare_accounts SET name = COALESCE($2, name), account_identifier = COALESCE($3, account_identifier),
       api_token_encrypted = COALESCE($4, api_token_encrypted), enabled = COALESCE($5, enabled), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, values.name ?? null, values.accountIdentifier ?? null, values.encryptedApiToken ?? null, values.enabled ?? null],
    );
    return result.rows[0] ? cloudflareAccount(result.rows[0]) : null;
  }

  public async getCloudflareAccountSecret(id: string): Promise<CloudflareAccountSecret | null> {
    const result = await this.pool.query('SELECT * FROM cloudflare_accounts WHERE id = $1', [id]);
    return result.rows[0] ? { ...cloudflareAccount(result.rows[0]), encryptedApiToken: result.rows[0].api_token_encrypted } : null;
  }

  public async getCloudflareAccountSecretByIdentifier(accountIdentifier: string): Promise<CloudflareAccountSecret | null> {
    const result = await this.pool.query('SELECT * FROM cloudflare_accounts WHERE enabled AND lower(account_identifier) = lower($1)', [accountIdentifier]);
    return result.rows[0] ? { ...cloudflareAccount(result.rows[0]), encryptedApiToken: result.rows[0].api_token_encrypted } : null;
  }

  public async listConnectorIdentityDeployments(limit: number): Promise<ConnectorIdentityDeployment[]> {
    const result = await this.pool.query(
       `SELECT id, agent_id, name, enabled, desired_revision, token_encrypted, cloudflare_account_id, tunnel_id,
          token_account_identifier, token_tunnel_id, identity_status
       FROM cloudflare_connectors WHERE identity_status IN ('pending', 'parsed', 'failed')
         OR (identity_status = 'unmatched' AND updated_at < now() - interval '1 hour')
       ORDER BY updated_at LIMIT $1`,
      [Math.max(1, Math.min(limit, 50))],
    );
    return result.rows.map((row) => ({
      connectorId: row.id, agentId: row.agent_id, name: row.name, enabled: row.enabled,
      desiredRevision: Number(row.desired_revision), encryptedToken: row.token_encrypted,
      cloudflareAccountId: row.cloudflare_account_id ?? null, tunnelId: row.tunnel_id ?? null,
      tokenAccountIdentifier: row.token_account_identifier ?? null, tokenTunnelId: row.token_tunnel_id ?? null,
      identityStatus: row.identity_status,
    }));
  }

  public async markConnectorIdentity(id: string, expected: ConnectorIdentityExpectation, values: { status: Connector['identityStatus']; accountId?: string; accountIdentifier?: string; tunnelId?: string; error?: string }): Promise<Connector | null> {
    const result = await this.pool.query(
      `UPDATE cloudflare_connectors SET
       identity_status = CASE WHEN $4 = 'verified' AND (
         (cloudflare_account_id IS NOT NULL AND cloudflare_account_id IS DISTINCT FROM $5::uuid)
         OR (tunnel_id IS NOT NULL AND lower(tunnel_id) IS DISTINCT FROM lower($7::text))
       ) THEN 'mismatch' ELSE $4 END,
       cloudflare_account_id = CASE WHEN $4 = 'verified'
         AND (cloudflare_account_id IS NULL OR cloudflare_account_id = $5::uuid)
         AND (tunnel_id IS NULL OR lower(tunnel_id) = lower($7::text))
         THEN COALESCE(cloudflare_account_id, $5::uuid) ELSE cloudflare_account_id END,
       tunnel_id = CASE WHEN $4 = 'verified'
         AND (cloudflare_account_id IS NULL OR cloudflare_account_id = $5::uuid)
         AND (tunnel_id IS NULL OR lower(tunnel_id) = lower($7::text))
         THEN COALESCE(tunnel_id, $7::text) ELSE tunnel_id END,
       token_account_identifier = $6, token_tunnel_id = $7::uuid,
       identity_verified_at = CASE WHEN $4 = 'verified'
         AND (cloudflare_account_id IS NULL OR cloudflare_account_id = $5::uuid)
         AND (tunnel_id IS NULL OR lower(tunnel_id) = lower($7::text)) THEN now() ELSE NULL END,
       identity_error = CASE WHEN $4 = 'verified' AND (
         (cloudflare_account_id IS NOT NULL AND cloudflare_account_id IS DISTINCT FROM $5::uuid)
         OR (tunnel_id IS NOT NULL AND lower(tunnel_id) IS DISTINCT FROM lower($7::text))
       ) THEN 'connector_identity_mismatch' WHEN $4 = 'verified' THEN NULL ELSE $8 END,
       updated_at = now()
       WHERE id = $1 AND desired_revision = $2 AND token_encrypted = $3 RETURNING *`,
      [id, expected.desiredRevision, expected.encryptedToken, values.status, values.accountId ?? null,
        values.accountIdentifier ?? null, values.tunnelId ?? null, values.error?.slice(0, 100) ?? null],
    );
    return result.rows[0] ? connector(result.rows[0]) : null;
  }

  public async syncCloudflareZones(accountId: string, zones: Array<{ zoneIdentifier: string; name: string; status: string }>, error?: string): Promise<CloudflareZone[] | null> {
    return this.transaction(async (client) => {
      const account = await client.query(
        `UPDATE cloudflare_accounts SET last_synced_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_synced_at END,
         last_error_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, last_error = $2, updated_at = now()
         WHERE id = $1 RETURNING id`, [accountId, error ?? null],
      );
      if (!account.rows[0]) return null;
      if (!error) {
        await client.query(
          `UPDATE cloudflare_zones SET status = 'unavailable', updated_at = now()
           WHERE cloudflare_account_id = $1 AND NOT (zone_identifier = ANY($2::text[]))`,
          [accountId, zones.map((zone) => zone.zoneIdentifier)],
        );
        for (const zone of zones) {
          await client.query(
            `INSERT INTO cloudflare_zones (cloudflare_account_id, zone_identifier, name, status) VALUES ($1, $2, $3, $4)
             ON CONFLICT ((lower(zone_identifier))) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()
             WHERE cloudflare_zones.cloudflare_account_id = EXCLUDED.cloudflare_account_id`,
            [accountId, zone.zoneIdentifier, zone.name, zone.status],
          );
        }
      }
      const result = await client.query('SELECT * FROM cloudflare_zones WHERE cloudflare_account_id = $1 ORDER BY name', [accountId]);
      return result.rows.map(cloudflareZone);
    });
  }

  public async listCloudflareZones(accountId: string): Promise<CloudflareZone[] | null> {
    if (!(await this.pool.query('SELECT 1 FROM cloudflare_accounts WHERE id = $1', [accountId])).rows[0]) return null;
    const result = await this.pool.query('SELECT * FROM cloudflare_zones WHERE cloudflare_account_id = $1 ORDER BY name', [accountId]);
    return result.rows.map(cloudflareZone);
  }

  public async listCloudflareDomainAccess(): Promise<CloudflareDomainAccess[]> {
    const result = await this.pool.query(`SELECT ${this.domainAccessColumns()} FROM cloudflare_public_hostnames h ORDER BY h.hostname`);
    return result.rows.map(cloudflareDomainAccess);
  }

  public async createOrGetGuidedOperation(values: { kind: GuidedOperation['kind']; idempotencyKey: string; requestedByUserId: string; requestHash: string; encryptedRequest: string }): Promise<{ operation: GuidedOperation; created: boolean }> {
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO guided_operations (kind, idempotency_key, requested_by_user_id, request_hash, request_encrypted)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (requested_by_user_id, kind, idempotency_key) DO NOTHING RETURNING *`,
        [values.kind, values.idempotencyKey, values.requestedByUserId, values.requestHash, values.encryptedRequest],
      );
      if (inserted.rows[0]) return { operation: guidedOperation(inserted.rows[0]), created: true };
      const existing = await client.query(
        'SELECT * FROM guided_operations WHERE requested_by_user_id = $1 AND kind = $2 AND idempotency_key = $3 FOR UPDATE',
        [values.requestedByUserId, values.kind, values.idempotencyKey],
      );
      return { operation: guidedOperation(existing.rows[0]), created: false };
    });
  }

  public async updateGuidedOperation(id: string, values: { status?: GuidedOperation['status']; stage?: string; accountId?: string; connectorId?: string; routeId?: string; domainAccessId?: string; remoteTunnelId?: string; remoteTunnelName?: string; result?: Record<string, unknown>; error?: string | null; clearEncryptedRequest?: boolean; verificationDeadlineAt?: string; incrementVerificationAttempts?: boolean }): Promise<GuidedOperation | null> {
    const result = await this.pool.query(
      `UPDATE guided_operations SET status = COALESCE($2, status), stage = COALESCE($3, stage),
       cloudflare_account_id = COALESCE($4, cloudflare_account_id), connector_id = COALESCE($5, connector_id),
       route_id = COALESCE($6, route_id), domain_access_id = COALESCE($7, domain_access_id),
       remote_tunnel_id = COALESCE($8, remote_tunnel_id), remote_tunnel_name = COALESCE($9, remote_tunnel_name),
       result = COALESCE($10::jsonb, result), error = CASE WHEN $11 THEN $12 ELSE error END,
       request_encrypted = CASE WHEN $13 THEN NULL ELSE request_encrypted END,
       verification_deadline_at = COALESCE($14, verification_deadline_at),
       verification_attempts = verification_attempts + CASE WHEN $15 THEN 1 ELSE 0 END, updated_at = now(),
       completed_at = CASE WHEN COALESCE($2, status) = 'succeeded' THEN now() ELSE completed_at END
       WHERE id = $1 RETURNING *`,
      [id, values.status ?? null, values.stage ?? null, values.accountId ?? null, values.connectorId ?? null,
        values.routeId ?? null, values.domainAccessId ?? null, values.remoteTunnelId ?? null, values.remoteTunnelName ?? null,
        values.result ? JSON.stringify(values.result) : null, values.error !== undefined, values.error ?? null, values.clearEncryptedRequest === true,
        values.verificationDeadlineAt ?? null, values.incrementVerificationAttempts === true],
    );
    return result.rows[0] ? guidedOperation(result.rows[0]) : null;
  }

  public async getGuidedOperation(id: string): Promise<GuidedOperation | null> {
    const result = await this.pool.query('SELECT * FROM guided_operations WHERE id = $1', [id]);
    return result.rows[0] ? guidedOperation(result.rows[0]) : null;
  }

  public async listGuidedOperationsPendingVerification(limit: number): Promise<GuidedOperation[]> {
    const result = await this.pool.query(
      `SELECT * FROM guided_operations WHERE kind = 'domain_publish' AND status = 'waiting'
       AND stage = 'pending_https_verification' ORDER BY updated_at LIMIT $1`,
      [Math.max(1, Math.min(limit, 50))],
    );
    return result.rows.map(guidedOperation);
  }

  public async withGuidedOperationLock<T>(kind: GuidedOperation['kind'], requestedByUserId: string, idempotencyKey: string, callback: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lockKey = `${kind}:${requestedByUserId}:${idempotencyKey}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
      return await callback();
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); } finally { client.release(); }
    }
  }

  public async listTlsObservationTargets(limit: number): Promise<TlsObservationTarget[]> {
    const result = await this.pool.query(
      `SELECT h.id AS domain_access_id, h.hostname, r.gateway_agent_id AS agent_id
       FROM cloudflare_public_hostnames h JOIN managed_routes r ON r.id = h.route_id
       WHERE h.enabled AND h.status = 'active' AND h.access_method = 'public_ip' AND NOT h.proxied
         AND (h.tls_observed_at IS NULL OR h.tls_observed_at < now() - interval '6 hours')
       ORDER BY h.tls_observed_at NULLS FIRST LIMIT $1`, [Math.max(1, Math.min(limit, 50))],
    );
    return result.rows.map((row) => ({ domainAccessId: row.domain_access_id, hostname: row.hostname, agentId: row.agent_id }));
  }

  public async saveTlsObservation(domainAccessId: string, observation: TlsObservation): Promise<void> {
    await this.transaction(async (client) => {
      const previous = await client.query('SELECT tls_status FROM cloudflare_public_hostnames WHERE id = $1 FOR UPDATE', [domainAccessId]);
      if (!previous.rows[0]) return;
      await client.query(
        `UPDATE cloudflare_public_hostnames SET tls_status = $2, tls_issuer = $3, tls_valid_to = $4,
         tls_error = $5, tls_observed_at = now(), updated_at = now() WHERE id = $1`,
        [domainAccessId, observation.status, observation.issuer ?? null, observation.validTo ?? null, observation.error?.slice(0, 500) ?? null],
      );
      if (observation.status === 'expiring' && previous.rows[0].tls_status !== 'expiring') {
        const scope = await client.query(
          `SELECT r.gateway_agent_id AS agent_id FROM cloudflare_public_hostnames h
           JOIN managed_routes r ON r.id = h.route_id WHERE h.id = $1`, [domainAccessId],
        );
        if (scope.rows[0]) await this.enqueueEvent(client, 'certificate.expiring', {
          agentId: scope.rows[0].agent_id, payload: { domainAccessId, validTo: observation.validTo },
        });
      }
    });
  }

  public async withDomainAccessLock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const keys = [`domain-access:${id}`];
    try {
      await this.acquireAdvisoryLock(client, keys[0]!);
      const result = await client.query(
        'SELECT access_method, deployed_account_identifier, deployed_tunnel_id FROM cloudflare_public_hostnames WHERE id = $1',
        [id],
      );
      const row = result.rows[0];
      if (row?.access_method === 'tunnel' && row.deployed_account_identifier && row.deployed_tunnel_id) {
        keys.push(`cloudflare-tunnel:${row.deployed_account_identifier}:${row.deployed_tunnel_id}`);
        await this.acquireAdvisoryLock(client, keys[1]!);
      }
      return await callback();
    } finally {
      for (const key of keys.reverse()) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]); } catch { /* Client release also releases session locks. */ }
      }
      client.release();
    }
  }

  public async hasEnabledDomainAccessDependency(dependency: 'account' | 'connector' | 'route', id: string): Promise<boolean> {
    const column = dependency === 'account' ? 'cloudflare_account_id' : dependency === 'connector' ? 'connector_id' : 'route_id';
    const result = await this.pool.query(`SELECT EXISTS (SELECT 1 FROM cloudflare_public_hostnames WHERE enabled AND ${column} = $1) AS linked`, [id]);
    return result.rows[0].linked;
  }

  public async createPendingDomainAccess(values: { accountId: string; zoneId: string; routeId: string; accessMethod: 'tunnel' | 'public_ip'; connectorId?: string; publicIpv4: string[]; publicIpv6: string[]; proxied: boolean }): Promise<CloudflareDomainAccess | null> {
    const result = await this.pool.query(
      `INSERT INTO cloudflare_public_hostnames
         (cloudflare_zone_id, cloudflare_account_id, connector_id, route_id, hostname, access_method, public_ipv4, public_ipv6, proxied,
          deployed_account_identifier, deployed_zone_identifier, deployed_tunnel_id)
       SELECT z.id, a.id, c.id, r.id, r.hostname, $4, $6::inet[], $7::inet[], $8, a.account_identifier, z.zone_identifier, c.tunnel_id
       FROM cloudflare_zones z JOIN cloudflare_accounts a ON a.id = z.cloudflare_account_id
       JOIN managed_routes r ON r.id = $3
       LEFT JOIN cloudflare_connectors c ON c.id = $5
       WHERE z.id = $2 AND a.id = $1 AND a.enabled AND z.status = 'active' AND r.enabled AND r.status = 'active'
           AND (($4 = 'tunnel' AND r.exposure = 'tunnel' AND c.enabled AND c.identity_status = 'verified' AND c.tunnel_id IS NOT NULL
                AND c.cloudflare_account_id = a.id AND lower(c.token_account_identifier) = lower(a.account_identifier)
                AND lower(c.token_tunnel_id::text) = lower(c.tunnel_id) AND c.agent_id = r.gateway_agent_id)
           OR ($4 = 'public_ip' AND r.exposure = 'public' AND c.id IS NULL))
         AND (lower(r.hostname) = lower(z.name) OR lower(r.hostname) LIKE '%.' || lower(z.name))
       ON CONFLICT DO NOTHING RETURNING *`,
      [values.accountId, values.zoneId, values.routeId, values.accessMethod, values.connectorId ?? null, values.publicIpv4, values.publicIpv6, values.proxied],
    );
    if (!result.rows[0]) return null;
    return (await this.getDomainAccess(result.rows[0].id))!;
  }

  public async setDomainAccessPending(id: string, enabled?: boolean): Promise<CloudflareDomainAccess | null> {
    const result = await this.pool.query(
      `UPDATE cloudflare_public_hostnames SET enabled = COALESCE($2, enabled), revision = revision + 1, status = 'pending',
       last_error = NULL, updated_at = now() WHERE id = $1 RETURNING id`, [id, enabled ?? null],
    );
    return result.rows[0] ? this.getDomainAccess(id) : null;
  }

  public async getCloudflareDomainAccessDeployment(id: string): Promise<CloudflareDomainAccessDeployment | null> {
    const result = await this.pool.query(
      `SELECT ${this.domainAccessColumns()}, h.deployed_account_identifier AS account_identifier, a.api_token_encrypted, a.enabled AS account_enabled,
        h.deployed_zone_identifier AS zone_identifier, z.name AS zone_name, z.status AS zone_status, z.cloudflare_account_id AS zone_account_id,
        r.enabled AS route_enabled, r.status AS route_status, r.hostname AS route_hostname,
        r.exposure AS route_exposure, r.gateway_agent_id AS route_agent_id, c.enabled AS connector_enabled,
         c.agent_id AS connector_agent_id, c.cloudflare_account_id AS connector_account_id, c.identity_status AS connector_identity_status,
         c.token_account_identifier AS connector_token_account_identifier, c.token_tunnel_id::text AS connector_token_tunnel_id,
        h.deployed_tunnel_id AS tunnel_id
       FROM cloudflare_public_hostnames h
       JOIN cloudflare_accounts a ON a.id = h.cloudflare_account_id
       JOIN cloudflare_zones z ON z.id = h.cloudflare_zone_id
       JOIN managed_routes r ON r.id = h.route_id
       LEFT JOIN cloudflare_connectors c ON c.id = h.connector_id
       WHERE h.id = $1`, [id],
    );
    const row = result.rows[0];
    return row ? {
      ...cloudflareDomainAccess(row), accountIdentifier: row.account_identifier, encryptedApiToken: row.api_token_encrypted,
      zoneIdentifier: row.zone_identifier, zoneName: row.zone_name, zoneStatus: row.zone_status,
      zoneAccountId: row.zone_account_id, accountEnabled: row.account_enabled,
      routeEnabled: row.route_enabled, routeStatus: row.route_status, routeExposure: row.route_exposure,
      routeAgentId: row.route_agent_id, routeHostname: row.route_hostname, connectorEnabled: row.connector_enabled ?? null,
      connectorAgentId: row.connector_agent_id ?? null, connectorAccountId: row.connector_account_id ?? null,
      connectorIdentityStatus: row.connector_identity_status ?? null,
      connectorTokenAccountIdentifier: row.connector_token_account_identifier ?? null,
      connectorTokenTunnelId: row.connector_token_tunnel_id ?? null,
      tunnelId: row.tunnel_id ?? null,
    } : null;
  }

  public async saveDomainAccessDnsRecord(id: string, revision: number, record: Pick<DomainAccessDnsRecord, 'type' | 'content' | 'cloudflareRecordId' | 'ownershipMarker'>): Promise<CloudflareDomainAccess | null> {
    const result = await this.pool.query(
      `INSERT INTO cloudflare_domain_access_dns_records (domain_access_id, record_type, content, cloudflare_record_id, ownership_marker)
       SELECT id, $3, $4, $5, $6 FROM cloudflare_public_hostnames WHERE id = $1 AND revision = $2
       ON CONFLICT (domain_access_id, cloudflare_record_id) DO UPDATE
       SET record_type = EXCLUDED.record_type, content = EXCLUDED.content, ownership_marker = EXCLUDED.ownership_marker,
           status = 'active', last_error = NULL, updated_at = now()
       RETURNING domain_access_id`, [id, revision, record.type, record.content, record.cloudflareRecordId, record.ownershipMarker],
    );
    return result.rows[0] ? this.getDomainAccess(id) : null;
  }

  public async markDomainAccessDnsRecordStatus(id: string, revision: number, cloudflareRecordId: string, status: 'cleanup_pending' | 'deleted', lastError?: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE cloudflare_domain_access_dns_records d SET status = $4, last_error = $5, updated_at = now()
       FROM cloudflare_public_hostnames h
       WHERE d.domain_access_id = $1 AND d.cloudflare_record_id = $3
         AND h.id = d.domain_access_id AND h.revision = $2`,
      [id, revision, cloudflareRecordId, status, status === 'cleanup_pending' ? lastError?.slice(0, 500) ?? 'Cloudflare DNS cleanup failed.' : null],
    );
    return result.rowCount === 1;
  }

  public async markDomainAccessOutcome(id: string, revision: number, values: { status: 'pending' | 'active' | 'failed' | 'disabled'; lastError?: string | null }): Promise<CloudflareDomainAccess | null> {
    const result = await this.pool.query(
      `UPDATE cloudflare_public_hostnames SET status = $2, last_error = $3,
       last_reconciled_at = now(), updated_at = now(),
       dns_record_id = (SELECT cloudflare_record_id FROM cloudflare_domain_access_dns_records
         WHERE domain_access_id = $1 AND record_type = 'CNAME' AND status = 'active' ORDER BY created_at LIMIT 1)
       WHERE id = $1 AND revision = $4 RETURNING id`, [id, values.status, values.lastError ?? null, revision],
    );
    return result.rows[0] ? this.getDomainAccess(id) : null;
  }

  private async getDomainAccess(id: string): Promise<CloudflareDomainAccess | null> {
    const result = await this.pool.query(
      `SELECT ${this.domainAccessColumns()} FROM cloudflare_public_hostnames h WHERE h.id = $1`, [id],
    );
    return result.rows[0] ? cloudflareDomainAccess(result.rows[0]) : null;
  }

  private domainAccessColumns(): string {
    return `h.*, COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'type', d.record_type, 'content', d.content, 'cloudflareRecordId', d.cloudflare_record_id,
      'ownershipMarker', d.ownership_marker, 'status', d.status, 'lastError', d.last_error
    ) ORDER BY d.created_at) FROM cloudflare_domain_access_dns_records d WHERE d.domain_access_id = h.id), '[]'::jsonb) AS owned_dns_records`;
  }

  public async listStacks(): Promise<ManagedStack[]> {
    const result = await this.pool.query('SELECT * FROM managed_stacks ORDER BY name');
    return result.rows.map(stack);
  }

  public async createStack(values: { agentId: string; name: string; projectName: string; encryptedComposeYaml: string; enabled: boolean; postgresBackupConfig?: { service: string; database: string; user: string } }): Promise<ManagedStack | null> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO managed_stacks (agent_id, name, project_name, compose_yaml_encrypted, enabled, postgres_backup_config)
         SELECT id, $2, $3, $4, $5, $6 FROM agents WHERE id = $1 AND enabled RETURNING *`,
        [values.agentId, values.name, values.projectName, values.encryptedComposeYaml, values.enabled, values.postgresBackupConfig ?? null],
      );
      if (!result.rows[0]) return null;
      const created = stack(result.rows[0]);
      await this.queueInternalSync(client, created.agentId, 'compose.stack.sync', 'stackId', created.id);
      return created;
    });
  }

  public async updateStack(id: string, values: { name?: string; encryptedComposeYaml?: string; enabled?: boolean; postgresBackupConfig?: { service: string; database: string; user: string } | null }): Promise<ManagedStack | null> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE managed_stacks s SET name = COALESCE($2, s.name),
            compose_yaml_encrypted = COALESCE($3, s.compose_yaml_encrypted), enabled = COALESCE($4, s.enabled),
            postgres_backup_config = CASE WHEN $5 THEN $6::jsonb ELSE s.postgres_backup_config END,
           revision = s.revision + 1, status = 'pending', updated_at = now()
         FROM agents a WHERE s.id = $1 AND a.id = s.agent_id AND a.enabled RETURNING s.*`,
        [id, values.name ?? null, values.encryptedComposeYaml ?? null, values.enabled ?? null, values.postgresBackupConfig !== undefined, values.postgresBackupConfig === undefined ? null : JSON.stringify(values.postgresBackupConfig)],
      );
      if (!result.rows[0]) return null;
      const updated = stack(result.rows[0]);
      await this.queueInternalSync(client, updated.agentId, 'compose.stack.sync', 'stackId', updated.id);
      return updated;
    });
  }

  public async getStackDeployment(stackId: string): Promise<StackDeployment | null> {
    const result = await this.pool.query('SELECT * FROM managed_stacks WHERE id = $1', [stackId]);
    const row = result.rows[0];
    return row ? { ...stack(row), encryptedComposeYaml: row.compose_yaml_encrypted } : null;
  }

  public async queueStackAction(stackId: string, type: 'compose.restart' | 'compose.stop'): Promise<AgentCommand | null> {
    const result = await this.pool.query(
      `INSERT INTO agent_commands (agent_id, type, payload)
       SELECT s.agent_id, $2, jsonb_build_object(
         'composePath', s.id::text || '/compose.yaml', 'stack', s.name, 'project', s.project_name
       ) FROM managed_stacks s JOIN agents a ON a.id = s.agent_id
       WHERE s.id = $1 AND s.enabled AND a.enabled RETURNING *`,
      [stackId, type],
    );
    return result.rows[0] ? command(result.rows[0]) : null;
  }

  public async listDeployments(): Promise<Deployment[]> {
    const result = await this.pool.query(
      `SELECT d.*,
        COALESCE((SELECT jsonb_agg(to_jsonb(r) - 'source_compose_encrypted' - 'normalized_compose_encrypted' ORDER BY r.created_at DESC)
          FROM deployment_revisions r WHERE r.deployment_id = d.id), '[]'::jsonb) AS revisions,
        (SELECT to_jsonb(run) FROM deployment_runs run WHERE run.deployment_id = d.id ORDER BY run.created_at DESC LIMIT 1) AS latest_run
       FROM deployments d ORDER BY d.display_name`,
    );
    return result.rows.map(deployment);
  }

  public async createDeployment(values: { agentId: string; displayName: string; projectName: string; sourceRepository: string; commitSha: string; composePath: string; encryptedSourceCompose: string; encryptedNormalizedCompose: string; checksum: string; policyVersion: number; policyResult: DeploymentRevision['policyResult']; requestedByUserId: string }): Promise<Deployment | null> {
    return this.transaction(async (client) => {
      const created = await client.query(
        `INSERT INTO deployments (agent_id, display_name, project_name, source_repository, created_by_user_id)
         SELECT id, $2, $3, $4, $5 FROM agents WHERE id = $1 AND enabled AND enrolled_at IS NOT NULL RETURNING *`,
        [values.agentId, values.displayName, values.projectName, values.sourceRepository, values.requestedByUserId],
      );
      if (!created.rows[0]) return null;
      const revision = await client.query(
        `INSERT INTO deployment_revisions (deployment_id, commit_sha, compose_path, source_compose_encrypted, normalized_compose_encrypted, checksum, policy_version, policy_result, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [created.rows[0].id, values.commitSha, values.composePath, values.encryptedSourceCompose, values.encryptedNormalizedCompose, values.checksum, values.policyVersion, values.policyResult, values.requestedByUserId],
      );
      return deployment({ ...created.rows[0], revisions: [revision.rows[0]], latest_run: null });
    });
  }

  public async createDeploymentRevision(deploymentId: string, values: { sourceRepository: string; commitSha: string; composePath: string; encryptedSourceCompose: string; encryptedNormalizedCompose: string; checksum: string; policyVersion: number; policyResult: DeploymentRevision['policyResult']; requestedByUserId: string }): Promise<DeploymentRevision | null> {
    return this.transaction(async (client) => {
      const target = await client.query('SELECT id FROM deployments WHERE id = $1 AND enabled AND source_repository = $2 FOR UPDATE', [deploymentId, values.sourceRepository]);
      if (!target.rows[0]) return null;
      const result = await client.query(
        `INSERT INTO deployment_revisions (deployment_id, commit_sha, compose_path, source_compose_encrypted, normalized_compose_encrypted, checksum, policy_version, policy_result, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (deployment_id, checksum) DO NOTHING RETURNING *`,
        [deploymentId, values.commitSha, values.composePath, values.encryptedSourceCompose, values.encryptedNormalizedCompose, values.checksum, values.policyVersion, values.policyResult, values.requestedByUserId],
      );
      return result.rows[0] ? deploymentRevision(result.rows[0]) : null;
    });
  }

  public async createDeploymentRun(deploymentId: string, revisionId: string, action: DeploymentRun['action'], requestedByUserId: string): Promise<DeploymentRun | 'active' | null> {
    return this.transaction(async (client) => {
      const target = await client.query(
        `SELECT d.*, r.id AS requested_revision_id FROM deployments d
         JOIN deployment_revisions r ON r.deployment_id = d.id AND r.id = $2
         JOIN agents a ON a.id = d.agent_id AND a.enabled AND a.enrolled_at IS NOT NULL
         WHERE d.id = $1 AND d.enabled FOR UPDATE OF d`, [deploymentId, revisionId],
      );
      if (!target.rows[0]) return null;
      const active = await client.query("SELECT 1 FROM deployment_runs WHERE deployment_id = $1 AND status IN ('pending', 'running')", [deploymentId]);
      if (active.rows[0]) return 'active';
      const runId = randomUUID();
      const command = await client.query("INSERT INTO agent_commands (agent_id, type, payload) VALUES ($1, 'deployment.compose.apply', jsonb_build_object('runId', $2::text)) RETURNING id", [target.rows[0].agent_id, runId]);
      const run = await client.query(
        `INSERT INTO deployment_runs (id, deployment_id, revision_id, prior_revision_id, agent_id, command_id, requested_by_user_id, action)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [runId, deploymentId, revisionId, target.rows[0].current_revision_id, target.rows[0].agent_id, command.rows[0].id, requestedByUserId, action],
      );
      await client.query("UPDATE deployments SET status = $2, updated_at = now() WHERE id = $1", [deploymentId, action === 'stop' ? 'stopping' : 'deploying']);
      return deploymentRun(run.rows[0]);
    });
  }

  public async getDeploymentRun(id: string): Promise<DeploymentRun | null> {
    const result = await this.pool.query('SELECT * FROM deployment_runs WHERE id = $1', [id]);
    return result.rows[0] ? deploymentRun(result.rows[0]) : null;
  }

  public async getDeploymentCommandSource(runId: string): Promise<DeploymentCommandSource | null> {
    const result = await this.pool.query(
      `SELECT r.*, d.agent_id, d.project_name, run.id AS run_id, run.command_id, run.action, run.prior_revision_id,
        prior.normalized_compose_encrypted AS encrypted_prior_normalized_compose
       FROM deployment_runs run JOIN deployments d ON d.id = run.deployment_id
       JOIN deployment_revisions r ON r.id = run.revision_id AND r.deployment_id = d.id
       LEFT JOIN deployment_revisions prior ON prior.id = run.prior_revision_id AND prior.deployment_id = d.id
       WHERE run.id = $1`, [runId],
    );
    const row = result.rows[0];
    return row ? {
      ...deploymentRevision(row), agentId: row.agent_id, projectName: row.project_name,
      encryptedNormalizedCompose: row.normalized_compose_encrypted, priorRevisionId: row.prior_revision_id ?? null,
      encryptedPriorNormalizedCompose: row.encrypted_prior_normalized_compose ?? null,
      action: row.action, runId: row.run_id, commandId: row.command_id,
    } : null;
  }

  public async listRoutes(): Promise<ManagedRoute[]> {
    const result = await this.pool.query('SELECT * FROM managed_routes ORDER BY name');
    return result.rows.map(route);
  }

  public async createRoute(values: { gatewayAgentId: string; name: string; hostname: string; exposure: 'tunnel' | 'public'; backends: string[]; enabled: boolean }): Promise<ManagedRoute | null> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO managed_routes (gateway_agent_id, name, hostname, exposure, backends, enabled)
         SELECT id, $2, $3, $4, $5::jsonb, $6 FROM agents WHERE id = $1 AND enabled RETURNING *`,
        [values.gatewayAgentId, values.name, values.hostname, values.exposure, JSON.stringify(values.backends), values.enabled],
      );
      if (!result.rows[0]) return null;
      const created = route(result.rows[0]);
      await this.queueInternalSync(client, created.gatewayAgentId, 'traefik.route.sync', 'routeId', created.id);
      return created;
    });
  }

  public async updateRoute(id: string, values: { gatewayAgentId?: string; name?: string; hostname?: string; exposure?: 'tunnel' | 'public'; backends?: string[]; enabled?: boolean }): Promise<ManagedRoute | null> {
    return this.transaction(async (client) => {
      const current = await client.query('SELECT gateway_agent_id FROM managed_routes WHERE id = $1 FOR UPDATE', [id]);
      if (!current.rows[0]) return null;
      const targetAgentId = values.gatewayAgentId ?? current.rows[0].gateway_agent_id;
      const targetAgent = await client.query('SELECT 1 FROM agents WHERE id = $1 AND enabled', [targetAgentId]);
      if (!targetAgent.rows[0]) return null;
      const result = await client.query(
        `UPDATE managed_routes SET gateway_agent_id = COALESCE($2, gateway_agent_id), name = COALESCE($3, name),
           hostname = COALESCE($4, hostname), exposure = COALESCE($5, exposure), backends = COALESCE($6::jsonb, backends),
           enabled = COALESCE($7, enabled), revision = revision + 1, status = 'pending', updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, values.gatewayAgentId ?? null, values.name ?? null, values.hostname ?? null, values.exposure ?? null, values.backends ? JSON.stringify(values.backends) : null, values.enabled ?? null],
      );
      const updated = route(result.rows[0]);
      await this.queueInternalSync(client, updated.gatewayAgentId, 'traefik.route.sync', 'routeId', updated.id);
      return updated;
    });
  }

  public async getRouteDeployment(routeId: string): Promise<ManagedRoute | null> {
    const result = await this.pool.query('SELECT * FROM managed_routes WHERE id = $1', [routeId]);
    return result.rows[0] ? route(result.rows[0]) : null;
  }

  public async getNotificationSettings(): Promise<NotificationSettings> {
    const result = await this.pool.query('SELECT telegram_bot_token_encrypted IS NOT NULL AND telegram_group_id_encrypted IS NOT NULL AS configured, selected_events FROM notification_settings WHERE singleton');
    return result.rows[0] ? { configured: result.rows[0].configured, selectedEvents: sanitizeOperationalEventTypes(result.rows[0].selected_events) } : { configured: false, selectedEvents: [...OPERATIONAL_EVENT_TYPES] };
  }

  public async getNotificationSecrets(): Promise<{ botTokenEncrypted: string; groupIdEncrypted: string } | null> {
    const result = await this.pool.query('SELECT telegram_bot_token_encrypted, telegram_group_id_encrypted FROM notification_settings WHERE singleton');
    const row = result.rows[0];
    return row?.telegram_bot_token_encrypted && row?.telegram_group_id_encrypted
      ? { botTokenEncrypted: row.telegram_bot_token_encrypted, groupIdEncrypted: row.telegram_group_id_encrypted }
      : null;
  }

  public async saveNotificationSettings(botTokenEncrypted: string, groupIdEncrypted: string, selectedEvents: string[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_settings (singleton, telegram_bot_token_encrypted, telegram_group_id_encrypted, selected_events)
       VALUES (true, $1, $2, $3) ON CONFLICT (singleton) DO UPDATE SET
       telegram_bot_token_encrypted = EXCLUDED.telegram_bot_token_encrypted,
       telegram_group_id_encrypted = EXCLUDED.telegram_group_id_encrypted,
       selected_events = EXCLUDED.selected_events, updated_at = now()`,
      [botTokenEncrypted, groupIdEncrypted, JSON.stringify(selectedEvents)],
    );
  }

  public async getNotificationTopology(agentId?: string): Promise<NotificationTopology> {
    const { maxAgents, maxServices, maxScopes } = this.notificationTopologyLimits;
    const agentResult = await this.pool.query(
      `SELECT * FROM agents WHERE archived_at IS NULL AND ($1::uuid IS NULL OR id = $1)
       ORDER BY name LIMIT $2`,
      [agentId ?? null, maxAgents + 1],
    );
    const agentRows = agentResult.rows.slice(0, maxAgents);
    const agentIds = agentRows.map((row) => row.id as string);
    const [settings, servicesResult, scopesResult] = await Promise.all([
      this.getNotificationSettings(),
      this.pool.query(
        `SELECT latest.agent_id, service.value AS service
         FROM (SELECT DISTINCT ON (agent_id) agent_id, services FROM agent_telemetry_snapshots
               WHERE agent_id = ANY($1::uuid[]) ORDER BY agent_id, created_at DESC) latest
         CROSS JOIN LATERAL jsonb_array_elements(latest.services) service
         ORDER BY latest.agent_id LIMIT $2`,
        [agentIds, maxServices + 1],
      ),
      this.pool.query(
        `SELECT agent_id, project_name, service_name, enabled FROM notification_scopes
         WHERE agent_id = ANY($1::uuid[]) ORDER BY created_at LIMIT $2`,
        [agentIds, maxScopes + 1],
      ),
    ]);
    const scopeRows = scopesResult.rows.slice(0, maxScopes) as Array<{ agent_id: string; project_name: string | null; service_name: string | null; enabled: boolean }>;
    const agentScopes = new Map<string, boolean>();
    const serviceScopes = new Map<string, { agentId: string; projectName: string; serviceName: string; enabled: boolean }>();
    for (const scope of scopeRows) {
      if (scope.project_name === null) agentScopes.set(scope.agent_id, scope.enabled);
      else if (scope.service_name !== null) serviceScopes.set(`${scope.agent_id}\u0000${scope.project_name}\u0000${scope.service_name}`, { agentId: scope.agent_id, projectName: scope.project_name, serviceName: scope.service_name, enabled: scope.enabled });
    }
    const servicesByAgent = new Map<string, Map<string, NotificationServicePreference>>();
    for (const row of servicesResult.rows.slice(0, maxServices) as Array<{ agent_id: string; service: Record<string, unknown> }>) {
      const projectName = String(row.service.projectName);
      const serviceName = String(row.service.serviceName);
      const agentEnabled = agentScopes.get(row.agent_id) ?? true;
      const directEnabled = serviceScopes.get(`${row.agent_id}\u0000${projectName}\u0000${serviceName}`)?.enabled ?? true;
      const services = servicesByAgent.get(row.agent_id) ?? new Map<string, NotificationServicePreference>();
      services.set(`${projectName}\u0000${serviceName}`, { projectName, serviceName, status: String(row.service.status) as NotificationServicePreference['status'], discovered: true, enabled: agentEnabled && directEnabled, inherited: !agentEnabled && directEnabled, directlyEnabled: directEnabled });
      servicesByAgent.set(row.agent_id, services);
    }
    for (const scope of serviceScopes.values()) {
      const services = servicesByAgent.get(scope.agentId) ?? new Map<string, NotificationServicePreference>();
      const key = `${scope.projectName}\u0000${scope.serviceName}`;
      const agentEnabled = agentScopes.get(scope.agentId) ?? true;
      if (!services.has(key)) services.set(key, { projectName: scope.projectName, serviceName: scope.serviceName, status: 'unknown', discovered: false, enabled: agentEnabled && scope.enabled, inherited: !agentEnabled && scope.enabled, directlyEnabled: scope.enabled });
      servicesByAgent.set(scope.agentId, services);
    }
    const agents = agentRows.map((row): NotificationAgentPreference => {
      const item = agent(row);
      return { id: item.id, name: item.name, healthStatus: item.healthStatus, lastTelemetryAt: item.lastTelemetryAt, enabled: agentScopes.get(item.id) ?? true, services: [...(servicesByAgent.get(item.id)?.values() ?? [])] };
    });
    return { ...settings, agents, truncated: { agents: agentResult.rows.length > maxAgents, services: servicesResult.rows.length > maxServices, scopes: scopesResult.rows.length > maxScopes } };
  }

  public async setAgentNotificationPreference(agentId: string, enabled: boolean, updatedByUserId: string): Promise<NotificationAgentPreference | null> {
    const result = await this.pool.query(
      `INSERT INTO notification_scopes (agent_id, enabled, updated_by_user_id)
       SELECT id, $2, $3 FROM agents WHERE id = $1 AND archived_at IS NULL
       ON CONFLICT (agent_id) WHERE project_name IS NULL DO UPDATE SET enabled = EXCLUDED.enabled, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
       RETURNING agent_id`,
      [agentId, enabled, updatedByUserId],
    );
    if (!result.rows[0]) return null;
    return (await this.getNotificationTopology(agentId)).agents[0] ?? null;
  }

  public async setServiceNotificationPreference(agentId: string, projectName: string, serviceName: string, enabled: boolean, updatedByUserId: string): Promise<NotificationServicePreference | null> {
    const result = await this.pool.query(
      `INSERT INTO notification_scopes (agent_id, project_name, service_name, enabled, updated_by_user_id)
       SELECT a.id, $2, $3, $4, $5 FROM agents a WHERE a.id = $1 AND a.archived_at IS NULL AND (
         EXISTS (SELECT 1 FROM notification_scopes WHERE agent_id = $1 AND project_name = $2 AND service_name = $3)
         OR EXISTS (SELECT 1 FROM agent_telemetry_snapshots s, jsonb_array_elements(s.services) service
           WHERE s.id = (SELECT id FROM agent_telemetry_snapshots WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1)
             AND service->>'projectName' = $2 AND service->>'serviceName' = $3)
       ) ON CONFLICT (agent_id, project_name, service_name) WHERE project_name IS NOT NULL
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
       RETURNING agent_id`,
      [agentId, projectName, serviceName, enabled, updatedByUserId],
    );
    if (!result.rows[0]) return null;
    return (await this.getNotificationTopology(agentId)).agents[0]?.services.find((item) => item.projectName === projectName && item.serviceName === serviceName) ?? null;
  }

  public async listAgents(): Promise<Agent[]> {
    const result = await this.pool.query('SELECT * FROM agents WHERE archived_at IS NULL ORDER BY name');
    return result.rows.map(agent);
  }

  public async createAgent(name: string, enrollmentTokenHash: string, enrollmentExpiresAt: Date): Promise<Agent> {
    const result = await this.pool.query(
      `INSERT INTO agents (name, enrollment_token_hash, enrollment_expires_at) VALUES ($1, $2, $3)
       RETURNING *`,
      [name, enrollmentTokenHash, enrollmentExpiresAt],
    );
    return agent(result.rows[0]);
  }

  public async removeAgent(id: string): Promise<'deleted' | 'archived' | 'blocked' | 'missing'> {
    return this.transaction(async (client) => {
      const agentResult = await client.query('SELECT id, enrolled_at FROM agents WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [id]);
      if (!agentResult.rows[0]) return 'missing';

      const dependencyResult = await client.query(
        `SELECT
          EXISTS (SELECT 1 FROM cloudflare_connectors WHERE agent_id = $1)
          OR EXISTS (SELECT 1 FROM managed_stacks WHERE agent_id = $1)
          OR EXISTS (SELECT 1 FROM deployments WHERE agent_id = $1)
          OR EXISTS (SELECT 1 FROM managed_routes WHERE gateway_agent_id = $1)
          OR EXISTS (SELECT 1 FROM stack_backups WHERE agent_id = $1)
          OR EXISTS (SELECT 1 FROM stack_restores WHERE agent_id = $1)
          OR EXISTS (SELECT 1 FROM agent_commands WHERE agent_id = $1 AND status IN ('pending', 'claimed'))
          AS blocked`,
        [id],
      );
      if (dependencyResult.rows[0].blocked) return 'blocked';

      const historyResult = await client.query(
        `SELECT
          EXISTS (SELECT 1 FROM agent_commands WHERE agent_id = $1)
          OR EXISTS (SELECT 1 FROM agent_telemetry_snapshots WHERE agent_id = $1)
          OR EXISTS (SELECT 1 FROM operational_events WHERE agent_id = $1)
          AS referenced`,
        [id],
      );
      if (!agentResult.rows[0].enrolled_at && !historyResult.rows[0].referenced) {
        await client.query('DELETE FROM agents WHERE id = $1', [id]);
        return 'deleted';
      }

      await client.query(
        `UPDATE agents SET enabled = false, enrollment_token_hash = NULL, enrollment_expires_at = NULL,
         credential_hash = NULL, archived_at = now(), offline_detected_at = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      return 'archived';
    });
  }

  public async enrollAgent(enrollmentTokenHash: string, credentialHash: string): Promise<Agent | null> {
    const result = await this.pool.query(
      `UPDATE agents SET credential_hash = $2, enrolled_at = now(), enrollment_token_hash = NULL,
       enrollment_expires_at = NULL, updated_at = now()
       WHERE enrollment_token_hash = $1 AND enrollment_expires_at > now() AND enrolled_at IS NULL AND enabled
       RETURNING *`,
      [enrollmentTokenHash, credentialHash],
    );
    return result.rows[0] ? agent(result.rows[0]) : null;
  }

  public async authenticateAgent(credentialHash: string): Promise<Agent | null> {
    const result = await this.pool.query(
      'SELECT * FROM agents WHERE credential_hash = $1 AND enabled',
      [credentialHash],
    );
    return result.rows[0] ? agent(result.rows[0]) : null;
  }

  public async heartbeatAgent(id: string, metadata: Record<string, unknown>): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('UPDATE agents SET last_heartbeat_at = now(), last_metadata = $2, offline_detected_at = NULL, updated_at = now() WHERE id = $1', [id, metadata]);
      const connectors = metadata.diagnostics && typeof metadata.diagnostics === 'object' && !Array.isArray(metadata.diagnostics)
        ? (metadata.diagnostics as { connectors?: unknown }).connectors : null;
      if (connectors && typeof connectors === 'object' && !Array.isArray(connectors)) {
        for (const [connectorId, value] of Object.entries(connectors).slice(0, 100)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const runtimeStatus = (value as { status?: unknown }).status;
          const error = (value as { error?: unknown }).error;
          if (!['connected', 'origin_unhealthy', 'reconnecting', 'stopped', 'failed'].includes(String(runtimeStatus))) continue;
          await client.query(
            `UPDATE cloudflare_connectors SET runtime_status = $3, last_error = $4, last_observed_at = now(), updated_at = now()
             WHERE id = $1 AND agent_id = $2 AND enabled`,
            [connectorId, id, runtimeStatus, typeof error === 'string' ? error.slice(0, 1000) : null],
          );
        }
      }
    });
  }

  public async recordTelemetry(agentId: string, snapshot: Omit<TelemetrySnapshot, 'agentId' | 'receivedAt'>): Promise<void> {
    await this.transaction(async (client) => {
      const previous = await client.query('SELECT services FROM agent_telemetry_snapshots WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1', [agentId]);
      await client.query(
        'INSERT INTO agent_telemetry_snapshots (agent_id, observed_at, node, services) VALUES ($1, $2, $3, $4)',
        [agentId, snapshot.observedAt, snapshot.node, JSON.stringify(snapshot.services)],
      );
      await client.query('UPDATE agents SET last_telemetry_at = now(), offline_detected_at = NULL, updated_at = now() WHERE id = $1', [agentId]);
      const previousServices = new Map<string, Record<string, unknown>>((previous.rows[0]?.services ?? []).map((service: Record<string, unknown>) => [String(service.name), service]));
      for (const service of snapshot.services) {
        const name = String(service.name);
        const wasUnhealthy = previousServices.get(name)?.status === 'unhealthy';
        if (service.status === 'unhealthy' && !wasUnhealthy) {
          await this.enqueueEvent(client, 'service.unhealthy', { agentId, projectName: String(service.projectName), serviceName: String(service.serviceName), payload: { service: name } });
        }
        const expiresAt = typeof service.certificateExpiresAt === 'string' ? Date.parse(service.certificateExpiresAt) : Number.NaN;
        const previousExpiry = previousServices.get(name)?.certificateExpiresAt;
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 30 * 86_400_000 && previousExpiry !== service.certificateExpiresAt) {
          await this.enqueueEvent(client, 'certificate.expiring', { agentId, projectName: String(service.projectName), serviceName: String(service.serviceName), payload: { service: name, expiresAt: service.certificateExpiresAt } });
        }
      }
    });
  }

  public async getMonitoringSummary(): Promise<TelemetrySnapshot[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (snapshot.agent_id) snapshot.* FROM agent_telemetry_snapshots snapshot
       JOIN agents agent ON agent.id = snapshot.agent_id WHERE agent.archived_at IS NULL
        ORDER BY snapshot.agent_id, snapshot.created_at DESC`,
    );
    return result.rows.map(telemetry);
  }

  public async getAgentMonitoring(agentId: string): Promise<{ agent: Agent; latest: TelemetrySnapshot | null; history: TelemetrySnapshot[] } | null> {
    const agentResult = await this.pool.query('SELECT * FROM agents WHERE id = $1 AND archived_at IS NULL', [agentId]);
    if (!agentResult.rows[0]) return null;
    const snapshots = await this.pool.query('SELECT * FROM agent_telemetry_snapshots WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 288', [agentId]);
    const history = snapshots.rows.map(telemetry);
    return { agent: agent(agentResult.rows[0]), latest: history[0] ?? null, history };
  }

  public async getLatestRuntimeInventory(): Promise<RuntimeInventory[]> {
    const result = await this.pool.query(
      `SELECT a.*, s.observed_at AS snapshot_observed_at, s.node AS snapshot_node, s.services AS snapshot_services,
        s.created_at AS snapshot_created_at FROM agents a LEFT JOIN LATERAL (
          SELECT * FROM agent_telemetry_snapshots WHERE agent_id = a.id ORDER BY created_at DESC LIMIT 1
        ) s ON true WHERE a.archived_at IS NULL ORDER BY a.name`,
    );
    return result.rows.map((row) => ({ agent: agent(row), latest: row.snapshot_observed_at ? {
      agentId: row.id, observedAt: row.snapshot_observed_at.toISOString(), node: row.snapshot_node,
      services: row.snapshot_services, receivedAt: row.snapshot_created_at.toISOString(),
    } : null }));
  }

  public async createRuntimeOperation(values: { requestedByUserId: string; agentId: string; action: RuntimeAction; scope: RuntimeScope; projectName: string; serviceName?: string }): Promise<RuntimeOperation | 'active' | null> {
    try {
      return await this.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${values.agentId}\u0000${values.projectName}`]);
        const active = await client.query(
          `SELECT 1 FROM runtime_operations WHERE agent_id = $1 AND project_name = $2 AND status IN ('pending', 'running')
           AND (service_name IS NULL OR $3::text IS NULL OR service_name = $3) LIMIT 1`,
          [values.agentId, values.projectName, values.serviceName ?? null],
        );
        if (active.rows[0]) return 'active';
        const created = await client.query(
          `INSERT INTO runtime_operations (requested_by_user_id, agent_id, action, scope, project_name, service_name)
           SELECT $1, id, $3, $4, $5, $6 FROM agents WHERE id = $2 AND enabled AND enrolled_at IS NOT NULL RETURNING *`,
          [values.requestedByUserId, values.agentId, values.action, values.scope, values.projectName, values.serviceName ?? null],
        );
        if (!created.rows[0]) return null;
        const commandResult = await client.query(
          "INSERT INTO agent_commands (agent_id, type, payload) VALUES ($1, 'compose.runtime.action', jsonb_build_object('operationId', $2::text)) RETURNING id",
          [values.agentId, created.rows[0].id],
        );
        const updated = await client.query('UPDATE runtime_operations SET command_id = $2 WHERE id = $1 RETURNING *', [created.rows[0].id, commandResult.rows[0].id]);
        return runtimeOperation(updated.rows[0]);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return 'active';
      throw error;
    }
  }

  public async listRuntimeOperations(): Promise<RuntimeOperation[]> {
    const result = await this.pool.query('SELECT * FROM runtime_operations ORDER BY created_at DESC LIMIT 200');
    return result.rows.map(runtimeOperation);
  }

  public async getRuntimeOperation(id: string): Promise<RuntimeOperation | null> {
    const result = await this.pool.query('SELECT * FROM runtime_operations WHERE id = $1', [id]);
    return result.rows[0] ? runtimeOperation(result.rows[0]) : null;
  }

  public async createRuntimeLogRequest(values: { requestedByUserId: string; agentId: string; projectName: string; serviceName: string; tail: number; since?: string }): Promise<RuntimeLogRequest | null> {
    return this.transaction(async (client) => {
      const created = await client.query(
        `INSERT INTO runtime_log_requests (requested_by_user_id, agent_id, project_name, service_name, tail, since)
         SELECT $1, id, $3, $4, $5, $6 FROM agents WHERE id = $2 AND enabled AND enrolled_at IS NOT NULL RETURNING *`,
        [values.requestedByUserId, values.agentId, values.projectName, values.serviceName, values.tail, values.since ?? null],
      );
      if (!created.rows[0]) return null;
      const commandResult = await client.query(
        "INSERT INTO agent_commands (agent_id, type, payload) VALUES ($1, 'compose.runtime.logs', jsonb_build_object('requestId', $2::text)) RETURNING id",
        [values.agentId, created.rows[0].id],
      );
      const updated = await client.query('UPDATE runtime_log_requests SET command_id = $2 WHERE id = $1 RETURNING *', [created.rows[0].id, commandResult.rows[0].id]);
      return runtimeLogRequest(updated.rows[0]);
    });
  }

  public async getRuntimeLogRequest(id: string, requestedByUserId?: string): Promise<RuntimeLogRequest | null> {
    const result = await this.pool.query(
      'SELECT * FROM runtime_log_requests WHERE id = $1 AND ($2::uuid IS NULL OR requested_by_user_id = $2)',
      [id, requestedByUserId ?? null],
    );
    return result.rows[0] ? runtimeLogRequest(result.rows[0]) : null;
  }

  public async queueLogRequest(stackId: string, requestedByUserId: string, service: string, tail: number, since?: string): Promise<AgentCommand | null> {
    const payload = { stackId, requestedByUserId, service, tail, ...(since ? { since } : {}) };
    const result = await this.pool.query(
      `INSERT INTO agent_commands (agent_id, type, payload)
       SELECT s.agent_id, 'service.logs.read', $2 FROM managed_stacks s JOIN agents a ON a.id = s.agent_id
       WHERE s.id = $1 AND s.enabled AND a.enabled RETURNING *`,
      [stackId, payload],
    );
    return result.rows[0] ? command(result.rows[0]) : null;
  }

  public async getLogRequest(commandId: string, requestedByUserId: string): Promise<AgentCommand | null> {
    const result = await this.pool.query(
      `SELECT * FROM agent_commands WHERE id = $1 AND type = 'service.logs.read' AND payload->>'requestedByUserId' = $2`,
      [commandId, requestedByUserId],
    );
    return result.rows[0] ? command(result.rows[0]) : null;
  }

  public async createBackup(stackId: string, requestedByUserId: string, target: BackupTarget): Promise<StackBackup | 'active' | null> {
    return this.transaction(async (client) => {
      const stackResult = await client.query('SELECT s.* FROM managed_stacks s JOIN agents a ON a.id = s.agent_id WHERE s.id = $1 AND s.enabled AND a.enabled FOR UPDATE OF s', [stackId]);
      if (!stackResult.rows[0]) return null;
      if (await this.hasActiveStackOperation(client, stackId)) return 'active';
      const operationId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      const commandResult = await client.query(
        `INSERT INTO agent_commands (agent_id, type, payload) VALUES ($1, 'stack.backup.create', jsonb_build_object('backupId', $2::text)) RETURNING *`,
        [stackResult.rows[0].agent_id, operationId],
      );
      const created = await client.query(
        `INSERT INTO stack_backups (id, stack_id, agent_id, command_id, requested_by_user_id, target, stack_revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [operationId, stackId, stackResult.rows[0].agent_id, commandResult.rows[0].id, requestedByUserId, target, stackResult.rows[0].revision],
      );
      return backup(created.rows[0]);
    });
  }

  public async listBackups(): Promise<StackBackup[]> {
    const result = await this.pool.query('SELECT * FROM stack_backups ORDER BY created_at DESC LIMIT 500');
    return result.rows.map(backup);
  }

  public async getBackupDeployment(backupId: string): Promise<{ backup: StackBackup; stack: StackDeployment } | null> {
    const result = await this.pool.query('SELECT * FROM stack_backups WHERE id = $1', [backupId]);
    const row = result.rows[0];
    if (!row) return null;
    const deployment = await this.getStackDeployment(row.stack_id);
    return deployment ? { backup: backup(row), stack: deployment } : null;
  }

  public async createRestore(backupId: string, requestedByUserId: string): Promise<StackRestore | 'active' | null> {
    return this.transaction(async (client) => {
      const source = await client.query(
        `SELECT b.*, s.enabled AS stack_enabled, a.enabled AS agent_enabled FROM stack_backups b
         JOIN managed_stacks s ON s.id = b.stack_id JOIN agents a ON a.id = b.agent_id
         WHERE b.id = $1 AND b.status = 'succeeded' FOR UPDATE OF b, s`, [backupId],
      );
      if (!source.rows[0] || !source.rows[0].stack_enabled || !source.rows[0].agent_enabled) return null;
      if (await this.hasActiveStackOperation(client, source.rows[0].stack_id)) return 'active';
      const operationId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      const commandResult = await client.query(
        `INSERT INTO agent_commands (agent_id, type, payload) VALUES ($1, 'stack.restore.apply', jsonb_build_object('restoreId', $2::text)) RETURNING *`,
        [source.rows[0].agent_id, operationId],
      );
      const created = await client.query(
        `INSERT INTO stack_restores (id, stack_id, backup_id, agent_id, command_id, requested_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [operationId, source.rows[0].stack_id, backupId, source.rows[0].agent_id, commandResult.rows[0].id, requestedByUserId],
      );
      return restore(created.rows[0]);
    });
  }

  public async listRestores(): Promise<StackRestore[]> {
    const result = await this.pool.query('SELECT * FROM stack_restores ORDER BY created_at DESC LIMIT 500');
    return result.rows.map(restore);
  }

  public async createSystemBackup(requestedByUserId: string, target: BackupTarget, artifactPath: string): Promise<StoredSystemBackup> {
    const result = await this.pool.query(
      'INSERT INTO system_backups (requested_by_user_id, target, artifact_path) VALUES ($1, $2, $3) RETURNING *',
      [requestedByUserId, target, artifactPath],
    );
    return systemBackup(result.rows[0]);
  }

  public async completeSystemBackup(id: string, sizeBytes: number, checksum: string): Promise<SystemBackup> {
    const result = await this.pool.query(
      "UPDATE system_backups SET status = 'succeeded', size_bytes = $2, checksum = $3, completed_at = now() WHERE id = $1 AND status = 'running' RETURNING *",
      [id, sizeBytes, checksum],
    );
    return systemBackup(result.rows[0]);
  }

  public async failSystemBackup(id: string, error: string): Promise<SystemBackup> {
    const result = await this.pool.query(
      "UPDATE system_backups SET status = 'failed', error = $2, completed_at = now() WHERE id = $1 AND status = 'running' RETURNING *",
      [id, error.slice(0, 500)],
    );
    return systemBackup(result.rows[0]);
  }

  public async listSystemBackups(): Promise<SystemBackup[]> {
    const result = await this.pool.query('SELECT * FROM system_backups ORDER BY created_at DESC LIMIT 500');
    return result.rows.map(systemBackup);
  }

  public async getSystemBackup(id: string): Promise<StoredSystemBackup | null> {
    const result = await this.pool.query("SELECT * FROM system_backups WHERE id = $1 AND status = 'succeeded'", [id]);
    return result.rows[0] ? systemBackup(result.rows[0]) : null;
  }

  public async importSystemBackup(values: { id: string; requestedByUserId: string; artifactPath: string; sizeBytes: number; checksum: string; importId: string }): Promise<'created' | 'idempotent' | 'conflict'> {
    return this.transaction(async (client) => {
      const existing = await client.query('SELECT checksum, size_bytes FROM system_backups WHERE id = $1 FOR UPDATE', [values.id]);
      if (existing.rows[0]) return existing.rows[0].checksum === values.checksum && Number(existing.rows[0].size_bytes) === values.sizeBytes ? 'idempotent' : 'conflict';
      await client.query(
        `INSERT INTO system_backups (id, requested_by_user_id, target, status, artifact_path, size_bytes, checksum, source, metadata, completed_at)
         VALUES ($1, $2, 'local', 'succeeded', $3, $4, $5, 'imported', jsonb_build_object('importId', $6::text), now())`,
        [values.id, values.requestedByUserId, values.artifactPath, values.sizeBytes, values.checksum, values.importId],
      );
      return 'created';
    });
  }

  public async createSystemBackupImport(requestedByUserId: string, quarantinePath: string): Promise<SystemBackupImport | 'active'> {
    try {
      const result = await this.pool.query('INSERT INTO system_backup_imports (requested_by_user_id, quarantine_path) VALUES ($1, $2) RETURNING *', [requestedByUserId, quarantinePath]);
      return systemBackupImport(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return 'active';
      throw error;
    }
  }

  public async updateSystemBackupImport(id: string, status: SystemBackupImport['status'], values: { sizeBytes?: number; checksum?: string; backupId?: string; error?: string } = {}): Promise<SystemBackupImport> {
    const result = await this.pool.query(
      `UPDATE system_backup_imports SET status = $2, size_bytes = COALESCE($3, size_bytes), checksum = COALESCE($4, checksum),
       backup_id = COALESCE($5, backup_id), error = $6, updated_at = now(),
       completed_at = CASE WHEN $2 IN ('imported', 'rejected') THEN now() ELSE NULL END WHERE id = $1 RETURNING *`,
      [id, status, values.sizeBytes ?? null, values.checksum ?? null, values.backupId ?? null, values.error?.slice(0, 100) ?? null],
    );
    if (!result.rows[0]) throw new Error('The system backup import record was not found.');
    return systemBackupImport(result.rows[0]);
  }

  public async claimSystemBackupImport(id: string, requestedByUserId: string): Promise<SystemBackupImport | 'validating' | null> {
    const claimed = await this.pool.query(
      `UPDATE system_backup_imports SET status = 'validating', validation_revision = validation_revision + 1, updated_at = now()
       WHERE id = $1 AND requested_by_user_id = $2 AND status = 'uploaded' RETURNING *`,
      [id, requestedByUserId],
    );
    if (claimed.rows[0]) return systemBackupImport(claimed.rows[0]);
    const current = await this.pool.query('SELECT status FROM system_backup_imports WHERE id = $1 AND requested_by_user_id = $2', [id, requestedByUserId]);
    return current.rows[0]?.status === 'validating' ? 'validating' : null;
  }

  public async finishSystemBackupImport(id: string, validationRevision: number, status: 'imported' | 'rejected', values: { backupId?: string; error?: string } = {}): Promise<SystemBackupImport | null> {
    const result = await this.pool.query(
      `UPDATE system_backup_imports SET status = $3, backup_id = COALESCE($4, backup_id), error = $5, updated_at = now(), completed_at = now()
       WHERE id = $1 AND validation_revision = $2 AND status = 'validating' RETURNING *`,
      [id, validationRevision, status, values.backupId ?? null, values.error?.slice(0, 100) ?? null],
    );
    return result.rows[0] ? systemBackupImport(result.rows[0]) : null;
  }

  public async getSystemBackupImport(id: string): Promise<SystemBackupImport | null> {
    const result = await this.pool.query('SELECT * FROM system_backup_imports WHERE id = $1', [id]);
    return result.rows[0] ? systemBackupImport(result.rows[0]) : null;
  }

  public async listSystemBackupImports(): Promise<SystemBackupImport[]> {
    const result = await this.pool.query('SELECT * FROM system_backup_imports ORDER BY created_at DESC LIMIT 100');
    return result.rows.map(systemBackupImport);
  }

  public async rejectStaleSystemBackupImports(before: Date): Promise<SystemBackupImport[]> {
    const result = await this.pool.query(
      `UPDATE system_backup_imports SET status = 'rejected', error = 'upload_interrupted', updated_at = now(), completed_at = now()
       WHERE status IN ('uploading', 'uploaded', 'validating') AND updated_at < $1 RETURNING *`, [before],
    );
    return result.rows.map(systemBackupImport);
  }

  public async recordSystemBackupTransferEvent(values: { requestedByUserId: string; operation: 'export' | 'import' | 'restore_apply_requested'; backupId?: string; restoreId?: string; importId?: string; metadata?: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO system_backup_transfer_events (requested_by_user_id, operation, backup_id, restore_id, import_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [values.requestedByUserId, values.operation, values.backupId ?? null, values.restoreId ?? null, values.importId ?? null, values.metadata ?? {}],
    );
  }

  public async createSystemRecoveryRequest(restoreId: string, requestedByUserId: string, ownershipToken: string): Promise<{ id: string; ownershipToken: string } | 'active'> {
    try {
      const result = await this.pool.query(
        'INSERT INTO system_recovery_requests (restore_id, requested_by_user_id, ownership_token) VALUES ($1, $2, $3) RETURNING id, ownership_token',
        [restoreId, requestedByUserId, ownershipToken],
      );
      return { id: result.rows[0].id, ownershipToken: result.rows[0].ownership_token };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return 'active';
      throw error;
    }
  }

  public async finishSystemRecoveryRequest(id: string, ownershipToken: string, status: 'published' | 'failed', error?: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE system_recovery_requests SET status = $3, error = $4, updated_at = now(),
       completed_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END
       WHERE id = $1 AND ownership_token = $2 AND status = 'publishing'`,
      [id, ownershipToken, status, error?.slice(0, 100) ?? null],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async createSystemRestore(backupId: string, requestedByUserId: string, status: 'staging' | 'failed', error?: string): Promise<SystemRestore> {
    const result = await this.pool.query(
      `INSERT INTO system_restores (backup_id, requested_by_user_id, status, error, completed_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'failed' THEN now() ELSE NULL END) RETURNING *`,
      [backupId, requestedByUserId, status, error?.slice(0, 500) ?? null],
    );
    return systemRestore(result.rows[0]);
  }

  public async updateSystemRestore(id: string, status: 'staged' | 'failed', error?: string): Promise<SystemRestore> {
    const result = await this.pool.query(
      `UPDATE system_restores SET status = $2, error = $3, completed_at = now()
       WHERE id = $1 AND status = 'staging' RETURNING *`,
      [id, status, error?.slice(0, 500) ?? null],
    );
    if (!result.rows[0]) throw new Error('The system restore audit record could not be transitioned.');
    return systemRestore(result.rows[0]);
  }

  public async listSystemRestores(): Promise<SystemRestore[]> {
    const result = await this.pool.query('SELECT * FROM system_restores ORDER BY created_at DESC LIMIT 500');
    return result.rows.map(systemRestore);
  }

  public async getSystemRestore(id: string): Promise<SystemRestore | null> {
    const result = await this.pool.query('SELECT * FROM system_restores WHERE id = $1', [id]);
    return result.rows[0] ? systemRestore(result.rows[0]) : null;
  }

  public async getRestoreDeployment(restoreId: string): Promise<{ restore: StackRestore; backup: StackBackup; stack: StackDeployment } | null> {
    const result = await this.pool.query('SELECT * FROM stack_restores WHERE id = $1', [restoreId]);
    const row = result.rows[0];
    if (!row) return null;
    const source = await this.getBackupDeployment(row.backup_id);
    return source ? { restore: restore(row), backup: source.backup, stack: source.stack } : null;
  }

  public async createCommand(agentId: string, type: string, payload: Record<string, unknown>): Promise<AgentCommand | null> {
    const result = await this.pool.query(
      `INSERT INTO agent_commands (agent_id, type, payload)
       SELECT id, $2, $3 FROM agents WHERE id = $1 AND enabled RETURNING *`,
      [agentId, type, payload],
    );
    return result.rows[0] ? command(result.rows[0]) : null;
  }

  public async listCommands(agentId?: string): Promise<AgentCommand[]> {
    const result = agentId
      ? await this.pool.query('SELECT * FROM agent_commands WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 200', [agentId])
      : await this.pool.query('SELECT * FROM agent_commands ORDER BY created_at DESC LIMIT 200');
    return result.rows.map(command);
  }

  public async getCommand(id: string): Promise<AgentCommand | null> {
    const result = await this.pool.query('SELECT * FROM agent_commands WHERE id = $1', [id]);
    return result.rows[0] ? command(result.rows[0]) : null;
  }

  public async claimCommands(agentId: string, limit: number): Promise<AgentCommand[]> {
    return this.transaction(async (client) => {
    await client.query('UPDATE agents SET last_command_poll_at = now(), updated_at = now() WHERE id = $1 AND enabled', [agentId]);
    const result = await client.query(
       `WITH selected AS (
          SELECT id FROM agent_commands
          WHERE agent_id = $1
            AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= now()))
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
        ) UPDATE agent_commands c SET status = 'claimed', claimed_at = now(),
          lease_expires_at = now() + CASE WHEN c.type IN ('stack.backup.create', 'stack.restore.apply', 'deployment.compose.apply')
            THEN interval '2 hours' ELSE interval '10 minutes' END, attempts = attempts + 1
       FROM selected WHERE c.id = selected.id RETURNING c.*`,
      [agentId, limit],
    );
    const commands = result.rows.map(command);
    for (const item of commands) {
      if (item.type === 'cloudflare.connector.sync' && typeof item.payload.connectorId === 'string' && typeof item.payload.revision === 'number') {
        await client.query("UPDATE cloudflare_connectors SET deployment_status = CASE WHEN enabled THEN 'deploying' ELSE 'stopping' END, last_error = NULL, updated_at = now() WHERE id = $1 AND agent_id = $2 AND desired_revision = $3", [item.payload.connectorId, agentId, item.payload.revision]);
      }
      if (item.type === 'stack.backup.create') await client.query("UPDATE stack_backups SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND status = 'pending'", [item.payload.backupId]);
      if (item.type === 'stack.restore.apply') await client.query("UPDATE stack_restores SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND status = 'pending'", [item.payload.restoreId]);
      if (item.type === 'compose.runtime.action') await client.query("UPDATE runtime_operations SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND agent_id = $2 AND status = 'pending'", [item.payload.operationId, agentId]);
      if (item.type === 'compose.runtime.logs') await client.query("UPDATE runtime_log_requests SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND agent_id = $2 AND status = 'pending'", [item.payload.requestId, agentId]);
      if (item.type === 'deployment.compose.apply') await client.query("UPDATE deployment_runs SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND agent_id = $2 AND status = 'pending'", [item.payload.runId, agentId]);
    }
    return commands;
    });
  }

  public async completeCommand(agentId: string, commandId: string, status: 'succeeded' | 'failed', result: Record<string, unknown>): Promise<'updated' | 'idempotent' | 'conflict' | 'missing'> {
    return this.transaction(async (client) => {
      const current = await client.query('SELECT status, result, type, payload FROM agent_commands WHERE id = $1 AND agent_id = $2 FOR UPDATE', [commandId, agentId]);
      if (!current.rows[0]) return 'missing';
      const commandResult = current.rows[0].type === 'compose.runtime.logs'
        ? { truncated: result.truncated === true }
        : result;
      if (current.rows[0].status === status) {
        const duplicate = await client.query('SELECT $1::jsonb = $2::jsonb AS matches', [current.rows[0].result, commandResult]);
        if (duplicate.rows[0].matches) return 'idempotent';
      }
      if (current.rows[0].status !== 'claimed') return 'conflict';
      await client.query('UPDATE agent_commands SET status = $3, result = $4, completed_at = now(), lease_expires_at = NULL WHERE id = $1 AND agent_id = $2', [commandId, agentId, status, commandResult]);
      await client.query('UPDATE agents SET last_command_result_at = now(), updated_at = now() WHERE id = $1', [agentId]);
      if (current.rows[0].type === 'agent.diagnostics.run' && status === 'succeeded' && result.diagnostics && typeof result.diagnostics === 'object') {
        await client.query('UPDATE agents SET last_diagnostics = $2, updated_at = now() WHERE id = $1', [agentId, result.diagnostics]);
      }
      if (current.rows[0].type === 'cloudflare.connector.sync' && typeof current.rows[0].payload?.connectorId === 'string' && typeof current.rows[0].payload?.revision === 'number') {
        const runtimeStatus = status === 'failed' ? 'failed' : result.runtimeStatus === 'origin_unhealthy' ? 'origin_unhealthy' : result.runtimeStatus === 'stopped' ? 'stopped' : result.runtimeStatus === 'connected' ? 'connected' : 'reconnecting';
        const safeError = status === 'failed'
          ? String(result.error || result.stderr || 'Connector deployment failed.').slice(0, 1000)
          : typeof result.message === 'string' ? result.message.slice(0, 1000) : null;
        await client.query(
          `UPDATE cloudflare_connectors SET deployment_status = $2, runtime_status = $3, last_error = $4,
           last_deployed_at = now(), last_observed_at = now(), updated_at = now()
           WHERE id = $1 AND agent_id = $5 AND desired_revision = $6`,
          [current.rows[0].payload.connectorId, status === 'succeeded' ? (runtimeStatus === 'stopped' ? 'stopped' : 'active') : 'failed', runtimeStatus, safeError, agentId, current.rows[0].payload.revision],
        );
      }
      const deploymentStatus = status === 'succeeded' ? 'active' : 'failed';
      if (current.rows[0].type === 'compose.stack.sync' && typeof current.rows[0].payload?.stackId === 'string') {
        await client.query(
          `UPDATE managed_stacks SET status = $2, updated_at = now() WHERE id = $1 AND agent_id = $3
           AND NOT EXISTS (SELECT 1 FROM agent_commands WHERE type = 'compose.stack.sync' AND status = 'pending' AND payload->>'stackId' = $1::text)`,
          [current.rows[0].payload.stackId, deploymentStatus, agentId],
        );
      }
      if (current.rows[0].type === 'traefik.route.sync' && typeof current.rows[0].payload?.routeId === 'string') {
        await client.query(
          `UPDATE managed_routes SET status = $2, updated_at = now() WHERE id = $1 AND gateway_agent_id = $3
           AND NOT EXISTS (SELECT 1 FROM agent_commands WHERE type = 'traefik.route.sync' AND status = 'pending' AND payload->>'routeId' = $1::text)`,
          [current.rows[0].payload.routeId, deploymentStatus, agentId],
        );
      }
      if (status === 'failed' && ['compose.stack.sync', 'traefik.route.sync', 'cloudflare.connector.sync'].includes(current.rows[0].type)) {
        const deployedStack = current.rows[0].type === 'compose.stack.sync' && typeof current.rows[0].payload?.stackId === 'string'
          ? await client.query('SELECT project_name FROM managed_stacks WHERE id = $1 AND agent_id = $2', [current.rows[0].payload.stackId, agentId])
          : null;
        await this.enqueueEvent(client, 'deployment.failed', { agentId, ...(deployedStack?.rows[0]?.project_name ? { projectName: deployedStack.rows[0].project_name } : {}), payload: { commandId, commandType: current.rows[0].type } });
      }
      if (current.rows[0].type === 'stack.backup.create' && typeof current.rows[0].payload?.backupId === 'string') {
        const updated = await client.query(
          'UPDATE stack_backups SET status = $2, result = $3, completed_at = now(), updated_at = now() WHERE id = $1 AND agent_id = $4 RETURNING stack_id',
          [current.rows[0].payload.backupId, status, result, agentId],
        );
        if (updated.rows[0]) {
          const stack = await client.query('SELECT project_name FROM managed_stacks WHERE id = $1', [updated.rows[0].stack_id]);
          await this.enqueueEvent(client, status === 'succeeded' ? 'backup.succeeded' : 'backup.failed', { agentId, stackId: updated.rows[0].stack_id, projectName: stack.rows[0]?.project_name, payload: { backupId: current.rows[0].payload.backupId } });
        }
      }
      if (current.rows[0].type === 'stack.restore.apply' && typeof current.rows[0].payload?.restoreId === 'string') {
        const updated = await client.query(
          'UPDATE stack_restores SET status = $2, result = $3, completed_at = now(), updated_at = now() WHERE id = $1 AND agent_id = $4 RETURNING stack_id, backup_id',
          [current.rows[0].payload.restoreId, status, result, agentId],
        );
        if (status === 'failed' && updated.rows[0]) {
          const stack = await client.query('SELECT project_name FROM managed_stacks WHERE id = $1', [updated.rows[0].stack_id]);
          await this.enqueueEvent(client, 'backup.failed', { agentId, stackId: updated.rows[0].stack_id, projectName: stack.rows[0]?.project_name, payload: { restoreId: current.rows[0].payload.restoreId, backupId: updated.rows[0].backup_id, operation: 'restore' } });
        }
      }
      if (current.rows[0].type === 'compose.runtime.action' && typeof current.rows[0].payload?.operationId === 'string') {
        const safeResult = this.safeRuntimeResult(result);
        const updated = await client.query(
          `UPDATE runtime_operations SET status = $2, result = $3, error = $4, completed_at = now(), updated_at = now()
            WHERE id = $1 AND agent_id = $5 AND status IN ('pending', 'running') RETURNING action, scope, project_name, service_name`,
          [current.rows[0].payload.operationId, status, safeResult, status === 'failed' ? String(result.error || 'Runtime action failed.').slice(0, 500) : null, agentId],
        );
        if (updated.rows[0]) await this.enqueueEvent(client, status === 'succeeded' ? 'runtime.action.succeeded' : 'runtime.action.failed', {
          agentId, projectName: updated.rows[0].project_name, serviceName: updated.rows[0].service_name ?? undefined,
          payload: { action: updated.rows[0].action, scope: updated.rows[0].scope },
        });
      }
      if (current.rows[0].type === 'compose.runtime.logs' && typeof current.rows[0].payload?.requestId === 'string') {
        const logs = typeof result.logs === 'string' ? result.logs.slice(0, 262_144) : '';
        await client.query(
          `UPDATE runtime_log_requests SET status = $2, result = $3, error = $4, completed_at = now(), updated_at = now()
            WHERE id = $1 AND agent_id = $5 AND status IN ('pending', 'running')`,
          [current.rows[0].payload.requestId, status, status === 'succeeded' ? { logs, truncated: result.truncated === true } : null, status === 'failed' ? String(result.error || 'Runtime log request failed.').slice(0, 500) : null, agentId],
        );
      }
      if (current.rows[0].type === 'deployment.compose.apply' && typeof current.rows[0].payload?.runId === 'string') {
        const safeResult = this.safeRuntimeResult(result);
        const updated = await client.query(
          `UPDATE deployment_runs SET status = $2, result = $3, error = $4, completed_at = now(), updated_at = now()
           WHERE id = $1 AND agent_id = $5 AND status IN ('pending', 'running') RETURNING deployment_id, revision_id, action`,
          [current.rows[0].payload.runId, status, safeResult, status === 'failed' ? String(result.error || 'Deployment failed.').slice(0, 500) : null, agentId],
        );
        if (updated.rows[0]) {
          const deploymentResult = await client.query(
            `UPDATE deployments SET status = $2,
             current_revision_id = CASE WHEN $3 = 'succeeded' AND $4 <> 'stop' THEN $5 ELSE current_revision_id END,
             updated_at = now() WHERE id = $1 AND agent_id = $6 RETURNING project_name`,
            [updated.rows[0].deployment_id, status === 'succeeded' ? updated.rows[0].action === 'stop' ? 'stopped' : 'active' : 'failed', status, updated.rows[0].action, updated.rows[0].revision_id, agentId],
          );
          await this.enqueueEvent(client, status === 'succeeded' ? 'deployment.succeeded' : 'deployment.failed', {
            agentId, projectName: deploymentResult.rows[0]?.project_name,
            payload: { deploymentId: updated.rows[0].deployment_id, runId: current.rows[0].payload.runId, action: updated.rows[0].action },
          });
        }
      }
      return 'updated';
    });
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async claimNotificationDelivery(): Promise<NotificationDelivery | null> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `WITH selected AS (
           SELECT id FROM notification_deliveries WHERE
             (status = 'pending' AND next_attempt_at <= now()) OR (status = 'dispatching' AND claimed_at < now() - interval '2 minutes')
           ORDER BY next_attempt_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
         ) UPDATE notification_deliveries d SET status = 'dispatching', claimed_at = now(), attempts = attempts + 1, updated_at = now()
         FROM selected WHERE d.id = selected.id RETURNING d.*`,
      );
      if (!result.rows[0]) return null;
        const eventResult = await client.query('SELECT type, agent_id, project_name, service_name, payload, occurred_at FROM operational_events WHERE id = $1', [result.rows[0].event_id]);
      const event = eventResult.rows[0];
      return { id: result.rows[0].id, eventId: result.rows[0].event_id, eventType: event.type, payload: event.payload, occurredAt: event.occurred_at.toISOString(), attempts: result.rows[0].attempts, agentId: event.agent_id ?? null, projectName: event.project_name ?? null, serviceName: event.service_name ?? null } as NotificationDelivery;
    });
  }

  public async completeNotificationDelivery(id: string): Promise<void> {
    await this.pool.query("UPDATE notification_deliveries SET status = 'succeeded', completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'dispatching'", [id]);
  }

  public async isNotificationDeliveryEnabled(delivery: NotificationDelivery): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM notification_settings settings
         WHERE settings.singleton
           AND settings.telegram_bot_token_encrypted IS NOT NULL
           AND settings.telegram_group_id_encrypted IS NOT NULL
           AND settings.selected_events ? $1
           AND ($2::uuid IS NULL OR NOT EXISTS (
             SELECT 1 FROM notification_scopes WHERE agent_id = $2 AND project_name IS NULL AND NOT enabled
           ))
           AND ($4::text IS NULL OR NOT EXISTS (
             SELECT 1 FROM notification_scopes WHERE agent_id = $2 AND project_name = $3 AND service_name = $4 AND NOT enabled
           ))
       ) AS enabled`,
      [delivery.eventType, delivery.agentId, delivery.projectName, delivery.serviceName],
    );
    return result.rows[0].enabled;
  }

  public async skipNotificationDelivery(id: string): Promise<void> {
    await this.pool.query("UPDATE notification_deliveries SET status = 'skipped', completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'dispatching'", [id]);
  }

  public async retryNotificationDelivery(id: string, error: string, delaySeconds: number, terminal: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE notification_deliveries SET status = $2, last_error = $3, next_attempt_at = now() + ($4 * interval '1 second'), claimed_at = NULL,
       completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1 AND status = 'dispatching'`,
      [id, terminal ? 'failed' : 'pending', error, delaySeconds],
    );
  }

  public async sweepOfflineAgents(offlineBefore: Date): Promise<number> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE agents SET offline_detected_at = now(), updated_at = now() WHERE enabled AND enrolled_at IS NOT NULL
         AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < $1 AND offline_detected_at IS NULL RETURNING id, name`, [offlineBefore],
      );
      for (const row of result.rows) await this.enqueueEvent(client, 'agent.offline', { agentId: row.id, payload: { agentId: row.id, agentName: row.name } });
      return result.rowCount ?? 0;
    });
  }

  public async failStaleCommands(staleBefore: Date): Promise<number> {
    return this.transaction(async (client) => {
      const safeResult = { error: 'The operation exceeded the 24-hour completion window.' };
      const commands = await client.query(
        `UPDATE agent_commands SET status = 'failed', result = $2, completed_at = now(), lease_expires_at = NULL
          WHERE status IN ('pending', 'claimed') AND (
            (type IN ('stack.backup.create', 'stack.restore.apply', 'compose.runtime.action', 'compose.runtime.logs', 'deployment.compose.apply') AND created_at < $1)
            OR (type IN ('cloudflare.connector.sync', 'cloudflare.connector.remove') AND created_at < now() - interval '30 minutes')
          )
         RETURNING id, agent_id, type, payload`,
        [staleBefore, safeResult],
      );
      for (const commandRow of commands.rows) {
        if (commandRow.type === 'cloudflare.connector.sync') {
          await client.query(
            `UPDATE cloudflare_connectors SET deployment_status = 'failed', last_error = $4, updated_at = now()
             WHERE id = $1 AND agent_id = $2 AND desired_revision = $3`,
            [commandRow.payload.connectorId, commandRow.agent_id, commandRow.payload.revision, safeResult.error],
          );
        }
        if (commandRow.type === 'stack.backup.create') {
          const operation = await client.query(
            `UPDATE stack_backups backup SET status = 'failed', result = $2, completed_at = now(), updated_at = now()
             FROM managed_stacks stack WHERE backup.command_id = $1 AND backup.status IN ('pending', 'running') AND stack.id = backup.stack_id
             RETURNING backup.id, backup.stack_id, stack.project_name`,
            [commandRow.id, safeResult],
          );
          if (operation.rows[0]) {
            await this.enqueueEvent(client, 'backup.failed', {
              agentId: commandRow.agent_id, stackId: operation.rows[0].stack_id, projectName: operation.rows[0].project_name,
              payload: { backupId: operation.rows[0].id, operation: 'backup', reason: 'stale' },
            });
          }
        }
        if (commandRow.type === 'stack.restore.apply') {
          const operation = await client.query(
            `UPDATE stack_restores restore SET status = 'failed', result = $2, completed_at = now(), updated_at = now()
             FROM managed_stacks stack WHERE restore.command_id = $1 AND restore.status IN ('pending', 'running') AND stack.id = restore.stack_id
             RETURNING restore.id, restore.stack_id, restore.backup_id, stack.project_name`,
            [commandRow.id, safeResult],
          );
          if (operation.rows[0]) {
            await this.enqueueEvent(client, 'backup.failed', {
              agentId: commandRow.agent_id, stackId: operation.rows[0].stack_id, projectName: operation.rows[0].project_name,
              payload: { restoreId: operation.rows[0].id, backupId: operation.rows[0].backup_id, operation: 'restore', reason: 'stale' },
            });
          }
        }
        if (commandRow.type === 'compose.runtime.action') {
          const operation = await client.query(
            `UPDATE runtime_operations SET status = 'failed', result = $2, error = $3, completed_at = now(), updated_at = now()
             WHERE command_id = $1 AND status IN ('pending', 'running') RETURNING action, scope, project_name, service_name`,
            [commandRow.id, safeResult, safeResult.error],
          );
          if (operation.rows[0]) await this.enqueueEvent(client, 'runtime.action.failed', {
            agentId: commandRow.agent_id, projectName: operation.rows[0].project_name, serviceName: operation.rows[0].service_name ?? undefined,
            payload: { action: operation.rows[0].action, scope: operation.rows[0].scope },
          });
        }
        if (commandRow.type === 'compose.runtime.logs') {
          await client.query(
            `UPDATE runtime_log_requests SET status = 'failed', result = $2, error = $3, completed_at = now(), updated_at = now()
             WHERE command_id = $1 AND status IN ('pending', 'running')`,
            [commandRow.id, safeResult, safeResult.error],
          );
        }
        if (commandRow.type === 'deployment.compose.apply') {
          const run = await client.query(
            `UPDATE deployment_runs SET status = 'failed', result = $2, error = $3, completed_at = now(), updated_at = now()
             WHERE command_id = $1 AND status IN ('pending', 'running') RETURNING id, deployment_id`,
            [commandRow.id, safeResult, safeResult.error],
          );
          if (run.rows[0]) await client.query("UPDATE deployments SET status = 'failed', updated_at = now() WHERE id = $1", [run.rows[0].deployment_id]);
        }
      }
      return commands.rowCount ?? 0;
    });
  }

  public async purgeRuntimeLogResults(completedBefore: Date): Promise<number> {
    return this.transaction(async (client) => {
      const result = await client.query(
        'UPDATE runtime_log_requests SET result = NULL, updated_at = now() WHERE result IS NOT NULL AND completed_at < $1 RETURNING command_id',
        [completedBefore],
      );
      const commandIds = result.rows.map((row) => row.command_id).filter((id): id is string => typeof id === 'string');
      if (commandIds.length > 0) {
        await client.query(
          "UPDATE agent_commands SET result = COALESCE(result - 'logs', '{}'::jsonb) WHERE id = ANY($1::uuid[]) AND type = 'compose.runtime.logs'",
          [commandIds],
        );
      }
      return result.rowCount ?? 0;
    });
  }

  private async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async acquireAdvisoryLock(client: PoolClient, key: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (true) {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [key]);
      if (result.rows[0].acquired) return;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for domain access reconciliation lock.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async queueConnectorSync(client: PoolClient, agentId: string, connectorId: string, revision: number, stopping = false): Promise<void> {
    await client.query("UPDATE cloudflare_connectors SET deployment_status = $2, last_error = NULL, updated_at = now() WHERE id = $1", [connectorId, stopping ? 'stopping' : 'pending']);
    const pending = await client.query(
      `UPDATE agent_commands SET payload = jsonb_build_object('connectorId', $3::text, 'revision', $4::bigint), created_at = now()
       WHERE agent_id = $1 AND type = 'cloudflare.connector.sync' AND status = 'pending' AND payload->>'connectorId' = $2 RETURNING id`,
      [agentId, connectorId, connectorId, revision],
    );
    if (!pending.rows[0]) {
      await client.query(
        `INSERT INTO agent_commands (agent_id, type, payload)
         VALUES ($1, 'cloudflare.connector.sync', jsonb_build_object('connectorId', $2::text, 'revision', $3::bigint))`,
        [agentId, connectorId, revision],
      );
    }
  }

  private async queueInternalSync(client: PoolClient, agentId: string, type: 'cloudflare.connector.sync' | 'compose.stack.sync' | 'traefik.route.sync', entityKey: 'connectorId' | 'stackId' | 'routeId', entityId: string): Promise<void> {
    await client.query(
      `INSERT INTO agent_commands (agent_id, type, payload)
       VALUES ($1, $2, jsonb_build_object($3::text, $4::text)) ON CONFLICT DO NOTHING`,
      [agentId, type, entityKey, entityId],
    );
  }

  private async hasActiveStackOperation(client: PoolClient, stackId: string): Promise<boolean> {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM stack_backups WHERE stack_id = $1 AND status IN ('pending', 'running'))
       OR EXISTS (SELECT 1 FROM stack_restores WHERE stack_id = $1 AND status IN ('pending', 'running')) AS active`, [stackId],
    );
    return result.rows[0].active;
  }

  private async enqueueEvent(client: PoolClient, type: OperationalEventType, values: { agentId?: string; stackId?: string; projectName?: string; serviceName?: string; payload: Record<string, unknown> }): Promise<void> {
    const payload = { ...values.payload, ...(values.agentId ? { agentId: values.agentId } : {}), ...(values.projectName ? { projectName: values.projectName } : {}), ...(values.serviceName ? { serviceName: values.serviceName } : {}) };
    const event = await client.query(
      'INSERT INTO operational_events (type, agent_id, stack_id, project_name, service_name, payload) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [type, values.agentId ?? null, values.stackId ?? null, values.projectName ?? null, values.serviceName ?? null, payload],
    );
    await client.query(
      `INSERT INTO notification_deliveries (event_id, channel)
       SELECT $1, 'telegram' FROM notification_settings settings WHERE singleton
         AND telegram_bot_token_encrypted IS NOT NULL AND telegram_group_id_encrypted IS NOT NULL AND selected_events ? $2
         AND ($3::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM notification_scopes WHERE agent_id = $3 AND project_name IS NULL AND NOT enabled))
         AND ($5::text IS NULL OR NOT EXISTS (SELECT 1 FROM notification_scopes WHERE agent_id = $3 AND project_name = $4 AND service_name = $5 AND NOT enabled))`,
      [event.rows[0].id, type, values.agentId ?? null, values.projectName ?? null, values.serviceName ?? null],
    );
  }

  private safeRuntimeResult(result: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    for (const key of ['matched', 'succeeded', 'failed', 'message']) {
      if (typeof result[key] === 'number' || typeof result[key] === 'string') safe[key] = typeof result[key] === 'string' ? String(result[key]).slice(0, 500) : result[key];
    }
    return safe;
  }
}
