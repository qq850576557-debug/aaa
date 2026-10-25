#!/usr/bin/env bash
# Explicit opt-in only. Does not modify PostgreSQL, firewall or security groups.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 && $# == 3 ]] || { echo 'Usage (root): bash deploy/native/public-https.sh https://39.105.64.188:15001 /absolute/fullchain.pem /absolute/private.key' >&2; exit 1; }
BASE=/opt/chunmo-staging
CONF=/etc/chunmo-staging
TLS=/etc/pki/chunmo-staging
[[ -L $BASE/current && -f $BASE/current/.verified-build && -f $BASE/current/dist-deploy/public.mjs ]] || { echo 'Run the updated internal deploy first.' >&2; exit 1; }
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
# tools.env is root-owned and contains only reviewed executable paths, never DB credentials.
source "$CONF/tools.env"
BUNDLE=$("$NODE_BIN" "$BASE/current/dist-deploy/public.mjs" "$1" "$2" "$3")
[[ $BUNDLE == "$TLS/public-"* && -d $BUNDLE ]] || exit 1
chgrp chunmo-staging-web "$BUNDLE" "$BUNDLE/fullchain.pem" "$BUNDLE/server.key"
NGINX=$(command -v nginx)
runuser -u chunmo-staging-web -- "$NGINX" -t -p /var/lib/chunmo-staging-web/ -c "$BUNDLE/nginx.conf"
BACKUP=$(mktemp -d "$CONF/public-before.XXXXXXXX")
cp -p "$CONF/runtime.env" "$BASE/nginx.conf" "$BACKUP/"
if [[ -f $CONF/public-https.json ]]; then cp -p "$CONF/public-https.json" "$BACKUP/"; fi
ACTIVATED=0
replace() { install -m "$3" "$1" "$2.next"; mv -f "$2.next" "$2"; }
rollback() {
  status=$?
  trap - ERR
  if (( ACTIVATED )); then
    replace "$BACKUP/runtime.env" "$CONF/runtime.env" 0600
    replace "$BACKUP/nginx.conf" "$BASE/nginx.conf" 0644
    if [[ -f $BACKUP/public-https.json ]]; then replace "$BACKUP/public-https.json" "$CONF/public-https.json" 0600
    else rm -f "$CONF/public-https.json"; fi
    systemctl restart chunmo-staging-api chunmo-staging-web || true
  fi
  echo "Public activation failed; previous configuration restored. Backup: $BACKUP. No database or firewall changes." >&2
  exit "$status"
}
trap rollback ERR
ACTIVATED=1
replace "$BUNDLE/runtime.env" "$CONF/runtime.env" 0600
replace "$BUNDLE/public-https.json" "$CONF/public-https.json" 0600
replace "$BUNDLE/nginx.conf" "$BASE/nginx.conf" 0644
systemctl restart chunmo-staging-api chunmo-staging-web
HOST=${1#https://}; HOST=${HOST%:15001}
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 --resolve "$HOST:15001:127.0.0.1" "$1/api/health" >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --show-error --max-time 10 --resolve "$HOST:15001:127.0.0.1" "$1/api/health" | /usr/bin/python3 -c 'import sys,json; assert json.load(sys.stdin)["ok"] is True'
# Full existing account/permission/CAS/SSE smoke runs locally with the exact public Origin.
(cd "$BASE/current" && "$NODE_BIN" dist-deploy/ops.mjs smoke "$CONF" https://localhost:8443 "$TLS/ca.crt")
systemctl restart chunmo-staging-api
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 --cacert "$TLS/ca.crt" https://localhost:8443/api/health >/dev/null; then break; fi
  sleep 1
done
(cd "$BASE/current" && "$NODE_BIN" dist-deploy/ops.mjs after-restart "$CONF" https://localhost:8443 "$TLS/ca.crt")
trap - ERR
printf 'PASS public HTTPS local verification: %s\nBackup: %s\nAllow inbound TCP 15001 in existing firewall/security group only after review; no rules changed.\nRenew the trusted certificate before expiry by rerunning this command with the renewed files.\n' "$1" "$BACKUP"
