CREATE TABLE cloudflare_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    account_identifier text NOT NULL CHECK (char_length(account_identifier) = 32),
    api_token_encrypted text NOT NULL CHECK (char_length(api_token_encrypted) <= 8192),
    enabled boolean NOT NULL DEFAULT true,
    last_synced_at timestamptz,
    last_error_at timestamptz,
    last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cloudflare_accounts_name_unique ON cloudflare_accounts (lower(name));
CREATE UNIQUE INDEX cloudflare_accounts_identifier_unique ON cloudflare_accounts (lower(account_identifier));

ALTER TABLE cloudflare_connectors
    ADD COLUMN cloudflare_account_id uuid,
    ADD COLUMN tunnel_id text,
    ADD CONSTRAINT cloudflare_connectors_account_foreign
        FOREIGN KEY (cloudflare_account_id) REFERENCES cloudflare_accounts(id) ON DELETE RESTRICT,
    ADD CONSTRAINT cloudflare_connectors_tunnel_id_length
        CHECK (tunnel_id IS NULL OR char_length(tunnel_id) = 36),
    ADD CONSTRAINT cloudflare_connectors_tunnel_assignment
        CHECK (tunnel_id IS NULL OR cloudflare_account_id IS NOT NULL);

CREATE INDEX cloudflare_connectors_account_id_idx ON cloudflare_connectors (cloudflare_account_id);
CREATE UNIQUE INDEX cloudflare_connectors_account_tunnel_unique
    ON cloudflare_connectors (cloudflare_account_id, lower(tunnel_id))
    WHERE tunnel_id IS NOT NULL;

CREATE TABLE cloudflare_zones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cloudflare_account_id uuid NOT NULL REFERENCES cloudflare_accounts(id) ON DELETE RESTRICT,
    zone_identifier text NOT NULL CHECK (char_length(zone_identifier) = 32),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 253),
    status text NOT NULL CHECK (char_length(status) BETWEEN 1 AND 64),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cloudflare_account_id, name)
);

CREATE UNIQUE INDEX cloudflare_zones_identifier_unique ON cloudflare_zones (lower(zone_identifier));
CREATE INDEX cloudflare_zones_account_id_idx ON cloudflare_zones (cloudflare_account_id, name);

CREATE TABLE cloudflare_public_hostnames (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cloudflare_zone_id uuid NOT NULL REFERENCES cloudflare_zones(id) ON DELETE RESTRICT,
    cloudflare_account_id uuid NOT NULL REFERENCES cloudflare_accounts(id) ON DELETE RESTRICT,
    connector_id uuid NOT NULL REFERENCES cloudflare_connectors(id) ON DELETE RESTRICT,
    route_id uuid NOT NULL REFERENCES managed_routes(id) ON DELETE RESTRICT,
    hostname text NOT NULL CHECK (char_length(hostname) BETWEEN 1 AND 253),
    dns_record_id text CHECK (dns_record_id IS NULL OR char_length(dns_record_id) BETWEEN 1 AND 128),
    enabled boolean NOT NULL DEFAULT true,
    proxied boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
    last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (route_id)
);

CREATE UNIQUE INDEX cloudflare_public_hostnames_hostname_unique ON cloudflare_public_hostnames (lower(hostname));
CREATE INDEX cloudflare_public_hostnames_zone_id_idx ON cloudflare_public_hostnames (cloudflare_zone_id);
CREATE INDEX cloudflare_public_hostnames_account_id_idx ON cloudflare_public_hostnames (cloudflare_account_id);
CREATE INDEX cloudflare_public_hostnames_connector_id_idx ON cloudflare_public_hostnames (connector_id);
CREATE INDEX cloudflare_public_hostnames_status_idx ON cloudflare_public_hostnames (status, updated_at);
