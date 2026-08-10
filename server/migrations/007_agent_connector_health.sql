ALTER TABLE agents
    ADD COLUMN last_telemetry_at timestamptz,
    ADD COLUMN last_command_poll_at timestamptz,
    ADD COLUMN last_command_result_at timestamptz,
    ADD COLUMN last_diagnostics jsonb;

ALTER TABLE cloudflare_connectors
    ADD COLUMN deployment_status text NOT NULL DEFAULT 'pending'
        CHECK (deployment_status IN ('pending', 'deploying', 'active', 'failed', 'stopped')),
    ADD COLUMN runtime_status text NOT NULL DEFAULT 'unknown'
        CHECK (runtime_status IN ('unknown', 'connected', 'origin_unhealthy', 'reconnecting', 'stopped', 'failed')),
    ADD COLUMN last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
    ADD COLUMN last_deployed_at timestamptz,
    ADD COLUMN last_observed_at timestamptz;

CREATE INDEX cloudflare_connectors_deployment_status_idx
    ON cloudflare_connectors (deployment_status, updated_at);
