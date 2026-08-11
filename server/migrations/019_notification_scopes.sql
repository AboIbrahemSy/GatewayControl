CREATE TABLE notification_scopes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    project_name text,
    service_name text,
    enabled boolean NOT NULL,
    updated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (project_name IS NULL AND service_name IS NULL)
        OR (
            project_name ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
            AND service_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
        )
    )
);
CREATE UNIQUE INDEX notification_scopes_agent_unique
    ON notification_scopes (agent_id) WHERE project_name IS NULL;
CREATE UNIQUE INDEX notification_scopes_service_unique
    ON notification_scopes (agent_id, project_name, service_name) WHERE project_name IS NOT NULL;
CREATE INDEX notification_scopes_updated_by_idx ON notification_scopes (updated_by_user_id);

ALTER TABLE operational_events
    ADD COLUMN project_name text,
    ADD COLUMN service_name text,
    ADD CONSTRAINT operational_events_scope_valid CHECK (
        (project_name IS NULL AND service_name IS NULL)
        OR (
            project_name ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
            AND (service_name IS NULL OR service_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
        )
    );

ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_status_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_check
    CHECK (status IN ('pending', 'dispatching', 'succeeded', 'failed', 'skipped'));
