import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('notification scope migration', () => {
  it('uses restrictive normalized identities without changing historical global selections', async () => {
    const sql = await readFile(new URL('../migrations/019_notification_scopes.sql', import.meta.url), 'utf8');

    expect(sql).toContain('CREATE TABLE notification_scopes');
    expect(sql).toContain('REFERENCES agents(id) ON DELETE RESTRICT');
    expect(sql).toContain('REFERENCES users(id) ON DELETE RESTRICT');
    expect(sql).toContain('notification_scopes_agent_unique');
    expect(sql).toContain('notification_scopes_service_unique');
    expect(sql).toContain("project_name ~ '^[a-z0-9][a-z0-9_-]{0,62}$'");
    expect(sql).toContain("service_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'");
    expect(sql).not.toMatch(/DELETE FROM|ON DELETE CASCADE|UPDATE notification_settings/i);
  });
});
