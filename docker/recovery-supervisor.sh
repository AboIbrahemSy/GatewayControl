#!/bin/sh
set -eu

project_root=${GATEWAY_RECOVERY_PROJECT_ROOT:-/opt/gateway-control}
backup_root=${GATEWAY_SYSTEM_BACKUP_LOCAL_HOST_ROOT:-/opt/gateway-control/backups/system}
secret_file=${GATEWAY_RECOVERY_REQUEST_SECRET_FILE:-/etc/gateway-control/recovery-request.secret}
request_root="$backup_root/.recovery-requests"

fail() {
    printf '%s\n' "ERROR: $*" >&2
    exit 1
}

[ -d "$project_root" ] && [ ! -L "$project_root" ] || fail "The fixed GatewayControl project root is invalid."
[ -f "$project_root/docker/recover.sh" ] && [ ! -L "$project_root/docker/recover.sh" ] || fail "The fixed recovery wrapper is invalid."
[ -d "$backup_root" ] && [ ! -L "$backup_root" ] || fail "The fixed backup root is invalid."
[ -f "$secret_file" ] && [ ! -L "$secret_file" ] || fail "The recovery request secret is invalid."
secret=$(cat "$secret_file")
[ "${#secret}" -ge 32 ] || fail "The recovery request secret must contain at least 32 characters."
umask 077
mkdir -p "$request_root"
[ -d "$request_root" ] && [ ! -L "$request_root" ] || fail "The recovery request spool is invalid."
command -v flock >/dev/null 2>&1 || fail "flock is required for the exclusive recovery supervisor lock."
lock_path="$request_root/supervisor.lock"
if [ ! -e "$lock_path" ] && [ ! -L "$lock_path" ]; then
    (umask 077 && set -C && : > "$lock_path") 2>/dev/null || true
fi
[ -f "$lock_path" ] && [ ! -L "$lock_path" ] || fail "The recovery supervisor lock file is invalid."
exec 9>"$lock_path"
flock -n 9 || fail "Another recovery supervisor already owns the host lock."

while :; do
    pending="$request_root/request.pending"
    claimed="$request_root/request.claimed"
    if [ ! -e "$claimed" ] && [ ! -L "$claimed" ] && { [ -e "$pending" ] || [ -L "$pending" ]; }; then
        [ -f "$pending" ] && [ ! -L "$pending" ] || fail "The pending recovery request is not a regular file."
        [ "$(wc -c < "$pending")" -le 512 ] || fail "The pending recovery request is oversized."
        mv "$pending" "$claimed" || { sleep 2; continue; }
    fi
    if [ -e "$claimed" ] || [ -L "$claimed" ]; then
        [ -f "$claimed" ] && [ ! -L "$claimed" ] || fail "The claimed recovery request is not a regular file."
        [ "$(wc -c < "$claimed")" -le 512 ] || fail "The claimed recovery request is oversized."
        request=$(cat "$claimed")
        restore_id=$(printf '%s' "$request" | sed -n 's/^{"version":1,"operation":"apply-system-restore","restoreId":"\([0-9a-fA-F-]*\)","signature":"[0-9a-f]*"}$/\1/p')
        signature=$(printf '%s' "$request" | sed -n 's/^.*,"signature":"\([0-9a-f]*\)"}$/\1/p')
        case "$restore_id" in
            ????????-????-????-????-????????????) ;;
            *) fail "The claimed recovery request has an invalid fixed schema." ;;
        esac
        printf '%s\n' "$restore_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' || fail "The claimed recovery request restore ID is invalid."
        unsigned=$(printf '{"version":1,"operation":"apply-system-restore","restoreId":"%s"}' "$restore_id")
        expected=$(printf '%s' "$unsigned" | openssl dgst -sha256 -hmac "$secret" -r | awk '{print $1}')
        [ "${#signature}" -eq 64 ] && [ "$signature" = "$expected" ] || fail "The claimed recovery request signature is invalid."
        started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        status_tmp="$request_root/status.partial"
        rm -f "$status_tmp"
        printf '{"version":1,"restoreId":"%s","status":"running","startedAt":"%s","finishedAt":null}\n' "$restore_id" "$started" > "$status_tmp"
        mv "$status_tmp" "$request_root/status.latest"
        if (cd "$project_root" && sh docker/recover.sh); then
            outcome=succeeded
        else
            outcome=failed
        fi
        finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        printf '{"version":1,"restoreId":"%s","status":"%s","startedAt":"%s","finishedAt":"%s"}\n' "$restore_id" "$outcome" "$started" "$finished" > "$status_tmp"
        mv "$status_tmp" "$request_root/status.latest"
        mv "$claimed" "$request_root/request.$restore_id.$outcome"
        find "$request_root" -maxdepth 1 -type f \( -name 'request.*.succeeded' -o -name 'request.*.failed' \) | sort -r | awk 'NR > 20' | xargs -r rm --
    fi
    sleep 2
done
