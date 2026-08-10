#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_directory/release-preflight.sh"

fail() {
    printf '%s\n' "ERROR: $*" >&2
    exit 1
}

control_plane_is_stopped() {
    container_id="$(docker compose ps -q control-plane 2>/dev/null || true)"
    [ -z "$container_id" ] || [ "$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || printf '%s' unknown)" = "false" ]
}

wait_for_readiness() {
    readiness_url="http://127.0.0.1:${CONTROL_HTTP_PORT:-8080}/ready"
    deadline=$(( $(date +%s) + 120 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if command -v curl >/dev/null 2>&1; then
            if readiness="$(curl --fail --silent --show-error --max-time 2 "$readiness_url" 2>/dev/null)"; then
                printf '%s\n' "Control plane is ready: $readiness"
                return 0
            fi
        elif command -v wget >/dev/null 2>&1; then
            if readiness="$(wget -qO- -T 2 "$readiness_url" 2>/dev/null)"; then
                printf '%s\n' "Control plane is ready: $readiness"
                return 0
            fi
        else
            fail "curl or wget is required for bounded readiness checks."
        fi
        sleep 2
    done
    return 1
}

printf '%s\n' "Stopping the live control plane before recovery."
docker compose stop control-plane
if ! control_plane_is_stopped; then
    fail "The control plane could not be verified stopped; the restore was not started."
fi

printf '%s\n' "Running the isolated system restore."
if ! docker compose --profile recovery run --rm control-plane-restore; then
    printf '%s\n' "ERROR: System restore failed. The control-plane writer remains stopped." >&2
    printf '%s\n' "Inspect the recovery container output and the staged pending/applying/applied files. Re-run this wrapper only after resolving the failure; do not start the writer or run pg_restore manually." >&2
    exit 1
fi

printf '%s\n' "Recreating the control plane only after successful recovery."
docker compose up -d --no-deps control-plane
if ! wait_for_readiness; then
    printf '%s\n' "ERROR: Recovery completed, but the control plane did not become ready within 120 seconds." >&2
    printf '%s\n' "Do not run the database restore again. Inspect control-plane logs and apply a forward fix." >&2
    exit 1
fi
