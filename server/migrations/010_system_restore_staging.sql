ALTER TABLE system_restores
    DROP CONSTRAINT system_restores_status_check,
    ALTER COLUMN completed_at DROP DEFAULT,
    ALTER COLUMN completed_at DROP NOT NULL;

ALTER TABLE system_restores
    ADD CONSTRAINT system_restores_status_check CHECK (status IN ('staging', 'staged', 'failed')),
    ADD CONSTRAINT system_restores_completion_check CHECK ((status = 'staging') = (completed_at IS NULL));
