#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${COMMISSION_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/commission/staging.env}

exec foundation exec RESEND_API_KEY=commission-resend-api-key -- \
  docker compose --file "$project_dir/ops/compose.staging.yaml" --env-file "$env_file" "$@"
