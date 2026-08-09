ALTER TABLE cloudflare_connectors
    ADD COLUMN agent_id uuid;

ALTER TABLE cloudflare_connectors
    ADD CONSTRAINT cloudflare_connectors_agent_id_foreign
    FOREIGN KEY (agent_id) REFERENCES agents(id);

-- Existing development rows remain readable, while every new or updated assignment must be non-null.
ALTER TABLE cloudflare_connectors
    ADD CONSTRAINT cloudflare_connectors_agent_id_required
    CHECK (agent_id IS NOT NULL) NOT VALID;

CREATE INDEX cloudflare_connectors_agent_id_idx
    ON cloudflare_connectors (agent_id);
