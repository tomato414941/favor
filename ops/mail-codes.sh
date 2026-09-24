#!/bin/sh
# Print the verification codes saved for the reserved test mail domain on staging.
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$project_dir/ops/staging.sh" exec -T app sh -c \
  'for file in "$FAVOR_DATA_DIR"/mail/*.json; do [ -e "$file" ] || { echo "No codes saved yet."; exit 0; }; cat "$file"; echo; done'
