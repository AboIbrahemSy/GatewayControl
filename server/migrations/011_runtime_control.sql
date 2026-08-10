CREATE TABLE runtime_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    command_id uuid UNIQUE REFERENCES agent_commands(id) ON DELETE RESTRICT,
    action text NOT NULL CHECK (action IN ('start', 'stop', 'restart')),
    scope text NOT NULL CHECK (scope IN ('project', 'service')),
    project_name text NOT NULL CHECK (length(project_name) BETWEEN 1 AND 63),
    service_name text CHECK (((scope = 'service') = (service_name IS NOT NULL)) AND (service_name IS NULL OR length(service_name) BETWEEN 1 AND 128)),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    error text CHECK (error IS NULL OR length(error) <= 500),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX runtime_operations_active_target_unique
    ON runtime_operations (agent_id, project_name, COALESCE(service_name, ''))
    WHERE status IN ('pending', 'running');
CREATE INDEX runtime_operations_created_at_idx ON runtime_operations (created_at DESC);

CREATE TABLE runtime_log_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    command_id uuid UNIQUE REFERENCES agent_commands(id) ON DELETE RESTRICT,
    project_name text NOT NULL CHECK (length(project_name) BETWEEN 1 AND 63),
    service_name text NOT NULL CHECK (length(service_name) BETWEEN 1 AND 128),
    tail integer NOT NULL CHECK (tail BETWEEN 1 AND 1000),
    since timestamptz,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    error text CHECK (error IS NULL OR length(error) <= 500),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL))
);
CREATE INDEX runtime_log_requests_owner_created_idx ON runtime_log_requests (requested_by_user_id, created_at DESC);

ALTER TABLE operational_events DROP CONSTRAINT operational_events_type_check;
ALTER TABLE operational_events ADD CONSTRAINT operational_events_type_check
    CHECK (type IN ('agent.offline', 'service.unhealthy', 'deployment.failed', 'certificate.expiring', 'backup.failed', 'backup.succeeded', 'runtime.action.succeeded', 'runtime.action.failed'));

UPDATE agent_commands
SET status = 'failed', result = '{"error":"Legacy managed stack deployment is disabled."}'::jsonb,
    completed_at = now(), lease_expires_at = NULL
WHERE type = 'compose.stack.sync' AND status = 'pending';
