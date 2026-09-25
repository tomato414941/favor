#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${FAVOR_ENV_FILE:-$project_dir/.env.staging}

exec foundation exec RESEND_API_KEY=favor-resend-api-key \
  STRIPE_API_KEY=favor-stripe-test-api-key \
  STRIPE_WEBHOOK_SECRET=favor-stripe-test-webhook-secret -- \
  docker compose --file "$project_dir/ops/compose.staging.yaml" --env-file "$env_file" "$@"
