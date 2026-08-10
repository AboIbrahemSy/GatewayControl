# GatewayControl

GatewayControl is a self-hosted control plane for operating Docker Compose workloads, gateway nodes, Traefik routes, Cloudflare tunnels, monitoring, logs, notifications, and backups from one interface.

It is designed for a single infrastructure owner and supports the `Owner`, `Operator`, and `Viewer` roles. The web interface supports English LTR and Arabic RTL layouts.

## Features

- Outbound-only Go agents with one-time enrollment and no general remote shell.
- Managed Docker Compose stacks with revisioned definitions and restricted execution.
- Traefik tunnel and public TLS routes with dynamic configuration.
- Cloudflare accounts, zone discovery, tunnel connectors, DNS records, and public hostnames.
- Node telemetry and Compose service health monitoring.
- Bounded, redacted service-log retrieval.
- Durable Telegram operational notifications with retries.
- Offline Local and pre-mounted NAS backups for Compose-owned named volumes.
- Owner-only restore with manifest and SHA-256 verification.
- PostgreSQL persistence and encrypted server-side secrets.
- Responsive light and dark interfaces for phones, tablets, laptops, and desktops.

## Architecture

The default Compose deployment contains:

- `control-plane`: the React application and Fastify API.
- `postgres`: application state, command queue, telemetry, and operation history.
- `traefik`: the edge proxy and dynamic route consumer.
- `bootstrap`: one-time generation and permission setup for local secret volumes.

Agents run on trusted Linux Docker hosts. They connect to the control plane over HTTP or HTTPS, poll a restricted command queue, and use the local Docker socket to manage authorized resources. The Agent assigned to Traefik routes must run on the same Docker host as that Traefik instance and use the same dynamic-configuration named volume.

> [!WARNING]
> Docker socket access is equivalent to host-level administrative authority. Run agents only on trusted machines, protect the control plane, and never expose its API directly to an untrusted network.

## Requirements

Control plane:

- Docker Engine with Docker Compose v2.
- Ports `80` and `443` for Traefik.
- One configurable port for the control-plane setup endpoint, `8080` by default.

Agent hosts:

- A supported Linux Docker host such as Ubuntu, Debian, RHEL, or Rocky Linux.
- Docker Engine and permission to access `/var/run/docker.sock`.
- Outbound network access to the control-plane URL and required image registries.
- A pre-mounted writable NAS directory when NAS backups are enabled.

The generated enrollment command is intended for a POSIX shell on Linux. It is not a Windows PowerShell command.

## Quick Start

Clone the repository and enter its directory:

```bash
git clone <repository-url> gateway-control
cd gateway-control
```

Create the local configuration file:

```bash
cp .env.example .env
```

Build the agent image and start the control plane:

```bash
docker build -t gateway-control-agent:local ./agent
docker compose up -d --build
```

Check container health:

```bash
docker compose ps
curl http://localhost:8080/health
```

The health endpoint should return:

```json
{"status":"ok"}
```

Open `http://localhost:8080` and complete the first-run wizard to create the initial Owner account.

### Local HTTP and Production HTTPS

The example environment sets `SESSION_COOKIE_SECURE=false` so first-run access works over local HTTP. This setting must not be used for an internet-facing deployment.

For production:

```env
SESSION_COOKIE_SECURE=true
TRUST_PROXY=true
```

Terminate HTTPS at a trusted reverse proxy, forward requests to the control-plane HTTP port, and restrict direct access to that port. Keep `TRUST_PROXY=false` unless the application is actually behind a trusted proxy.

## Configuration

The root `.env.example` contains safe local defaults:

| Variable | Purpose | Default example |
| --- | --- | --- |
| `GATEWAY_CONTROL_IMAGE` | Control-plane image | `gateway-control:local` |
| `GATEWAY_AGENT_IMAGE` | Image placed in generated Agent commands | `gateway-control-agent:local` |
| `CONTROL_HTTP_PORT` | Host port for the control plane | `8080` |
| `POSTGRES_IMAGE` | PostgreSQL image | `postgres:17-alpine` |
| `TRAEFIK_IMAGE` | Digest-pinned Traefik image | See `.env.example` |
| `SESSION_TTL_HOURS` | Login-session lifetime | `24` |
| `SESSION_COOKIE_SECURE` | Restrict session cookies to HTTPS | `false` for local setup |
| `TRUST_PROXY` | Trust forwarded proxy information | `false` |
| `GATEWAY_TRAEFIK_DYNAMIC_VOLUME` | Shared Agent and Traefik route volume | `gateway-traefik-dynamic` |
| `GATEWAY_SYSTEM_BACKUP_LOCAL_ROOT` | Control-plane system backup and restore-staging root | `/opt/gateway-control/backups/system` |
| `GATEWAY_SYSTEM_BACKUP_NAS_ROOT` | Canonical pre-mounted NAS path passed to the control plane and generated Agents | `/mnt/gateway-control-backups` |
| `GATEWAY_SYSTEM_BACKUP_NAS_MARKER` | Required regular marker file name passed to the control plane and generated Agents | `.gateway-control-nas` |
| `GATEWAY_SYSTEM_RESTORE_STAGE_ROOT` | Private startup restore staging directory | `/opt/gateway-control/backups/system/.restore-stage` |

