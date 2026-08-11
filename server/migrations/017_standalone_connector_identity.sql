ALTER TABLE cloudflare_connectors
    DROP CONSTRAINT cloudflare_connectors_identity_coherence,
    ADD CONSTRAINT cloudflare_connectors_identity_coherence CHECK (
        (identity_status = 'verified' AND token_account_identifier IS NOT NULL AND token_tunnel_id IS NOT NULL
            AND cloudflare_account_id IS NOT NULL AND lower(tunnel_id) = lower(token_tunnel_id::text)
            AND identity_verified_at IS NOT NULL AND identity_error IS NULL)
        OR
        (identity_status <> 'verified' AND identity_verified_at IS NULL
            AND (identity_status NOT IN ('parsed', 'unmatched', 'mismatch')
                OR (token_account_identifier IS NOT NULL AND token_tunnel_id IS NOT NULL))
            AND (identity_status NOT IN ('unmatched', 'mismatch', 'invalid', 'failed') OR identity_error IS NOT NULL))
    );

DROP INDEX cloudflare_connectors_identity_reconcile_idx;

CREATE INDEX cloudflare_connectors_identity_reconcile_idx
    ON cloudflare_connectors (identity_status, updated_at)
    WHERE identity_status IN ('pending', 'parsed', 'failed', 'unmatched');
