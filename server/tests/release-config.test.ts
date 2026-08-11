import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('production release configuration', () => {
  it('uses release images in production, a local dev build, explicit recovery, and database readiness', async () => {
    const compose = parse(await readFile(join(root, 'compose.yaml'), 'utf8')) as { services: Record<string, Record<string, unknown>> };
    const development = parse(await readFile(join(root, 'compose.dev.yaml'), 'utf8')) as { services: Record<string, Record<string, unknown>> };
    expect(compose.services['control-plane']).not.toHaveProperty('build');
    expect(String(compose.services['control-plane']?.image)).toContain('GATEWAY_CONTROL_IMAGE');
    expect(compose.services['control-plane']?.healthcheck).toMatchObject({ test: expect.arrayContaining(['http://127.0.0.1:3000/ready']) });
    expect(compose.services['control-plane']).toHaveProperty('stop_grace_period');
    expect(compose.services['control-plane']?.environment).toMatchObject({
      GATEWAY_PROTECTED_PROJECTS: '${GATEWAY_PROTECTED_PROJECTS:-gateway-control}',
      GATEWAY_NOTIFICATION_TOPOLOGY_MAX_AGENTS: '${GATEWAY_NOTIFICATION_TOPOLOGY_MAX_AGENTS:-100}',
      GATEWAY_NOTIFICATION_TOPOLOGY_MAX_SERVICES: '${GATEWAY_NOTIFICATION_TOPOLOGY_MAX_SERVICES:-5000}',
      GATEWAY_NOTIFICATION_TOPOLOGY_MAX_SCOPES: '${GATEWAY_NOTIFICATION_TOPOLOGY_MAX_SCOPES:-5000}',
    });
    expect(compose.services['control-plane-restore']).toMatchObject({ profiles: ['recovery'], restart: 'no' });
    expect(development.services['control-plane']).toHaveProperty('build');
    expect(development.services.bootstrap?.volumes).toContain('./data/backups/system:/system-backups');
    expect(development.services['control-plane']?.volumes).toEqual(expect.arrayContaining([
      './data/backups/system:/opt/gateway-control/backups/system',
      './data/backups/nas:/mnt/gateway-control-backups',
    ]));

    const composeSource = await readFile(join(root, 'compose.yaml'), 'utf8');
    expect(composeSource).toContain('GATEWAY_SYSTEM_BACKUP_LOCAL_HOST_ROOT');
    expect(composeSource).toContain('GATEWAY_SYSTEM_BACKUP_NAS_HOST_ROOT');

    const entrypoint = await readFile(join(root, 'docker', 'control-plane-entrypoint.sh'), 'utf8');
    const serverBranch = entrypoint.slice(entrypoint.indexOf('server)'), entrypoint.indexOf('restore)'));
    expect(serverBranch).not.toContain('restore-system');
    expect(serverBranch).toContain('migrate.js');
  });

  it('pulls before downtime, then stops, verifies, backs up, and recreates only the control plane', async () => {
    const script = await readFile(join(root, 'docker', 'update.sh'), 'utf8');
    const pull = script.indexOf('docker compose pull control-plane');
    const stop = script.indexOf('docker compose stop control-plane');
    const dump = script.indexOf('pg_dump --format=custom');
    const verify = script.indexOf('pg_restore --list');
    const recreate = script.indexOf('docker compose up -d --no-deps control-plane');
    expect(script).toContain('release-preflight.sh');
    expect(script).toContain('restore.applying');
    expect(pull).toBeLessThan(stop);
    expect(stop).toBeLessThan(dump);
    expect(dump).toBeLessThan(verify);
    expect(verify).toBeLessThan(recreate);
    expect(script).toContain('docker compose start control-plane');
    expect(script).toMatch(/curl[^\n]+--max-time 2|wget[^\n]+-T 2/);
    expect(script).not.toMatch(/docker compose (?:down|up -d postgres)|volume rm|pg_restore .*--dbname/);
  });

  it('enforces immutable images in every production wrapper', async () => {
    const preflight = await readFile(join(root, 'docker', 'release-preflight.sh'), 'utf8');
    const deploy = await readFile(join(root, 'docker', 'deploy.sh'), 'utf8');
    const update = await readFile(join(root, 'docker', 'update.sh'), 'utf8');
    const recover = await readFile(join(root, 'docker', 'recover.sh'), 'utf8');
    expect(preflight).toContain('@sha256:[0-9a-f]{64}');
    for (const wrapper of [deploy, update, recover]) expect(wrapper).toContain('release-preflight.sh');
  });

  it('stops and verifies the writer before restore and starts it only after success', async () => {
    const recover = await readFile(join(root, 'docker', 'recover.sh'), 'utf8');
    const stop = recover.indexOf('docker compose stop control-plane');
    const stoppedCheck = recover.indexOf('if ! control_plane_is_stopped');
    const restore = recover.indexOf('docker compose --profile recovery run --rm control-plane-restore');
    const start = recover.indexOf('docker compose up -d --no-deps control-plane');
    expect(stop).toBeLessThan(stoppedCheck);
    expect(stoppedCheck).toBeLessThan(restore);
    expect(restore).toBeLessThan(start);
    expect(recover.slice(restore, start)).toContain('exit 1');
  });

  it('keeps base Compose dev-compatible and advertises wrapper-only recovery and production deployment', async () => {
    const composeSource = await readFile(join(root, 'compose.yaml'), 'utf8');
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    const ui = await readFile(join(root, 'src', 'BackupsPage.tsx'), 'utf8');
    expect(composeSource).not.toContain('${GATEWAY_CONTROL_IMAGE:?');
    expect(composeSource).not.toContain('${GATEWAY_AGENT_IMAGE:?');
    expect(readme).toContain('sh docker/deploy.sh');
    expect(readme).toContain('sh docker/update.sh');
    expect(readme).toContain('sh docker/recover.sh');
    expect(readme).not.toContain('docker compose --profile recovery run --rm control-plane-restore');
    expect(ui).toContain('sh docker/recover.sh');
  });

  it('ships project-local development host paths without changing absolute container paths', async () => {
    const environment = await readFile(join(root, '.env.example'), 'utf8');
    expect(environment).toContain('GATEWAY_CONTROL_IMAGE=gateway-control:local');
    expect(environment).toContain('GATEWAY_AGENT_IMAGE=gateway-control-agent:local');
    expect(environment).toContain('GATEWAY_SYSTEM_BACKUP_LOCAL_HOST_ROOT=./data/backups/system');
    expect(environment).toContain('GATEWAY_SYSTEM_BACKUP_NAS_HOST_ROOT=./data/backups/nas');
    expect(environment).toContain('GATEWAY_SYSTEM_BACKUP_LOCAL_ROOT=/opt/gateway-control/backups/system');
    expect(environment).toContain('GATEWAY_SYSTEM_BACKUP_NAS_ROOT=/mnt/gateway-control-backups');

    const update = await readFile(join(root, 'docker', 'update.sh'), 'utf8');
    expect(update).toContain('realpath -m "$project_directory/$1"');
  });

  it('fails restore mode without a state marker and bounds PostgreSQL readiness without promise races', async () => {
    const restore = await readFile(join(root, 'server', 'src', 'restore-system.ts'), 'utf8');
    const store = await readFile(join(root, 'server', 'src', 'postgres-store.ts'), 'utf8');
    const app = await readFile(join(root, 'server', 'src', 'app.ts'), 'utf8');
    expect(restore).toContain('No pending, applying, or applied system restore marker exists.');
    expect(store).toContain('query_timeout: 2_500');
    expect(store).toContain('statement_timeout: 2_000');
    expect(app.slice(app.indexOf("app.get('/ready'"), app.indexOf("app.get('/api/setup/status'"))).not.toContain('Promise.race');
  });

  it('bounds notification topology work in SQL and reports truncation', async () => {
    const store = await readFile(join(root, 'server', 'src', 'postgres-store.ts'), 'utf8');
    const topology = store.slice(store.indexOf('public async getNotificationTopology'), store.indexOf('public async setAgentNotificationPreference'));
    expect(topology.match(/LIMIT \$2/g)).toHaveLength(3);
    expect(topology).toContain('maxAgents + 1');
    expect(topology).toContain('maxServices + 1');
    expect(topology).toContain('maxScopes + 1');
    expect(topology).toContain('truncated:');
    expect(topology).not.toContain('.find((scope)');
    expect(topology).not.toContain('.filter((candidate)');
  });
});
