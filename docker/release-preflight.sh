#!/bin/sh

release_preflight_fail() {
    printf '%s\n' "ERROR: $*" >&2
    exit 1
}

command -v docker >/dev/null 2>&1 || release_preflight_fail "docker is required."
: "${GATEWAY_CONTROL_IMAGE:?Set GATEWAY_CONTROL_IMAGE to the immutable release image digest}"
printf '%s\n' "$GATEWAY_CONTROL_IMAGE" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' \
    || release_preflight_fail "GATEWAY_CONTROL_IMAGE must be exactly an image reference with a valid immutable @sha256:64-hex digest."
export GATEWAY_CONTROL_IMAGE
