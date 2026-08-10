CREATE TABLE system_backups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target text NOT NULL CHECK (target IN ('local', 'nas')),
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    artifact_path text NOT NULL,
    size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
    checksum text CHECK (checksum IS NULL OR checksum ~ '^[a-f0-9]{64}$'),
    error text CHECK (error IS NULL OR length(error) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CHECK ((status = 'running') = (completed_at IS NULL))
);
CREATE INDEX system_backups_created_at_idx ON system_backups (created_at DESC);

CREATE TABLE system_restores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_id uuid NOT NULL REFERENCES system_backups(id) ON DELETE RESTRICT,
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('staged', 'failed')),
    error text CHECK (error IS NULL OR length(error) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_restores_created_at_idx ON system_restores (created_at DESC);
CREATE INDEX system_restores_backup_id_idx ON system_restores (backup_id);
