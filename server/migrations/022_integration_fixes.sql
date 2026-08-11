WITH normalized AS (
    SELECT
        settings.singleton,
        settings.telegram_bot_token_encrypted IS NULL
            AND settings.telegram_group_id_encrypted IS NULL
            AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(settings.selected_events) = 'array' THEN settings.selected_events ELSE '[]'::jsonb END
                ) AS item(value)
                WHERE jsonb_typeof(item.value) = 'string'
            )
            AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(settings.selected_events) = 'array' THEN settings.selected_events ELSE '[]'::jsonb END
                ) AS item(value)
                WHERE item.value = '{"deployment.succeeded": true}'::jsonb
            ) AS is_fresh_default_row,
        COALESCE((
            SELECT jsonb_agg(to_jsonb(value) ORDER BY first_position)
            FROM (
                SELECT value #>> '{}' AS value, min(position) AS first_position
                FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(settings.selected_events) = 'array' THEN settings.selected_events ELSE '[]'::jsonb END
                ) WITH ORDINALITY AS item(value, position)
                WHERE jsonb_typeof(value) = 'string'
                GROUP BY value #>> '{}'
            ) strings
        ), '[]'::jsonb) AS string_events
    FROM notification_settings settings
)
UPDATE notification_settings settings
SET selected_events = CASE
    WHEN normalized.is_fresh_default_row THEN '["agent.offline", "service.unhealthy", "deployment.failed", "deployment.succeeded", "certificate.expiring", "backup.failed", "backup.succeeded", "runtime.action.succeeded", "runtime.action.failed"]'::jsonb
    ELSE normalized.string_events
END,
updated_at = now()
FROM normalized
WHERE settings.singleton = normalized.singleton;

CREATE FUNCTION notification_selected_events_are_strings(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT jsonb_typeof(value) = 'array'
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END
            ) AS items(item)
            WHERE jsonb_typeof(item) <> 'string'
        );
$$;

ALTER TABLE notification_settings
    ADD CONSTRAINT notification_settings_selected_events_strings
    CHECK (notification_selected_events_are_strings(selected_events));
