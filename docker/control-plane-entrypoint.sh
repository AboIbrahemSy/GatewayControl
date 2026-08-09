#!/bin/sh
set -eu

read_secret() {
    variable_name="$1"
    file_variable_name="${variable_name}_FILE"
    eval direct_value="\${${variable_name}:-}"
    eval file_value="\${${file_variable_name}:-}"

    if [ -n "$direct_value" ] && [ -n "$file_value" ]; then
        echo "${variable_name} and ${file_variable_name} are mutually exclusive." >&2
        exit 1
    fi

    if [ -n "$file_value" ]; then
        if [ ! -r "$file_value" ]; then
            echo "${file_variable_name} is not readable." >&2
            exit 1
        fi
        cat "$file_value"
        return
    fi

    printf '%s' "$direct_value"
}

database_password="$(read_secret DATABASE_PASSWORD)"
if [ -z "$database_password" ]; then
    echo "DATABASE_PASSWORD or DATABASE_PASSWORD_FILE is required." >&2
    exit 1
fi

database_user="${DATABASE_USER:-gateway_control}"
database_name="${DATABASE_NAME:-gateway_control}"
database_host="${DATABASE_HOST:-postgres}"
database_port="${DATABASE_PORT:-5432}"
export DATABASE_URL="postgresql://${database_user}:${database_password}@${database_host}:${database_port}/${database_name}"

node dist/src/migrate.js
exec node dist/src/server.js
