ALTER TABLE managed_stacks
    ADD COLUMN postgres_backup_config jsonb
        CHECK (postgres_backup_config IS NULL OR jsonb_typeof(postgres_backup_config) = 'object');