Do not commit `.env`. Database credentials and the control-plane encryption key are generated into a Docker volume during bootstrap.

## Enroll an Agent

Open **Agents** in the web interface and provide:

1. A unique Agent name.
2. A control-plane URL reachable from the target host.
3. An Agent image available on that host.

Use an HTTPS URL for remote nodes, for example:

```text
https://control.example.com
```

Local trusted-network testing may use a reachable LAN address:

```text
http://192.168.1.10:8080
```

When the browser opens GatewayControl through `localhost` or `127.0.0.1`, the enrollment form uses `host.docker.internal` instead. The generated Agent container maps that name to the Docker host through `host-gateway`, because `localhost` inside the Agent container refers to the Agent itself rather than the control plane.

Copy the generated one-time command and run it on the target Linux host with Docker permissions. The command contains a short-lived enrollment secret and must be treated as sensitive until it has been used or expires.

For remote hosts, publish the Agent image to a registry and configure an immutable tag or digest:

```env
GATEWAY_AGENT_IMAGE=registry.example.com/gateway-control-agent:1.0.0
```

Build and publish an image using your registry workflow before generating remote enrollment commands. Avoid mutable `latest` tags.

After enrollment, confirm that the Agent reports both a heartbeat and telemetry in **Agents** and **Monitoring**.

For the Traefik instance included in `compose.yaml`, enroll an Agent on the control-plane Docker host and keep `GATEWAY_TRAEFIK_DYNAMIC_VOLUME` identical in the control plane and generated Agent configuration. A remote Agent can manage workloads on its own host, but it cannot update the bundled Traefik volume on another Docker host.

### Remove an Agent

Only an Owner can remove an Agent. GatewayControl blocks removal while the Agent is referenced by a managed stack, route, Cloudflare connector, backup, restore, or active command. Reassign those resources and allow active commands to finish first.

- A never-enrolled, unreferenced Agent is permanently deleted.
- An enrolled Agent is archived, hidden from the active fleet, disabled, and stripped of its enrollment and runtime credentials.
- Historical telemetry and operational events are retained.

After removal, GatewayControl displays a host cleanup command. Run it on the former Agent host to remove only that Agent container and its private state volume. It does not remove managed stack files, backup archives, NAS data, or the shared Traefik configuration volume.

### Local Agent Image Not Found

`docker compose up --build` builds the control-plane image but does not build the separately deployed Agent image. If enrollment reports `No such image: gateway-control-agent:local`, build it on the Agent host before creating a new enrollment:

```bash
docker build --pull -t gateway-control-agent:local ./agent
docker image inspect gateway-control-agent:local --format '{{.Id}}'
```

Enrollment secrets are short-lived and must not be shared in logs, screenshots, issues, or support conversations. Create a new enrollment if its command has been exposed.

## Managed Stacks and Routes

Use **Compose Stacks** to create a stack assigned to an enabled Agent. GatewayControl validates Compose YAML and rejects privileged services, Docker socket mounts, external includes, and unsupported file extensions.

Use **Routes & Domains** to create:

- `Tunnel` routes on Traefik's HTTP entrypoint for Cloudflare Tunnel traffic.
- `Public IP` routes on the HTTPS entrypoint with the configured ACME resolver.

Route synchronization is asynchronous. `Pending`, `Active`, and `Failed` describe the latest deployment operation; runtime service health is shown separately under **Monitoring**.

## Monitoring and Logs

Agents report bounded telemetry at a configurable interval. The control plane stores recent snapshots for node and service monitoring.

The log viewer accepts only:

- A managed stack.
- A validated Compose service name.
- A bounded line count.
- An optional time within the previous 24 hours.

Log output is size-limited, terminal control sequences are removed, and known credential patterns are redacted. Application logs can still contain sensitive business data, so log access is restricted to Operators and Owners.

## Local Backups

Local backups are stored under this host path by default:

```text
/opt/gateway-control/backups/local
```

Backups are offline-consistent:

1. GatewayControl records the services that are currently running.
2. The Agent stops the stack.
3. Compose-owned named volumes are archived by the restricted backup helper.
4. A manifest and SHA-256 checksums are written atomically.
5. Previously running services are started again.

External or ambiguously owned volumes are rejected. Backup archives preserve regular file content, numeric ownership, permissions, and modification times. Filesystem-specific ACLs and extended attributes are not preserved.

Backup and restore commands retain their Agent lease and may be reclaimed after an interrupted attempt. If an operation remains incomplete for 24 hours, the control plane marks its command and operation as failed, emits a `backup.failed` event, and releases the stack for a new operation.

