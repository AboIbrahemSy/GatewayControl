CREATE TABLE deployments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
    project_name text NOT NULL CHECK (project_name ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    source_repository text NOT NULL CHECK (char_length(source_repository) BETWEEN 20 AND 255),
    enabled boolean NOT NULL DEFAULT true,
    current_revision_id uuid,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deploying', 'active', 'stopping', 'stopped', 'failed')),
    created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE deployments ADD CONSTRAINT deployments_id_agent_unique UNIQUE (id, agent_id);

CREATE UNIQUE INDEX deployments_active_agent_project_unique
    ON deployments (agent_id, project_name) WHERE enabled;

CREATE TABLE deployment_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
    commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
    compose_path text NOT NULL CHECK (char_length(compose_path) BETWEEN 5 AND 255),
    source_compose_encrypted text NOT NULL,
    normalized_compose_encrypted text NOT NULL,
    checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    policy_version integer NOT NULL CHECK (policy_version > 0),
    policy_result jsonb NOT NULL,
    created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (deployment_id, checksum)
);

ALTER TABLE deployment_revisions ADD CONSTRAINT deployment_revisions_deployment_id_unique UNIQUE (deployment_id, id);

ALTER TABLE deployments
    ADD CONSTRAINT deployments_current_revision_fk
    FOREIGN KEY (id, current_revision_id) REFERENCES deployment_revisions(deployment_id, id) ON DELETE RESTRICT;

CREATE TABLE deployment_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
    revision_id uuid NOT NULL REFERENCES deployment_revisions(id) ON DELETE RESTRICT,
    prior_revision_id uuid REFERENCES deployment_revisions(id) ON DELETE RESTRICT,
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    command_id uuid NOT NULL UNIQUE REFERENCES agent_commands(id) ON DELETE RESTRICT,
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action text NOT NULL CHECK (action IN ('deploy', 'rollback', 'stop')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    result jsonb,
    error text CHECK (error IS NULL OR char_length(error) <= 500),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX deployment_runs_one_active_per_deployment
    ON deployment_runs (deployment_id) WHERE status IN ('pending', 'running');

ALTER TABLE deployment_runs
    ADD CONSTRAINT deployment_runs_revision_ownership_fk
        FOREIGN KEY (deployment_id, revision_id) REFERENCES deployment_revisions(deployment_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT deployment_runs_prior_revision_ownership_fk
        FOREIGN KEY (deployment_id, prior_revision_id) REFERENCES deployment_revisions(deployment_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT deployment_runs_agent_ownership_fk
        FOREIGN KEY (deployment_id, agent_id) REFERENCES deployments(id, agent_id) ON DELETE RESTRICT;

CREATE INDEX deployment_revisions_deployment_created_idx
    ON deployment_revisions (deployment_id, created_at DESC);

CREATE INDEX deployment_runs_deployment_created_idx
    ON deployment_runs (deployment_id, created_at DESC);

CREATE FUNCTION reject_deployment_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'deployment revisions are immutable';
END;
$$;

CREATE TRIGGER deployment_revisions_immutable
    BEFORE UPDATE OR DELETE ON deployment_revisions
    FOR EACH ROW EXECUTE FUNCTION reject_deployment_revision_mutation();

ALTER TABLE operational_events
    DROP CONSTRAINT operational_events_type_check;

ALTER TABLE operational_events
    ADD CONSTRAINT operational_events_type_check CHECK (type IN (
        'agent.offline', 'service.unhealthy', 'deployment.failed', 'deployment.succeeded',
        'certificate.expiring', 'backup.failed', 'backup.succeeded',
        'runtime.action.succeeded', 'runtime.action.failed'
    ));

UPDATE notification_settings
SET selected_events = selected_events || jsonb_build_object('deployment.succeeded', true)
WHERE singleton AND NOT selected_events ? 'deployment.succeeded';
