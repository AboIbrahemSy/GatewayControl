ALTER TABLE cloudflare_public_hostnames
    ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN deployed_account_identifier text,
    ADD COLUMN deployed_zone_identifier text,
    ADD COLUMN deployed_tunnel_id text;

UPDATE cloudflare_public_hostnames h
SET deployed_account_identifier = (SELECT a.account_identifier FROM cloudflare_accounts a WHERE a.id = h.cloudflare_account_id),
    deployed_zone_identifier = (SELECT z.zone_identifier FROM cloudflare_zones z WHERE z.id = h.cloudflare_zone_id),
    deployed_tunnel_id = (SELECT c.tunnel_id FROM cloudflare_connectors c WHERE c.id = h.connector_id);

ALTER TABLE cloudflare_public_hostnames
    ALTER COLUMN deployed_account_identifier SET NOT NULL,
    ALTER COLUMN deployed_zone_identifier SET NOT NULL;

ALTER TABLE cloudflare_domain_access_dns_records
    ADD COLUMN ownership_marker text,
    ADD COLUMN last_error text,
    DROP CONSTRAINT cloudflare_domain_access_dns_records_status_check,
    ADD CONSTRAINT cloudflare_domain_access_dns_records_status_check
        CHECK (status IN ('active', 'cleanup_pending', 'deleted'));

UPDATE cloudflare_domain_access_dns_records d
SET ownership_marker = 'gateway-control:domain-access:' || d.domain_access_id::text;

INSERT INTO cloudflare_domain_access_dns_records
    (domain_access_id, record_type, content, cloudflare_record_id, ownership_marker, status, last_error)
SELECT h.id, 'CNAME', COALESCE(c.tunnel_id || '.cfargotunnel.com', 'unknown.invalid'), h.dns_record_id,
       'gateway-control:domain-access:' || h.id::text, 'cleanup_pending',
       CASE WHEN c.tunnel_id IS NULL THEN 'Legacy DNS ownership has no persisted tunnel identifier and requires cleanup.' ELSE 'Legacy DNS ownership requires reconciliation.' END
FROM cloudflare_public_hostnames h
LEFT JOIN cloudflare_connectors c ON c.id = h.connector_id
WHERE h.dns_record_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM cloudflare_domain_access_dns_records d
      WHERE d.domain_access_id = h.id AND d.cloudflare_record_id = h.dns_record_id
  )
ON CONFLICT DO NOTHING;

UPDATE cloudflare_public_hostnames h
SET enabled = false,
    status = 'failed',
    last_error = 'Legacy DNS ownership is pending safe cleanup.',
    updated_at = now()
WHERE h.dns_record_id IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM cloudflare_domain_access_dns_records d
      WHERE d.domain_access_id = h.id AND d.cloudflare_record_id = h.dns_record_id AND d.status = 'cleanup_pending'
  );

ALTER TABLE cloudflare_domain_access_dns_records
    ALTER COLUMN ownership_marker SET NOT NULL,
    ADD CONSTRAINT cloudflare_domain_access_dns_records_ownership_marker_check
        CHECK (ownership_marker = 'gateway-control:domain-access:' || domain_access_id::text);

CREATE UNIQUE INDEX cloudflare_domain_access_dns_records_remote_id_unique
    ON cloudflare_domain_access_dns_records (cloudflare_record_id)
    WHERE cloudflare_record_id IS NOT NULL;

CREATE FUNCTION gateway_domain_access_ip_family(addresses inet[], expected_family integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT COALESCE(bool_and(family(address) = expected_family), true)
    FROM unnest(addresses) AS item(address)
$$;

ALTER TABLE cloudflare_public_hostnames
    ADD CONSTRAINT cloudflare_public_hostnames_ipv4_family_check
        CHECK (gateway_domain_access_ip_family(public_ipv4, 4)),
    ADD CONSTRAINT cloudflare_public_hostnames_ipv6_family_check
        CHECK (gateway_domain_access_ip_family(public_ipv6, 6)),
    ADD CONSTRAINT cloudflare_public_hostnames_enabled_status_coherence_check
        CHECK ((status = 'active' AND enabled) OR (status = 'disabled' AND NOT enabled) OR status IN ('pending', 'failed'));

CREATE INDEX cloudflare_public_hostnames_enabled_account_idx
    ON cloudflare_public_hostnames (cloudflare_account_id) WHERE enabled;
CREATE INDEX cloudflare_public_hostnames_enabled_connector_idx
    ON cloudflare_public_hostnames (connector_id) WHERE enabled AND connector_id IS NOT NULL;
CREATE INDEX cloudflare_public_hostnames_enabled_route_idx
    ON cloudflare_public_hostnames (route_id) WHERE enabled;

CREATE FUNCTION gateway_block_enabled_domain_access_dependency_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    linked boolean;
    topology_changed boolean;
BEGIN
    IF TG_TABLE_NAME = 'cloudflare_accounts' THEN
        topology_changed := (OLD.enabled AND NOT NEW.enabled)
            OR OLD.account_identifier IS DISTINCT FROM NEW.account_identifier
            OR OLD.api_token_encrypted IS DISTINCT FROM NEW.api_token_encrypted;
        SELECT EXISTS (SELECT 1 FROM cloudflare_public_hostnames WHERE enabled AND cloudflare_account_id = OLD.id) INTO linked;
    ELSIF TG_TABLE_NAME = 'cloudflare_connectors' THEN
        topology_changed := (OLD.enabled AND NOT NEW.enabled)
            OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
            OR OLD.cloudflare_account_id IS DISTINCT FROM NEW.cloudflare_account_id
            OR OLD.tunnel_id IS DISTINCT FROM NEW.tunnel_id
            OR OLD.token_encrypted IS DISTINCT FROM NEW.token_encrypted;
        SELECT EXISTS (SELECT 1 FROM cloudflare_public_hostnames WHERE enabled AND connector_id = OLD.id) INTO linked;
    ELSE
        topology_changed := (OLD.enabled AND NOT NEW.enabled)
            OR OLD.gateway_agent_id IS DISTINCT FROM NEW.gateway_agent_id
            OR OLD.hostname IS DISTINCT FROM NEW.hostname
            OR OLD.exposure IS DISTINCT FROM NEW.exposure;
        SELECT EXISTS (SELECT 1 FROM cloudflare_public_hostnames WHERE enabled AND route_id = OLD.id) INTO linked;
    END IF;

    IF topology_changed AND linked THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'domain_access_dependency_enabled';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER cloudflare_accounts_domain_access_guard
BEFORE UPDATE ON cloudflare_accounts
FOR EACH ROW EXECUTE FUNCTION gateway_block_enabled_domain_access_dependency_mutation();

CREATE TRIGGER cloudflare_connectors_domain_access_guard
BEFORE UPDATE ON cloudflare_connectors
FOR EACH ROW EXECUTE FUNCTION gateway_block_enabled_domain_access_dependency_mutation();

CREATE TRIGGER managed_routes_domain_access_guard
BEFORE UPDATE ON managed_routes
FOR EACH ROW EXECUTE FUNCTION gateway_block_enabled_domain_access_dependency_mutation();
