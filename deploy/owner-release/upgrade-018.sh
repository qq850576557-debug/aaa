#!/usr/bin/env bash
# OWNER-007 production entry point. The original bootstrap mode is not used.
set -Eeuo pipefail
dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ $# == 2 && ( $1 == --deploy || $1 == --rollback ) ]] || {
  printf '用法 upgrade-018.sh --deploy|--rollback 完整发布 SHA\n' >&2
  exit 1
}
exec bash "$dir/deploy.sh" "$1-owner-018" "$2"
