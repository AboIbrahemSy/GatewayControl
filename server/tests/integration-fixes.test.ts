import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sanitizeOperationalEventTypes } from '../src/types.js';

describe('integration repair migration', () => {
  it('normalizes malformed notification selections without editing migration 021', async () => {
    const sql = await readFile(new URL('../migrations/022_integration_fixes.sql', import.meta.url), 'utf8');

    expect(sql).toContain("jsonb_typeof(item.value) = 'string'");
    expect(sql).toContain('min(position)');
    expect(sql).toContain('is_fresh_default_row');
    expect(sql).toContain('notification_settings_selected_events_strings');
    expect(sql).toContain('deployment.succeeded');
  });

  it('defensively returns only supported unique strings from legacy values', () => {
    expect(sanitizeOperationalEventTypes([
      'agent.offline',
      { 'deployment.succeeded': true },
      'agent.offline',
      42,
      'unknown.event',
      'deployment.failed',
    ])).toEqual(['agent.offline', 'deployment.failed']);
    expect(sanitizeOperationalEventTypes({ 'deployment.succeeded': true })).toEqual([]);
  });

  it('passes authoritative runtime scope columns in normal and stale paths and applies mute policy twice', async () => {
    const source = await readFile(new URL('../src/postgres-store.ts', import.meta.url), 'utf8');
    const normalStart = source.indexOf("current.rows[0].type === 'compose.runtime.action'");
    const staleStart = source.indexOf("commandRow.type === 'compose.runtime.action'");
    const normal = source.slice(normalStart, source.indexOf("current.rows[0].type === 'compose.runtime.logs'", normalStart));
    const stale = source.slice(staleStart, source.indexOf("commandRow.type === 'compose.runtime.logs'", staleStart));

    for (const path of [normal, stale]) {
      expect(path).toContain('projectName:');
      expect(path).toContain('serviceName:');
    }
    expect(source.match(/NOT EXISTS \(SELECT 1 FROM notification_scopes WHERE agent_id/g)).toHaveLength(2);
    expect(source.match(/service_name = \$[45] AND NOT enabled/g)).toHaveLength(2);
  });
});
