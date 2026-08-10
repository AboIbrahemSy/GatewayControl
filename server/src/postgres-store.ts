import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Agent, AgentCommand, BackupTarget, CloudflareAccount, CloudflareAccountSecret, CloudflareHostnameDeployment, CloudflarePublicHostname, CloudflareZone, Connector, ConnectorDeployment, ManagedRoute, ManagedStack, NotificationDelivery, NotificationSettings, OperationalEventType, StackBackup, StackDeployment, StackRestore, Store, TelemetrySnapshot, User } from './types.js';

function user(row: QueryResultRow): User {
  return { id: row.id, email: row.email, role: row.role, passwordHash: row.password_hash } as User;
}

function connector(row: QueryResultRow): Connector {
  return { id: row.id, agentId: row.agent_id, name: row.name, enabled: row.enabled, cloudflareAccountId: row.cloudflare_account_id ?? null, tunnelId: row.tunnel_id ?? null, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
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

function cloudflarePublicHostname(row: QueryResultRow): CloudflarePublicHostname {
  return {
    id: row.id, cloudflareZoneId: row.cloudflare_zone_id, cloudflareAccountId: row.cloudflare_account_id,
    connectorId: row.connector_id, routeId: row.route_id, hostname: row.hostname, dnsRecordId: row.dns_record_id ?? null,
    enabled: row.enabled, proxied: row.proxied, status: row.status, lastError: row.last_error ?? null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  } as CloudflarePublicHostname;
}

function agent(row: QueryResultRow): Agent {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    enrolledAt: row.enrolled_at?.toISOString() ?? null,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
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
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  } as ManagedStack;
}

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

export class PgStore implements Store {
  private readonly pool: Pool;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    this.pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error.', { message: error.message }));
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
    const result = await this.pool.query('SELECT id, agent_id, name, enabled, cloudflare_account_id, tunnel_id, created_at, updated_at FROM cloudflare_connectors ORDER BY name');
    return result.rows.map(connector);
  }

  public async createConnector(name: string, encryptedToken: string, enabled: boolean, agentId: string, cloudflareAccountId?: string, tunnelId?: string): Promise<Connector | null> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO cloudflare_connectors (name, token_encrypted, enabled, agent_id, cloudflare_account_id, tunnel_id)
         SELECT $1, $2, $3, a.id, $5, $6 FROM agents a WHERE a.id = $4 AND a.enabled
           AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM cloudflare_accounts WHERE id = $5))
         RETURNING id, agent_id, name, enabled, cloudflare_account_id, tunnel_id, created_at, updated_at`,
        [name, encryptedToken, enabled, agentId, cloudflareAccountId ?? null, tunnelId ?? null],
      );
      if (!result.rows[0]) return null;
      const created = connector(result.rows[0]);
      if (enabled) await this.queueConnectorSync(client, created.agentId, created.id);
      return created;
    });
  }

  public async updateConnector(id: string, values: { name?: string; encryptedToken?: string; enabled?: boolean; agentId?: string; cloudflareAccountId?: string | null; tunnelId?: string | null }): Promise<Connector | null> {
    return this.transaction(async (client) => {
      const current = await client.query('SELECT agent_id FROM cloudflare_connectors WHERE id = $1 FOR UPDATE', [id]);
      if (!current.rows[0]) return null;
      const targetAgentId = values.agentId ?? current.rows[0].agent_id;
      const targetAgent = await client.query('SELECT 1 FROM agents WHERE id = $1 AND enabled', [targetAgentId]);
      if (!targetAgent.rows[0]) return null;
      if (values.cloudflareAccountId && !(await client.query('SELECT 1 FROM cloudflare_accounts WHERE id = $1', [values.cloudflareAccountId])).rows[0]) return null;
      const result = await client.query(
        `UPDATE cloudflare_connectors SET
           name = COALESCE($2, name), token_encrypted = COALESCE($3, token_encrypted),
           enabled = COALESCE($4, enabled), agent_id = COALESCE($5, agent_id),
           cloudflare_account_id = CASE WHEN $6 THEN $7::uuid ELSE cloudflare_account_id END,
           tunnel_id = CASE WHEN $8 THEN $9::text ELSE tunnel_id END, updated_at = now()
         WHERE id = $1 RETURNING id, agent_id, name, enabled, cloudflare_account_id, tunnel_id, created_at, updated_at`,
        [id, values.name ?? null, values.encryptedToken ?? null, values.enabled ?? null, values.agentId ?? null,
          values.cloudflareAccountId !== undefined, values.cloudflareAccountId ?? null, values.tunnelId !== undefined, values.tunnelId ?? null],
      );
      const updated = connector(result.rows[0]);
      await this.queueConnectorSync(client, updated.agentId, updated.id);
      return updated;
    });
  }

  public async getConnectorDeployment(connectorId: string): Promise<ConnectorDeployment | null> {
    const result = await this.pool.query(
      'SELECT id, agent_id, name, enabled, token_encrypted, cloudflare_account_id, tunnel_id FROM cloudflare_connectors WHERE id = $1',
      [connectorId],
    );
    const row = result.rows[0];
    return row ? { connectorId: row.id, agentId: row.agent_id, name: row.name, enabled: row.enabled, encryptedToken: row.token_encrypted, cloudflareAccountId: row.cloudflare_account_id ?? null, tunnelId: row.tunnel_id ?? null } : null;
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

  public async syncCloudflareZones(accountId: string, zones: Array<{ zoneIdentifier: string; name: string; status: string }>, error?: string): Promise<CloudflareZone[] | null> {
    return this.transaction(async (client) => {
      const account = await client.query(
        `UPDATE cloudflare_accounts SET last_synced_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_synced_at END,
         last_error_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, last_error = $2, updated_at = now()
         WHERE id = $1 RETURNING id`, [accountId, error ?? null],
      );
      if (!account.rows[0]) return null;
      if (!error) {
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

  public async listCloudflarePublicHostnames(): Promise<CloudflarePublicHostname[]> {
    const result = await this.pool.query('SELECT * FROM cloudflare_public_hostnames ORDER BY hostname');
    return result.rows.map(cloudflarePublicHostname);
  }

  public async createPendingCloudflarePublicHostname(values: { zoneId: string; connectorId: string; routeId: string; proxied: boolean }): Promise<CloudflarePublicHostname | null> {
    const result = await this.pool.query(
      `INSERT INTO cloudflare_public_hostnames (cloudflare_zone_id, cloudflare_account_id, connector_id, route_id, hostname, proxied)
       SELECT z.id, z.cloudflare_account_id, c.id, r.id, r.hostname, $4
       FROM cloudflare_zones z JOIN cloudflare_accounts a ON a.id = z.cloudflare_account_id
       JOIN cloudflare_connectors c ON c.id = $2 AND c.cloudflare_account_id = a.id
       JOIN managed_routes r ON r.id = $3
       WHERE z.id = $1 AND a.enabled AND c.enabled AND c.tunnel_id IS NOT NULL AND r.enabled AND r.exposure = 'tunnel'
         AND (lower(r.hostname) = lower(z.name) OR lower(r.hostname) LIKE '%.' || lower(z.name))
       RETURNING *`, [values.zoneId, values.connectorId, values.routeId, values.proxied],
    );
    return result.rows[0] ? cloudflarePublicHostname(result.rows[0]) : null;
  }

  public async setCloudflarePublicHostnamePending(id: string, enabled: boolean): Promise<CloudflarePublicHostname | null> {
    const result = await this.pool.query(
      `UPDATE cloudflare_public_hostnames SET enabled = $2,
       status = CASE WHEN enabled = $2 AND status = 'active' THEN status ELSE 'pending' END,
       last_error = CASE WHEN enabled = $2 AND status = 'active' THEN last_error ELSE NULL END, updated_at = now()
       WHERE id = $1 RETURNING *`, [id, enabled],
    );
    return result.rows[0] ? cloudflarePublicHostname(result.rows[0]) : null;
  }

  public async getCloudflareHostnameDeployment(id: string): Promise<CloudflareHostnameDeployment | null> {
    const result = await this.pool.query(
      `SELECT h.*, a.account_identifier, a.api_token_encrypted, z.zone_identifier, c.tunnel_id
       FROM cloudflare_public_hostnames h JOIN cloudflare_accounts a ON a.id = h.cloudflare_account_id
       JOIN cloudflare_zones z ON z.id = h.cloudflare_zone_id JOIN cloudflare_connectors c ON c.id = h.connector_id
       WHERE h.id = $1 AND c.cloudflare_account_id = h.cloudflare_account_id AND z.cloudflare_account_id = h.cloudflare_account_id
       AND c.tunnel_id IS NOT NULL`, [id],
    );
    const row = result.rows[0];
    return row ? { ...cloudflarePublicHostname(row), accountIdentifier: row.account_identifier, encryptedApiToken: row.api_token_encrypted, zoneIdentifier: row.zone_identifier, tunnelId: row.tunnel_id } : null;
  }

  public async markCloudflareHostnameOutcome(id: string, values: { status: 'active' | 'failed'; enabled: boolean; dnsRecordId?: string | null; lastError?: string | null }): Promise<CloudflarePublicHostname | null> {
    const result = await this.pool.query(
      `UPDATE cloudflare_public_hostnames SET status = $2, enabled = $3,
       dns_record_id = CASE WHEN $4 THEN $5::text ELSE dns_record_id END, last_error = $6, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, values.status, values.enabled, values.dnsRecordId !== undefined, values.dnsRecordId ?? null, values.lastError ?? null],
    );
    return result.rows[0] ? cloudflarePublicHostname(result.rows[0]) : null;
  }

  public async listStacks(): Promise<ManagedStack[]> {
    const result = await this.pool.query('SELECT * FROM managed_stacks ORDER BY name');
    return result.rows.map(stack);
  }

  public async createStack(values: { agentId: string; name: string; projectName: string; encryptedComposeYaml: string; enabled: boolean }): Promise<ManagedStack | null> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO managed_stacks (agent_id, name, project_name, compose_yaml_encrypted, enabled)
         SELECT id, $2, $3, $4, $5 FROM agents WHERE id = $1 AND enabled RETURNING *`,
        [values.agentId, values.name, values.projectName, values.encryptedComposeYaml, values.enabled],
      );
      if (!result.rows[0]) return null;
      const created = stack(result.rows[0]);
      await this.queueInternalSync(client, created.agentId, 'compose.stack.sync', 'stackId', created.id);
      return created;
    });
  }

  public async updateStack(id: string, values: { name?: string; encryptedComposeYaml?: string; enabled?: boolean }): Promise<ManagedStack | null> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE managed_stacks s SET name = COALESCE($2, s.name),
           compose_yaml_encrypted = COALESCE($3, s.compose_yaml_encrypted), enabled = COALESCE($4, s.enabled),
           revision = s.revision + 1, status = 'pending', updated_at = now()
         FROM agents a WHERE s.id = $1 AND a.id = s.agent_id AND a.enabled RETURNING s.*`,
        [id, values.name ?? null, values.encryptedComposeYaml ?? null, values.enabled ?? null],
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
    return result.rows[0] ? { configured: result.rows[0].configured, selectedEvents: result.rows[0].selected_events } : { configured: false, selectedEvents: [] };
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

  public async listAgents(): Promise<Agent[]> {
    const result = await this.pool.query('SELECT id, name, enabled, enrolled_at, last_heartbeat_at, created_at FROM agents WHERE archived_at IS NULL ORDER BY name');
    return result.rows.map(agent);
  }

  public async createAgent(name: string, enrollmentTokenHash: string, enrollmentExpiresAt: Date): Promise<Agent> {
    const result = await this.pool.query(
      `INSERT INTO agents (name, enrollment_token_hash, enrollment_expires_at) VALUES ($1, $2, $3)
       RETURNING id, name, enabled, enrolled_at, last_heartbeat_at, created_at`,
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
       RETURNING id, name, enabled, enrolled_at, last_heartbeat_at, created_at`,
      [enrollmentTokenHash, credentialHash],
    );
    return result.rows[0] ? agent(result.rows[0]) : null;
  }

  public async authenticateAgent(credentialHash: string): Promise<Agent | null> {
    const result = await this.pool.query(
      'SELECT id, name, enabled, enrolled_at, last_heartbeat_at, created_at FROM agents WHERE credential_hash = $1 AND enabled',
      [credentialHash],
    );
    return result.rows[0] ? agent(result.rows[0]) : null;
  }

  public async heartbeatAgent(id: string, metadata: Record<string, unknown>): Promise<void> {
    await this.pool.query('UPDATE agents SET last_heartbeat_at = now(), last_metadata = $2, offline_detected_at = NULL, updated_at = now() WHERE id = $1', [id, metadata]);
  }

  public async recordTelemetry(agentId: string, snapshot: Omit<TelemetrySnapshot, 'agentId' | 'receivedAt'>): Promise<void> {
    await this.transaction(async (client) => {
      const previous = await client.query('SELECT services FROM agent_telemetry_snapshots WHERE agent_id = $1 ORDER BY observed_at DESC LIMIT 1', [agentId]);
      await client.query(
        'INSERT INTO agent_telemetry_snapshots (agent_id, observed_at, node, services) VALUES ($1, $2, $3, $4)',
        [agentId, snapshot.observedAt, snapshot.node, JSON.stringify(snapshot.services)],
      );
      await client.query('UPDATE agents SET last_heartbeat_at = now(), offline_detected_at = NULL, updated_at = now() WHERE id = $1', [agentId]);
      const previousServices = new Map<string, Record<string, unknown>>((previous.rows[0]?.services ?? []).map((service: Record<string, unknown>) => [String(service.name), service]));
      for (const service of snapshot.services) {
        const name = String(service.name);
        const wasUnhealthy = previousServices.get(name)?.status === 'unhealthy';
        if (service.status === 'unhealthy' && !wasUnhealthy) {
          await this.enqueueEvent(client, 'service.unhealthy', { agentId, payload: { service: name } });
        }
        const expiresAt = typeof service.certificateExpiresAt === 'string' ? Date.parse(service.certificateExpiresAt) : Number.NaN;
        const previousExpiry = previousServices.get(name)?.certificateExpiresAt;
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 30 * 86_400_000 && previousExpiry !== service.certificateExpiresAt) {
          await this.enqueueEvent(client, 'certificate.expiring', { agentId, payload: { service: name, expiresAt: service.certificateExpiresAt } });
        }
      }
    });
  }

  public async getMonitoringSummary(): Promise<TelemetrySnapshot[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (snapshot.agent_id) snapshot.* FROM agent_telemetry_snapshots snapshot
       JOIN agents agent ON agent.id = snapshot.agent_id WHERE agent.archived_at IS NULL
       ORDER BY snapshot.agent_id, snapshot.observed_at DESC`,
    );
    return result.rows.map(telemetry);
  }

  public async getAgentMonitoring(agentId: string): Promise<{ agent: Agent; latest: TelemetrySnapshot | null; history: TelemetrySnapshot[] } | null> {
    const agentResult = await this.pool.query('SELECT id, name, enabled, enrolled_at, last_heartbeat_at, created_at FROM agents WHERE id = $1 AND archived_at IS NULL', [agentId]);
    if (!agentResult.rows[0]) return null;
    const snapshots = await this.pool.query('SELECT * FROM agent_telemetry_snapshots WHERE agent_id = $1 ORDER BY observed_at DESC LIMIT 288', [agentId]);
    const history = snapshots.rows.map(telemetry);
    return { agent: agent(agentResult.rows[0]), latest: history[0] ?? null, history };
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

  public async claimCommands(agentId: string, limit: number): Promise<AgentCommand[]> {
    const result = await this.pool.query(
       `WITH selected AS (
          SELECT id FROM agent_commands
          WHERE agent_id = $1
            AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= now()))
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
        ) UPDATE agent_commands c SET status = 'claimed', claimed_at = now(),
          lease_expires_at = now() + CASE WHEN c.type IN ('stack.backup.create', 'stack.restore.apply')
            THEN interval '2 hours' ELSE interval '10 minutes' END, attempts = attempts + 1
       FROM selected WHERE c.id = selected.id RETURNING c.*`,
      [agentId, limit],
    );
    const commands = result.rows.map(command);
    for (const item of commands) {
      if (item.type === 'stack.backup.create') await this.pool.query("UPDATE stack_backups SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND status = 'pending'", [item.payload.backupId]);
      if (item.type === 'stack.restore.apply') await this.pool.query("UPDATE stack_restores SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND status = 'pending'", [item.payload.restoreId]);
    }
    return commands;
  }

  public async completeCommand(agentId: string, commandId: string, status: 'succeeded' | 'failed', result: Record<string, unknown>): Promise<'updated' | 'idempotent' | 'conflict' | 'missing'> {
    return this.transaction(async (client) => {
      const current = await client.query('SELECT status, result, type, payload FROM agent_commands WHERE id = $1 AND agent_id = $2 FOR UPDATE', [commandId, agentId]);
      if (!current.rows[0]) return 'missing';
      if (current.rows[0].status === status && JSON.stringify(current.rows[0].result) === JSON.stringify(result)) return 'idempotent';
      if (current.rows[0].status !== 'claimed') return 'conflict';
      await client.query('UPDATE agent_commands SET status = $3, result = $4, completed_at = now(), lease_expires_at = NULL WHERE id = $1 AND agent_id = $2', [commandId, agentId, status, result]);
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
        await this.enqueueEvent(client, 'deployment.failed', { agentId, payload: { commandId, commandType: current.rows[0].type } });
      }
      if (current.rows[0].type === 'stack.backup.create' && typeof current.rows[0].payload?.backupId === 'string') {
        const updated = await client.query(
          'UPDATE stack_backups SET status = $2, result = $3, completed_at = now(), updated_at = now() WHERE id = $1 AND agent_id = $4 RETURNING stack_id',
          [current.rows[0].payload.backupId, status, result, agentId],
        );
        if (updated.rows[0]) await this.enqueueEvent(client, status === 'succeeded' ? 'backup.succeeded' : 'backup.failed', { agentId, stackId: updated.rows[0].stack_id, payload: { backupId: current.rows[0].payload.backupId } });
      }
      if (current.rows[0].type === 'stack.restore.apply' && typeof current.rows[0].payload?.restoreId === 'string') {
        const updated = await client.query(
          'UPDATE stack_restores SET status = $2, result = $3, completed_at = now(), updated_at = now() WHERE id = $1 AND agent_id = $4 RETURNING stack_id, backup_id',
          [current.rows[0].payload.restoreId, status, result, agentId],
        );
        if (status === 'failed' && updated.rows[0]) await this.enqueueEvent(client, 'backup.failed', { agentId, stackId: updated.rows[0].stack_id, payload: { restoreId: current.rows[0].payload.restoreId, backupId: updated.rows[0].backup_id, operation: 'restore' } });
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
      const eventResult = await client.query('SELECT type, payload, occurred_at FROM operational_events WHERE id = $1', [result.rows[0].event_id]);
      const event = eventResult.rows[0];
      return { id: result.rows[0].id, eventId: result.rows[0].event_id, eventType: event.type, payload: event.payload, occurredAt: event.occurred_at.toISOString(), attempts: result.rows[0].attempts } as NotificationDelivery;
    });
  }

  public async completeNotificationDelivery(id: string): Promise<void> {
    await this.pool.query("UPDATE notification_deliveries SET status = 'succeeded', completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'dispatching'", [id]);
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
         WHERE type IN ('stack.backup.create', 'stack.restore.apply') AND status IN ('pending', 'claimed') AND created_at < $1
         RETURNING id, agent_id, type, payload`,
        [staleBefore, safeResult],
      );
      for (const commandRow of commands.rows) {
        if (commandRow.type === 'stack.backup.create') {
          const operation = await client.query(
            `UPDATE stack_backups SET status = 'failed', result = $2, completed_at = now(), updated_at = now()
             WHERE command_id = $1 AND status IN ('pending', 'running') RETURNING id, stack_id`,
            [commandRow.id, safeResult],
          );
          if (operation.rows[0]) {
            await this.enqueueEvent(client, 'backup.failed', {
              agentId: commandRow.agent_id, stackId: operation.rows[0].stack_id,
              payload: { backupId: operation.rows[0].id, operation: 'backup', reason: 'stale' },
            });
          }
        }
        if (commandRow.type === 'stack.restore.apply') {
          const operation = await client.query(
            `UPDATE stack_restores SET status = 'failed', result = $2, completed_at = now(), updated_at = now()
             WHERE command_id = $1 AND status IN ('pending', 'running') RETURNING id, stack_id, backup_id`,
            [commandRow.id, safeResult],
          );
          if (operation.rows[0]) {
            await this.enqueueEvent(client, 'backup.failed', {
              agentId: commandRow.agent_id, stackId: operation.rows[0].stack_id,
              payload: { restoreId: operation.rows[0].id, backupId: operation.rows[0].backup_id, operation: 'restore', reason: 'stale' },
            });
          }
        }
      }
      return commands.rowCount ?? 0;
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

  private async queueConnectorSync(client: PoolClient, agentId: string, connectorId: string): Promise<void> {
    await this.queueInternalSync(client, agentId, 'cloudflare.connector.sync', 'connectorId', connectorId);
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

  private async enqueueEvent(client: PoolClient, type: OperationalEventType, values: { agentId?: string; stackId?: string; payload: Record<string, unknown> }): Promise<void> {
    const event = await client.query(
      'INSERT INTO operational_events (type, agent_id, stack_id, payload) VALUES ($1, $2, $3, $4) RETURNING id',
      [type, values.agentId ?? null, values.stackId ?? null, values.payload],
    );
    await client.query(
      `INSERT INTO notification_deliveries (event_id, channel)
       SELECT $1, 'telegram' FROM notification_settings WHERE singleton AND selected_events ? $2`, [event.rows[0].id, type],
    );
  }
}
