#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_directory/release-preflight.sh"

printf '%s\n' "Pulling immutable production images."
docker compose pull
printf '%s\n' "Starting the production services."
docker compose up -d