## NAS Backups

GatewayControl does not mount NFS or SMB shares and does not store NAS credentials. Mount the share using the host operating system before enrolling the Agent.

Example preparation:

```bash
sudo mkdir -p /mnt/gateway-control-backups
sudo mount <nas-source> /mnt/gateway-control-backups
sudo touch /mnt/gateway-control-backups/.gateway-control-nas
sudo chown -R 10001:10001 /mnt/gateway-control-backups
```

Configure a persistent mount with the host's normal system configuration, such as `/etc/fstab`. Adapt ownership and access controls to the NAS implementation while ensuring Agent UID `10001` can write.

The marker file is mandatory. Configure `GATEWAY_SYSTEM_BACKUP_NAS_ROOT` and `GATEWAY_SYSTEM_BACKUP_NAS_MARKER` before generating enrollment commands; GatewayControl passes that same root and marker contract to Agents and mounts the root at the identical container path. If the NAS path or marker is unavailable, the operation fails and never falls back silently to local storage.

Owner system recovery is a same-instance database rollback feature, not master-key disaster recovery. Its encrypted archive includes `master.key` only as an authenticated instance identity check. Restoring requires the original configured master key, and the archived key is never installed or restored.

## Restore

Only an Owner can request a restore. A restore:

- Uses only a successful backup associated with the same managed stack.
- Revalidates the manifest, stack revision, archive ownership, and every checksum.
- Rejects traversal, links, device files, sockets, and other unsafe archive entries.
- Stops the stack before replacing volume data.
- Writes a durable restore journal before destructive work.

If a restore is interrupted after destructive work begins, the journal is retained and future restores fail closed. An administrator must inspect the host and reconcile the journal rather than allowing an unsafe automatic replay.

## Telegram Notifications

Open **Telegram Notifications** and configure a Bot Token and group or chat ID. Credentials are encrypted and are never returned to the browser.

Available event types include:

- Agent offline.
- Service unhealthy.
- Deployment failure.
- Certificate expiration warning.
- Backup or restore failure.
- Backup success.

Deliveries use a durable outbox with bounded retries. Use **Send Test** before relying on operational alerts.

## Cloudflare Setup

GatewayControl uses two separate Cloudflare credentials:

- A Cloudflare API Token for account, zone, DNS, and tunnel-configuration management.
- A Tunnel Connector Token used by `cloudflared` on an Agent.

Create an API Token with only the required resources and permissions:

- Account: Cloudflare Tunnel, Edit.
- Zone: Zone, Read.
- Zone: DNS, Edit.

Then:

1. Open **Cloudflare Management**.
2. Add the Cloudflare Account Identifier and API Token.
3. Run **Test** and then **Sync** to discover zones.
4. Open **Cloudflare Connectors**.
5. Create a connector with its Connector Token, Account, Tunnel UUID, and Agent.
6. Create an enabled `Tunnel` route with a hostname inside a synchronized zone.
7. Open **Public Hostnames** and bind the Zone, Connector, and Route.

GatewayControl preserves unrelated tunnel ingress rules, maintains a final catch-all rule, and creates a proxied CNAME pointing to `<tunnel-uuid>.cfargotunnel.com`. If DNS creation fails, it attempts to roll the tunnel configuration back. It never takes ownership of an unknown conflicting DNS record.

## Operations

Show status:

```bash
docker compose ps
```

Follow logs:

```bash
docker compose logs -f control-plane
docker compose logs -f postgres
docker compose logs -f traefik
```

Restart services:

```bash
docker compose restart
```

Rebuild and apply source updates:

```bash
docker build -t gateway-control-agent:local ./agent
docker compose up -d --build
```

Stop the control plane while retaining data:

```bash
docker compose down
```

> [!CAUTION]
> `docker compose down -v` permanently removes the PostgreSQL database, generated secrets, Traefik state, and other named volumes. Do not use it as a normal stop command.

## Development Verification

Frontend:

```bash
npm ci
npm run typecheck
npm run build
```

Server:

```bash
cd server
npm ci
npm run typecheck
npm test
```

Agent:

```bash
cd agent
go fmt ./...
go test ./...
```

## Security and Privacy

- The application does not include organization-specific behavior or data.
- Repository examples use reserved domains, documentation addresses, private-network examples, and synthetic credentials.
- Secrets are write-only in the browser and encrypted at rest by the control plane.
- Sensitive Agent commands are decorated only when polled by their assigned Agent.
- There is no general remote shell command.
- SVG uploads and arbitrary host paths are not part of the platform's operational APIs.
- No product telemetry is sent to the project maintainers. Data leaves the installation only when an administrator configures an external integration such as Cloudflare, Telegram, or an image registry.

Before publishing a fork, inspect local `.env` files, generated runtime directories, logs, database dumps, backup archives, screenshots, and shell history. These files are excluded or external to the source tree by default, but they can contain installation-specific information.

## License

GatewayControl is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).
