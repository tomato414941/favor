#!/bin/sh
# Sign in as the sample account (a Clerk user) and print a Checkout or request link URL.
# Complete test card entry at Checkout, then rerun to obtain the request link.
#
#   ops/sample-link.sh                                   # staging: origin and Clerk key from staging.env
#   FAVOR_ORIGIN=http://127.0.0.1:3210 CLERK_SECRET_KEY=sk_test_... ops/sample-link.sh   # local server
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${FAVOR_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/favor/staging.env}
# Clerk rejects reserved test domains, so the sample account uses a plain address; it never receives mail.
email=$(printf '%s' "${FAVOR_SAMPLE_EMAIL:-favor.sample@example.com}" | tr '[:upper:]' '[:lower:]')
origin=${FAVOR_ORIGIN:-}
if [ -z "$origin" ]; then
  host=$(sed -n 's/^FAVOR_HOST=//p' "$env_file" | tail -n 1)
  [ -n "$host" ] || { echo "Set FAVOR_ORIGIN or FAVOR_HOST in $env_file." >&2; exit 1; }
  origin="https://$host"
fi

new_key() { head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
clerk() {
  method=$1; path=$2; body=${3:-}
  curl -sS --fail-with-body --max-time 20 -X "$method" "https://api.clerk.com/v1$path" \
    -H "Authorization: Bearer $CLERK_SECRET_KEY" -H 'Content-Type: application/json' ${body:+--data "$body"}
}
[ -n "${CLERK_SECRET_KEY:-}" ] || CLERK_SECRET_KEY=$(sed -n 's/^CLERK_SECRET_KEY=//p' "$env_file" | tail -n 1)
[ -n "$CLERK_SECRET_KEY" ] || { echo "Set CLERK_SECRET_KEY or put it in $env_file." >&2; exit 1; }
user=$(clerk GET "/users?email_address=$(printf '%s' "$email" | jq -sRr @uri)&limit=1" | jq -r '.[0].id // empty')
[ -n "$user" ] || user=$(clerk POST /users "$(jq -cn --arg e "$email" '{email_address: [$e], first_name: "見本", last_name: "依頼者", skip_password_requirement: true}')" | jq -r .id)
session=$(clerk POST /sessions "$(jq -cn --arg u "$user" '{user_id: $u}')" | jq -r .id)
jwt=$(clerk POST "/sessions/$session/tokens" '{}' | jq -r .jwt)
api() {
  method=$1; path=$2; body=${3:-}; key=${4:-}
  curl -sS --fail-with-body --max-time 20 -X "$method" "$origin/api$path" \
    -H "Authorization: Bearer $jwt" -H "Origin: $origin" -H 'X-Favor-Action: 1' \
    -H 'Content-Type: application/json' ${key:+-H "Idempotency-Key: $key"} ${body:+--data "$body"}
}

links=$(api GET /links)
pending=$(printf '%s' "$links" | jq -r '[.links[] | select(.state == "pending")][0].id // empty')
draft=$(printf '%s' "$links" | jq -r '[.links[] | select(.state == "awaiting_payment")][0] // empty')
if [ -n "$pending" ]; then
  result=$(api POST "/links/$pending/reissue" '{}' "$(new_key)")
elif [ -n "$draft" ]; then
  id=$(printf '%s' "$draft" | jq -r '.id')
  if [ "$(printf '%s' "$draft" | jq -r '.paymentState')" = authorized ]; then
    result=$(api POST "/links/$id/complete-payment" '{}' "$(new_key)")
  else
    result=$(api POST "/links/$id/checkout" '{}')
  fi
else
  body=$(jq -cn '{
    brief: "見本の依頼です。ステージングの表示確認用に作成しています。\n\n静かな夜の海辺と、遠くに見える灯台の風景を描いてください。人物は入れず、色味は落ち着いたものを希望します。用途は個人で楽しむためで、参考資料はありません。",
    amount: 12000, visibility: "hidden", agreeToRules: true }')
  result=$(api POST /links "$body" "$(new_key)")
fi
checkout=$(printf '%s' "$result" | jq -r '.checkoutUrl // empty')
if [ -n "$checkout" ]; then
  echo "$checkout"
  exit 0
fi
token=$(printf '%s' "$result" | jq -r '.token // empty')
[ -n "$token" ] || { echo "The link was not returned. Try again in a moment." >&2; exit 1; }
echo "$origin/link#$token"
