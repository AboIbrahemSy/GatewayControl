ALTER TABLE operational_events
    DROP CONSTRAINT operational_events_type_check;

ALTER TABLE operational_events
    ADD CONSTRAINT operational_events_type_check CHECK (type IN (
        'agent.offline', 'agent.recovered', 'service.unhealthy', 'service.stopped', 'service.recovered',
        'deployment.failed', 'deployment.succeeded', 'certificate.expiring', 'backup.failed', 'backup.succeeded',
        'runtime.action.succeeded', 'runtime.action.failed'
    ));

UPDATE notification_settings
SET selected_events = (
    SELECT jsonb_agg(to_jsonb(event_name) ORDER BY position)
    FROM (
        SELECT event_name, min(position) AS position
        FROM (
            SELECT value #>> '{}' AS event_name, position
            FROM jsonb_array_elements(selected_events) WITH ORDINALITY AS selected(value, position)
            WHERE jsonb_typeof(value) = 'string'
            UNION ALL VALUES
                ('agent.recovered', 1000),
                ('service.stopped', 1001),
                ('service.recovered', 1002)
        ) events
        GROUP BY event_name
    ) unique_events
), updated_at = now()
WHERE singleton;
