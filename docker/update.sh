#!/bin/sh
set -eu

umask 077
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_directory/release-preflight.sh"

fail() {
    printf '%s\n' "ERROR: $*" >&2
    exit 1
}

command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."
command -v realpath >/dev/null 2>&1 || fail "realpath is required for fail-closed restore-path validation."

project_directory=$(CDPATH= cd -- "$script_directory/.." && pwd)
resolve_host_path() {
    case "$1" in
        /*) realpath -m "$1" ;;
        *) realpath -m "$project_directory/$1" ;;
    esac
}

local_root="$(resolve_host_path "${GATEWAY_SYSTEM_BACKUP_LOCAL_HOST_ROOT:-/opt/gateway-control/backups/system}")"
stage_root="$(resolve_host_path "${GATEWAY_SYSTEM_RESTORE_STAGE_HOST_ROOT:-$local_root/.restore-stage}")"
[ -d "$local_root" ] && [ ! -L "$local_root" ] || fail "GATEWAY_SYSTEM_BACKUP_LOCAL_HOST_ROOT must be an existing real directory."
case "$stage_root" in
    "$local_root"/*) ;;
    *) fail "GATEWAY_SYSTEM_RESTORE_STAGE_HOST_ROOT must resolve strictly inside GATEWAY_SYSTEM_BACKUP_LOCAL_HOST_ROOT." ;;
esac
if [ -e "$stage_root" ] || [ -L "$stage_root" ]; then
    [ -d "$stage_root" ] && [ ! -L "$stage_root" ] || fail "GATEWAY_SYSTEM_RESTORE_STAGE_HOST_ROOT must be a real directory."
    for marker in restore.pending restore.applying restore.applied; do
        marker_path="$stage_root/$marker"
        if [ -e "$marker_path" ] || [ -L "$marker_path" ]; then
            [ -f "$marker_path" ] && [ ! -L "$marker_path" ] || fail "The staged restore marker $marker is not a regular file."
            fail "A staged system restore is pending, applying, or awaiting cleanup. Use sh docker/recover.sh before updating."
        fi
    done
fi

backup_root="$(resolve_host_path "${UPDATE_BACKUP_ROOT:-/opt/gateway-control/backups/pre-update}")"
mkdir -p "$backup_root"
[ -d "$backup_root" ] && [ ! -L "$backup_root" ] || fail "UPDATE_BACKUP_ROOT must be a real directory."
chmod 0700 "$backup_root"

printf '%s\n' "Pulling the immutable control-plane release image while the current writer remains available."
docker compose pull control-plane

restart_old=1
temporary_dump=''
temporary_manifest=''
cleanup() {
    [ -z "$temporary_dump" ] || rm -f "$temporary_dump"
    [ -z "$temporary_manifest" ] || rm -f "$temporary_manifest"
    if [ "$restart_old" -eq 1 ]; then
        printf '%s\n' "Update failed before recreation; restarting the existing stopped control-plane container." >&2
        docker compose start control-plane >/dev/null 2>&1 || printf '%s\n' "ERROR: The existing control plane could not be restarted." >&2
    fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

container_id="$(docker compose ps -q control-plane 2>/dev/null || true)"
old_image="unknown"
if [ -n "$container_id" ]; then
    old_image="$(docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null || printf '%s' unknown)"
fi

printf '%s\n' "Stopping the control plane before taking the pre-update database backup."
docker compose stop control-plane
container_id="$(docker compose ps -q control-plane 2>/dev/null || true)"
if [ -n "$container_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || printf '%s' unknown)" != "false" ]; then
    fail "The control plane did not stop; no backup or update was attempted."
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="$backup_root/gateway-control-$timestamp.dump"
manifest_path="$backup_path.sha256"
[ ! -e "$backup_path" ] && [ ! -L "$backup_path" ] && [ ! -e "$manifest_path" ] && [ ! -L "$manifest_path" ] || fail "The pre-update backup name already exists."
temporary_dump="$(mktemp "$backup_root/.gateway-control-$timestamp.XXXXXX.dump")"
temporary_manifest="$(mktemp "$backup_root/.gateway-control-$timestamp.XXXXXX.sha256")"

printf '%s\n' "Creating a PostgreSQL custom dump while the application writer is stopped."
docker compose exec -T postgres sh -ec \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec pg_dump --format=custom --no-owner --no-privileges --username "$POSTGRES_USER" "$POSTGRES_DB"' \
    > "$temporary_dump"
chmod 0600 "$temporary_dump"
[ -s "$temporary_dump" ] || fail "The PostgreSQL dump is empty."
docker compose exec -T postgres pg_restore --list < "$temporary_dump" >/dev/null
checksum="$(sha256sum "$temporary_dump" | awk '{print $1}')"
printf '%s  %s\n' "$checksum" "$(basename "$backup_path")" > "$temporary_manifest"
chmod 0600 "$temporary_manifest"
if command -v sync >/dev/null 2>&1; then
    sync -f "$temporary_dump" "$temporary_manifest" 2>/dev/null || sync
fi
mv "$temporary_dump" "$backup_path"
temporary_dump=''
mv "$temporary_manifest" "$manifest_path"
temporary_manifest=''
if command -v sync >/dev/null 2>&1; then
    sync -f "$backup_path" "$manifest_path" "$backup_root" 2>/dev/null || sync
fi
printf '%s\n' "Verified and synchronized pre-update backup: $backup_path"

# From this point on, never let the exit trap start a newly recreated, failed image.
restart_old=0
printf '%s\n' "Recreating only the control-plane service."
docker compose up -d --no-deps control-plane

readiness_url="http://127.0.0.1:${CONTROL_HTTP_PORT:-8080}/ready"
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    readiness=''
    if command -v curl >/dev/null 2>&1; then
        readiness="$(curl --fail --silent --show-error --max-time 2 "$readiness_url" 2>/dev/null || true)"
    elif command -v wget >/dev/null 2>&1; then
        readiness="$(wget -qO- -T 2 "$readiness_url" 2>/dev/null || true)"
    else
        fail "curl or wget is required for bounded readiness checks."
    fi
    if [ -n "$readiness" ]; then
        printf '%s\n' "Control plane is ready: $readiness"
        printf '%s\n' "Pre-update backup retained at: $backup_path"
        trap - EXIT HUP INT TERM
        exit 0
    fi
    sleep 2
done

printf '%s\n' "ERROR: The new control plane did not become ready within 120 seconds." >&2
printf '%s\n' "The verified backup remains at: $backup_path" >&2
printf '%s\n' "Previous image reference: $old_image" >&2
printf '%s\n' "Do not restore the database automatically. Inspect logs and apply a forward fix or a separately reviewed recovery procedure." >&2
exit 1
