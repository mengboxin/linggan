#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$script_dir/.env" ]; then
  set -a
  . "$script_dir/.env"
  set +a
fi

exec "$script_dir/controlplane"
