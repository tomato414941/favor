#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${FAVOR_ENV_FILE:-$project_dir/.env.staging}

exec docker compose --file "$project_dir/ops/compose.staging.yaml" --env-file "$env_file" "$@"
