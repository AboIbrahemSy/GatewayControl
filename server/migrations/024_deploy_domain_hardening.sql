ALTER TABLE guided_operations
    ADD COLUMN verification_deadline_at timestamptz,
    ADD COLUMN verification_attempts integer NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0);

CREATE INDEX guided_operations_https_verification_idx
    ON guided_operations (verification_deadline_at, updated_at)
    WHERE kind = 'domain_publish' AND status = 'waiting' AND stage = 'pending_https_verification';
