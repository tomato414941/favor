#!/bin/sh
# Log in as the sample account through the public API and print a fresh request link URL.
# Reuses the pending sample link (reissuing its URL) or creates one when none is pending.
#
#   ops/sample-link.sh                       # staging: origin from staging.env, codes read from the container
#   COMMISSION_ORIGIN=http://127.0.0.1:3210 COMMISSION_MAIL_DIR=data/mail ops/sample-link.sh   # local server
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${COMMISSION_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/commission/staging.env}
domain=${COMMISSION_TEST_MAIL_DOMAIN:-commission.test}
email=$(printf '%s' "${COMMISSION_SAMPLE_EMAIL:-sample@$domain}" | tr '[:upper:]' '[:lower:]')
origin=${COMMISSION_ORIGIN:-}
if [ -z "$origin" ]; then
  host=$(sed -n 's/^COMMISSION_HOST=//p' "$env_file" | tail -n 1)
  [ -n "$host" ] || { echo "Set COMMISSION_ORIGIN or COMMISSION_HOST in $env_file." >&2; exit 1; }
  origin="https://$host"
fi

jar=$(mktemp)
trap 'rm -f "$jar"' EXIT

api() {
  method=$1; path=$2; body=${3:-}; key=${4:-}
  curl -sS --fail-with-body --max-time 20 -X "$method" "$origin/api$path" \
    -b "$jar" -c "$jar" -H "Origin: $origin" -H 'X-Commission-Action: 1' \
    -H 'Content-Type: application/json' ${key:+-H "Idempotency-Key: $key"} ${body:+--data "$body"}
}
new_key() { head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
read_code() {
  file="$(printf '%s' "$email" | sha256sum | cut -d ' ' -f 1).json"
  if [ -n "${COMMISSION_MAIL_DIR:-}" ]; then
    cat "$COMMISSION_MAIL_DIR/$file"
  else
    "$project_dir/ops/staging.sh" exec -T app sh -c 'cat "$COMMISSION_DATA_DIR/mail/$1"' sh "$file"
  fi | jq -r '.code'
}

api POST /auth/email/start "$(jq -cn --arg email "$email" '{email: $email}')" >/dev/null
code=$(read_code)
[ -n "$code" ] && [ "$code" != null ] || { echo "No verification code found for $email." >&2; exit 1; }
api POST /auth/email/verify "$(jq -cn --arg code "$code" '{code: $code}')" >/dev/null

pending=$(api GET /links | jq -r '[.links[] | select(.state == "pending")][0].id // empty')
if [ -n "$pending" ]; then
  result=$(api POST "/links/$pending/reissue" '{}' "$(new_key)")
else
  body=$(jq -cn '{
    brief: "見本の依頼です。ステージングの表示確認用に作成しています。\n\n静かな夜の海辺と、遠くに見える灯台の風景を描いてください。人物は入れず、色味は落ち着いたものを希望します。用途は個人で楽しむためで、参考資料はありません。",
    amount: 12000, visibility: "hidden", agreeToRules: true }')
  result=$(api POST /links "$body" "$(new_key)")
fi
token=$(printf '%s' "$result" | jq -r '.token // empty')
[ -n "$token" ] || { echo "The link was not returned. Try again in a moment." >&2; exit 1; }
echo "$origin/#link=$token"
