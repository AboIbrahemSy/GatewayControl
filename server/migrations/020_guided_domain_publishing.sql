CREATE TABLE guided_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('cloudflare_bootstrap', 'domain_publish')),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
    request_encrypted text CHECK (request_encrypted IS NULL OR char_length(request_encrypted) <= 16384),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'waiting', 'succeeded', 'failed')),
    stage text NOT NULL DEFAULT 'created' CHECK (char_length(stage) BETWEEN 1 AND 64),
    cloudflare_account_id uuid REFERENCES cloudflare_accounts(id) ON DELETE RESTRICT,
    connector_id uuid REFERENCES cloudflare_connectors(id) ON DELETE RESTRICT,
    route_id uuid REFERENCES managed_routes(id) ON DELETE RESTRICT,
    domain_access_id uuid REFERENCES cloudflare_public_hostnames(id) ON DELETE RESTRICT,
    remote_tunnel_id text CHECK (remote_tunnel_id IS NULL OR char_length(remote_tunnel_id) = 36),
    remote_tunnel_name text CHECK (remote_tunnel_name IS NULL OR char_length(remote_tunnel_name) BETWEEN 1 AND 100),
    result jsonb,
    error text CHECK (error IS NULL OR char_length(error) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (requested_by_user_id, kind, idempotency_key)
);

CREATE INDEX guided_operations_resume_idx
    ON guided_operations (kind, status, updated_at)
    WHERE status IN ('pending', 'waiting', 'failed');

ALTER TABLE cloudflare_public_hostnames
    ADD COLUMN tls_status text NOT NULL DEFAULT 'not_observed'
        CHECK (tls_status IN ('not_observed', 'valid', 'expiring', 'expired', 'error')),
    ADD COLUMN tls_issuer text CHECK (tls_issuer IS NULL OR char_length(tls_issuer) <= 255),
    ADD COLUMN tls_valid_to timestamptz,
    ADD COLUMN tls_observed_at timestamptz,
    ADD COLUMN tls_error text CHECK (tls_error IS NULL OR char_length(tls_error) <= 500);

CREATE INDEX cloudflare_public_hostnames_tls_observation_idx
    ON cloudflare_public_hostnames (tls_observed_at)
    WHERE enabled AND status = 'active' AND access_method = 'public_ip' AND NOT proxied;
