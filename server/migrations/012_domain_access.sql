ALTER TABLE cloudflare_public_hostnames
    ALTER COLUMN connector_id DROP NOT NULL,
    ADD COLUMN access_method text NOT NULL DEFAULT 'tunnel',
    ADD COLUMN public_ipv4 inet[] NOT NULL DEFAULT '{}',
    ADD COLUMN public_ipv6 inet[] NOT NULL DEFAULT '{}',
    ADD COLUMN last_reconciled_at timestamptz,
    DROP CONSTRAINT cloudflare_public_hostnames_status_check,
    ADD CONSTRAINT cloudflare_public_hostnames_status_check
        CHECK (status IN ('pending', 'active', 'failed', 'disabled')),
    ADD CONSTRAINT cloudflare_public_hostnames_access_method_check
        CHECK (access_method IN ('tunnel', 'public_ip')),
    ADD CONSTRAINT cloudflare_public_hostnames_ip_bounds_check
        CHECK (cardinality(public_ipv4) <= 4 AND cardinality(public_ipv6) <= 4),
    ADD CONSTRAINT cloudflare_public_hostnames_access_configuration_check
        CHECK (
            (access_method = 'tunnel' AND connector_id IS NOT NULL AND cardinality(public_ipv4) = 0 AND cardinality(public_ipv6) = 0)
            OR
            (access_method = 'public_ip' AND connector_id IS NULL AND cardinality(public_ipv4) + cardinality(public_ipv6) >= 1)
        );

CREATE TABLE cloudflare_domain_access_dns_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_access_id uuid NOT NULL REFERENCES cloudflare_public_hostnames(id) ON DELETE RESTRICT,
    record_type text NOT NULL CHECK (record_type IN ('A', 'AAAA', 'CNAME')),
    content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 253),
    cloudflare_record_id text NOT NULL CHECK (char_length(cloudflare_record_id) BETWEEN 1 AND 128),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (domain_access_id, cloudflare_record_id)
);

CREATE INDEX cloudflare_domain_access_dns_records_owner_idx
    ON cloudflare_domain_access_dns_records (domain_access_id, status);

INSERT INTO cloudflare_domain_access_dns_records
    (domain_access_id, record_type, content, cloudflare_record_id)
SELECT h.id, 'CNAME', c.tunnel_id || '.cfargotunnel.com', h.dns_record_id
FROM cloudflare_public_hostnames h
JOIN cloudflare_connectors c ON c.id = h.connector_id
WHERE h.dns_record_id IS NOT NULL AND c.tunnel_id IS NOT NULL
ON CONFLICT DO NOTHING;
