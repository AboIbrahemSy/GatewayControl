WITH retired_commands AS (
    UPDATE agent_commands
    SET status = 'failed',
        result = '{"error":"Legacy managed stack deployment is permanently unsupported."}'::jsonb,
        completed_at = COALESCE(completed_at, now()),
        lease_expires_at = NULL
    WHERE type = 'compose.stack.sync'
      AND status IN ('pending', 'claimed')
    RETURNING agent_id, payload
)
UPDATE managed_stacks stack
SET status = 'failed', updated_at = now()
FROM retired_commands command
WHERE command.payload ->> 'stackId' = stack.id::text
  AND command.agent_id = stack.agent_id;

UPDATE agent_commands
SET result = COALESCE(result - 'logs', '{}'::jsonb)
WHERE type = 'compose.runtime.logs'
  AND result ? 'logs';

UPDATE runtime_log_requests
SET result = NULL, updated_at = now()
WHERE result IS NOT NULL
  AND completed_at < now() - interval '24 hours';

CREATE INDEX runtime_log_requests_result_retention_idx
    ON runtime_log_requests (completed_at)
    WHERE result IS NOT NULL;
