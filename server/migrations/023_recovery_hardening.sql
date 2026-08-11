ALTER TABLE system_backup_imports
    ADD COLUMN validation_revision bigint NOT NULL DEFAULT 0 CHECK (validation_revision >= 0);

CREATE TABLE system_recovery_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    restore_id uuid NOT NULL REFERENCES system_restores(id) ON DELETE RESTRICT,
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    ownership_token uuid NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'publishing' CHECK (status IN ('publishing', 'published', 'failed')),
    error text CHECK (error IS NULL OR length(error) <= 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CHECK ((status = 'failed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX system_recovery_requests_one_active_idx ON system_recovery_requests ((true))
    WHERE status IN ('publishing', 'published');
CREATE INDEX system_recovery_requests_created_at_idx ON system_recovery_requests (created_at DESC);
