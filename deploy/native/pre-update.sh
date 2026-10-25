#!/usr/bin/env bash
# Explicit V1.1 pre-update snapshot. Never modifies services or a database schema.
set -Eeuo pipefail
umask 077
trap 'status=$?; printf "Pre-update backup stopped (line=%s, exit=%s); deployment not started. Retain protected partial files for investigation.\n" "$LINENO" "$status" >&2; exit "$status"' ERR
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
BASE=/opt/chunmo-staging
CONF=/etc/chunmo-staging
BACKUPS=/var/backups/chunmo-staging
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || { echo 'Deployment/backup busy; retry later.' >&2; exit 1; }
PREVIOUS=$(readlink -e "$BASE/current")
[[ $PREVIOUS == "$BASE/releases/"* && -f $PREVIOUS/.verified-build ]] || { echo 'Existing verified managed release required.' >&2; exit 1; }
source "$CONF/tools.env"
# Use the still-running version's backup format/credentials before applying any migration.
(cd "$PREVIOUS" && "$NODE_BIN" dist-deploy/ops.mjs backup "$CONF" "$BACKUPS" "$PG_DUMP_BIN")
SNAPSHOT=$(mktemp -d "$BACKUPS/v11-before-$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")
printf '%s\n' "$PREVIOUS" > "$SNAPSHOT/previous-release"
cp -p "$BASE/nginx.conf" "$SNAPSHOT/nginx.conf"
tar -czf "$SNAPSHOT/release.tar.gz" -C "$PREVIOUS" .
tar -czf "$SNAPSHOT/private-config-and-tls.tar.gz" -C / etc/chunmo-staging etc/pki/chunmo-staging
chmod 0600 "$SNAPSHOT/"*
(cd "$SNAPSHOT" && sha256sum release.tar.gz private-config-and-tls.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS)
printf 'PASS pre-update backup; current release retained: %s\nProtected snapshot: %s\nContains private keys; never distribute or commit this directory.\n' "$PREVIOUS" "$SNAPSHOT"
