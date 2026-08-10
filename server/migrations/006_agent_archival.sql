ALTER TABLE agents
    ADD COLUMN archived_at timestamptz;

ALTER TABLE agents
    DROP CONSTRAINT agents_check,
    ADD CONSTRAINT agents_enrollment_credential_state_check
        CHECK (archived_at IS NOT NULL OR ((credential_hash IS NULL) = (enrolled_at IS NULL)));

CREATE INDEX agents_active_name_idx
    ON agents (name)
    WHERE archived_at IS NULL;
