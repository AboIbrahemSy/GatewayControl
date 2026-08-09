CREATE TABLE managed_stacks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agents(id),
    name text NOT NULL,
    project_name text NOT NULL,
    compose_yaml_encrypted text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, name)
);

CREATE INDEX managed_stacks_agent_id_idx ON managed_stacks (agent_id);

CREATE TABLE managed_routes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gateway_agent_id uuid NOT NULL REFERENCES agents(id),
    name text NOT NULL,
    hostname text NOT NULL UNIQUE,
    exposure text NOT NULL CHECK (exposure IN ('tunnel', 'public')),
    backends jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (gateway_agent_id, name),
    CHECK (jsonb_typeof(backends) = 'array')
);

CREATE INDEX managed_routes_gateway_agent_id_idx ON managed_routes (gateway_agent_id);

ALTER TABLE agent_commands
    ADD COLUMN attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN lease_expires_at timestamptz;

UPDATE agent_commands
SET lease_expires_at = COALESCE(claimed_at, now())
WHERE status = 'claimed';

WITH duplicate_commands AS (
    SELECT id, row_number() OVER (
        PARTITION BY agent_id, type,
            CASE
                WHEN type = 'cloudflare.connector.sync' THEN payload ->> 'connectorId'
                WHEN type = 'compose.stack.sync' THEN payload ->> 'stackId'
                WHEN type = 'traefik.route.sync' THEN payload ->> 'routeId'
            END
        ORDER BY created_at DESC, id DESC
    ) AS position
    FROM agent_commands
    WHERE status = 'pending'
      AND type IN ('cloudflare.connector.sync', 'compose.stack.sync', 'traefik.route.sync')
)
DELETE FROM agent_commands
USING duplicate_commands
WHERE agent_commands.id = duplicate_commands.id
  AND duplicate_commands.position > 1;

CREATE UNIQUE INDEX agent_commands_pending_connector_sync_unique
    ON agent_commands (agent_id, (payload ->> 'connectorId'))
    WHERE type = 'cloudflare.connector.sync' AND status = 'pending';

CREATE UNIQUE INDEX agent_commands_pending_stack_sync_unique
    ON agent_commands (agent_id, (payload ->> 'stackId'))
    WHERE type = 'compose.stack.sync' AND status = 'pending';

CREATE UNIQUE INDEX agent_commands_pending_route_sync_unique
    ON agent_commands (agent_id, (payload ->> 'routeId'))
    WHERE type = 'traefik.route.sync' AND status = 'pending';
