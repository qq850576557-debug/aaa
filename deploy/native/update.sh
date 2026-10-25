#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Use sudo/root.' >&2; exit 1; }
# Fetches only the feature branch; does not checkout/reset/merge the source tree.
exec bash /opt/chunmo-staging/current/deploy/native/deploy.sh --update
