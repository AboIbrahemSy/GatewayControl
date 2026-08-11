ALTER TABLE system_backups
    ADD COLUMN source text NOT NULL DEFAULT 'created' CHECK (source IN ('created', 'imported')),
    ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object');

CREATE TABLE system_backup_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'uploaded', 'validating', 'imported', 'rejected')),
    quarantine_path text NOT NULL,
    size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
    checksum text CHECK (checksum IS NULL OR checksum ~ '^[a-f0-9]{64}$'),
    backup_id uuid REFERENCES system_backups(id) ON DELETE RESTRICT,
    error text CHECK (error IS NULL OR length(error) <= 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CHECK ((status IN ('uploading', 'uploaded', 'validating')) = (completed_at IS NULL)),
    CHECK (status NOT IN ('uploaded', 'validating', 'imported') OR (size_bytes IS NOT NULL AND checksum IS NOT NULL))
);
CREATE UNIQUE INDEX system_backup_imports_one_active_idx ON system_backup_imports ((true))
    WHERE status IN ('uploading', 'uploaded', 'validating');
CREATE INDEX system_backup_imports_created_at_idx ON system_backup_imports (created_at DESC);

CREATE TABLE system_backup_transfer_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    operation text NOT NULL CHECK (operation IN ('export', 'import', 'restore_apply_requested')),
    backup_id uuid REFERENCES system_backups(id) ON DELETE RESTRICT,
    restore_id uuid REFERENCES system_restores(id) ON DELETE RESTRICT,
    import_id uuid REFERENCES system_backup_imports(id) ON DELETE RESTRICT,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_backup_transfer_events_created_at_idx ON system_backup_transfer_events (created_at DESC);
