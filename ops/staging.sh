#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${FAVOR_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/favor/staging.env}

exec foundation exec RESEND_API_KEY=favor-resend-api-key -- \
  docker compose --file "$project_dir/ops/compose.staging.yaml" --env-file "$env_file" "$@"
