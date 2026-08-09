ALTER TABLE agents
    ADD COLUMN offline_detected_at timestamptz;

CREATE TABLE agent_telemetry_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    observed_at timestamptz NOT NULL,
    node jsonb NOT NULL CHECK (jsonb_typeof(node) = 'object'),
    services jsonb NOT NULL CHECK (jsonb_typeof(services) = 'array'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_telemetry_snapshots_agent_observed_idx
    ON agent_telemetry_snapshots (agent_id, observed_at DESC);
CREATE INDEX agent_telemetry_snapshots_created_at_idx
    ON agent_telemetry_snapshots (created_at);

CREATE TABLE stack_backups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stack_id uuid NOT NULL REFERENCES managed_stacks(id) ON DELETE RESTRICT,
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    command_id uuid NOT NULL REFERENCES agent_commands(id) ON DELETE RESTRICT,
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target text NOT NULL CHECK (target IN ('local', 'nas')),
    stack_revision integer NOT NULL CHECK (stack_revision > 0),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL))
);
CREATE INDEX stack_backups_stack_created_idx ON stack_backups (stack_id, created_at DESC);
CREATE INDEX stack_backups_created_at_idx ON stack_backups (created_at);
CREATE UNIQUE INDEX stack_backups_active_stack_unique
    ON stack_backups (stack_id) WHERE status IN ('pending', 'running');

CREATE TABLE stack_restores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stack_id uuid NOT NULL REFERENCES managed_stacks(id) ON DELETE RESTRICT,
    backup_id uuid NOT NULL REFERENCES stack_backups(id) ON DELETE RESTRICT,
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    command_id uuid NOT NULL REFERENCES agent_commands(id) ON DELETE RESTRICT,
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL))
);
CREATE INDEX stack_restores_stack_created_idx ON stack_restores (stack_id, created_at DESC);
CREATE INDEX stack_restores_backup_id_idx ON stack_restores (backup_id);
CREATE INDEX stack_restores_created_at_idx ON stack_restores (created_at);
CREATE UNIQUE INDEX stack_restores_active_stack_unique
    ON stack_restores (stack_id) WHERE status IN ('pending', 'running');

CREATE TABLE operational_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text NOT NULL CHECK (type IN ('agent.offline', 'service.unhealthy', 'deployment.failed', 'certificate.expiring', 'backup.failed', 'backup.succeeded')),
    agent_id uuid REFERENCES agents(id) ON DELETE RESTRICT,
    stack_id uuid REFERENCES managed_stacks(id) ON DELETE RESTRICT,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operational_events_occurred_at_idx ON operational_events (occurred_at DESC);
CREATE INDEX operational_events_agent_occurred_idx ON operational_events (agent_id, occurred_at DESC);

CREATE TABLE notification_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES operational_events(id) ON DELETE RESTRICT,
    channel text NOT NULL CHECK (channel = 'telegram'),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatching', 'succeeded', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    completed_at timestamptz,
    last_error text CHECK (last_error IS NULL OR length(last_error) <= 1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, channel)
);
CREATE INDEX notification_deliveries_claim_idx
    ON notification_deliveries (next_attempt_at, created_at)
    WHERE status IN ('pending', 'dispatching');
CREATE INDEX notification_deliveries_created_at_idx ON notification_deliveries (created_at);
