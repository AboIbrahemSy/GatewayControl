ALTER TABLE cloudflare_connectors
    ADD COLUMN desired_revision bigint NOT NULL DEFAULT 1,
    ADD COLUMN token_account_identifier text,
    ADD COLUMN token_tunnel_id uuid,
    ADD COLUMN identity_status text NOT NULL DEFAULT 'pending',
    ADD COLUMN identity_verified_at timestamptz,
    ADD COLUMN identity_error text,
    ADD CONSTRAINT cloudflare_connectors_desired_revision_positive CHECK (desired_revision >= 1),
    ADD CONSTRAINT cloudflare_connectors_token_account_identifier_format
        CHECK (token_account_identifier IS NULL OR token_account_identifier ~ '^[a-f0-9]{32}$'),
    ADD CONSTRAINT cloudflare_connectors_identity_status_check
        CHECK (identity_status IN ('parsed', 'pending', 'verified', 'unmatched', 'mismatch', 'invalid', 'failed')),
    ADD CONSTRAINT cloudflare_connectors_identity_error_length
        CHECK (identity_error IS NULL OR char_length(identity_error) <= 100),
    ADD CONSTRAINT cloudflare_connectors_token_identity_pair
        CHECK ((token_account_identifier IS NULL) = (token_tunnel_id IS NULL)),
    ADD CONSTRAINT cloudflare_connectors_identity_coherence CHECK (
        (identity_status = 'verified' AND token_account_identifier IS NOT NULL AND token_tunnel_id IS NOT NULL
            AND cloudflare_account_id IS NOT NULL AND lower(tunnel_id) = lower(token_tunnel_id::text)
            AND identity_verified_at IS NOT NULL AND identity_error IS NULL)
        OR
        (identity_status <> 'verified' AND identity_verified_at IS NULL
            AND (identity_status NOT IN ('parsed', 'unmatched', 'mismatch')
                OR (token_account_identifier IS NOT NULL AND token_tunnel_id IS NOT NULL))
            AND (identity_status NOT IN ('unmatched', 'mismatch', 'invalid', 'failed') OR identity_error IS NOT NULL)
            AND (identity_status <> 'parsed' OR identity_error IS NULL))
    );

ALTER TABLE cloudflare_connectors
    DROP CONSTRAINT cloudflare_connectors_deployment_status_check,
    ADD CONSTRAINT cloudflare_connectors_deployment_status_check
        CHECK (deployment_status IN ('pending', 'deploying', 'active', 'failed', 'stopping', 'stopped'));

CREATE INDEX cloudflare_connectors_identity_reconcile_idx
    ON cloudflare_connectors (identity_status, updated_at)
    WHERE identity_status IN ('pending', 'parsed', 'failed');

CREATE UNIQUE INDEX cloudflare_connectors_verified_token_identity_unique
    ON cloudflare_connectors (token_account_identifier, token_tunnel_id)
    WHERE identity_status = 'verified';
