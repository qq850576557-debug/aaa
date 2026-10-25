#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Use sudo/root.' >&2; exit 1; }
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || { echo 'Deployment/backup busy; retry after completion.' >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/chunmo-staging/tools.env
export PG_ADMIN_SOCKET
cd /opt/chunmo-staging/current
case ${1:-backup} in
  backup) exec "$NODE_BIN" dist-deploy/ops.mjs backup /etc/chunmo-staging /var/backups/chunmo-staging "$PG_DUMP_BIN" ;;
  verify) [[ -n ${2:-} ]] || { echo 'Provide a .cmbackup archive path.' >&2; exit 1; }; exec "$NODE_BIN" dist-deploy/ops.mjs restore-check /etc/chunmo-staging "$2" "$PG_RESTORE_BIN" ;;
  *) echo 'Usage: backup.sh [backup | verify /absolute/archive.cmbackup]' >&2; exit 1 ;;
esac
