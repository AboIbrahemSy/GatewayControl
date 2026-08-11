#!/bin/sh
set -eu

project_root=/opt/gateway-control
unit_source="$project_root/docker/systemd/gateway-control-recovery-supervisor.service"
unit_target=/etc/systemd/system/gateway-control-recovery-supervisor.service
secret_file=/etc/gateway-control/recovery-request.secret

[ "$(id -u)" -eq 0 ] || { printf '%s\n' 'ERROR: Run this installer as root.' >&2; exit 1; }
[ -f "$unit_source" ] && [ ! -L "$unit_source" ] || { printf '%s\n' 'ERROR: Install GatewayControl at /opt/gateway-control first.' >&2; exit 1; }
install -d -m 0700 /etc/gateway-control
if [ ! -e "$secret_file" ]; then
    umask 077
    openssl rand -hex 32 > "$secret_file"
fi
[ -f "$secret_file" ] && [ ! -L "$secret_file" ] || { printf '%s\n' 'ERROR: Recovery request secret must be a regular file.' >&2; exit 1; }
chmod 0600 "$secret_file"
install -m 0644 "$unit_source" "$unit_target"
systemctl daemon-reload
systemctl enable --now gateway-control-recovery-supervisor.service
printf '%s\n' 'Recovery supervisor installed. Configure the control plane with the same host secret file and explicitly enable it.'
