#!/usr/bin/env bash
# Explicit opt-in only. Does not modify PostgreSQL, firewall or security groups.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
if [[ $# == 2 && $1 == --private-ca ]]; then ORIGIN=$2
elif [[ $# == 3 && $1 != --* ]]; then ORIGIN=$1
else echo 'Usage (root): public-https.sh --private-ca https://39.105.64.188:15001 OR public-https.sh ORIGIN FULLCHAIN KEY' >&2; exit 1; fi
BASE=/opt/chunmo-staging
CONF=/etc/chunmo-staging
TLS=/etc/pki/chunmo-staging
[[ -L $BASE/current && -f $BASE/current/.verified-build && -f $BASE/current/dist-deploy/public.mjs ]] || { echo 'Run the updated internal deploy first.' >&2; exit 1; }
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
# tools.env is root-owned and contains only reviewed executable paths, never DB credentials.
source "$CONF/tools.env"
BUNDLE=$("$NODE_BIN" "$BASE/current/dist-deploy/public.mjs" "$@")
[[ $BUNDLE == "$TLS/public-"* && -d $BUNDLE ]] || exit 1
# Node file creation inherits umask 077: grant only the web group the reads
# needed by nginx -t and startup. Keep runtime.env/public-https.json root-only.
chgrp chunmo-staging-web "$BUNDLE" "$BUNDLE/nginx.conf" "$BUNDLE/fullchain.pem" "$BUNDLE/server.key"
chmod 0750 "$BUNDLE"
chmod 0640 "$BUNDLE/nginx.conf" "$BUNDLE/fullchain.pem" "$BUNDLE/server.key"
CA=$(/usr/bin/python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(c.get("ca", "") if c.get("mode")=="private-ca" else "")' "$BUNDLE/public-https.json")
CURL_TRUST=()
if [[ -n $CA ]]; then CURL_TRUST=(--cacert "$CA" --capath "${CA%/*}"); fi
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
HOST=${ORIGIN#https://}; HOST=${HOST%:15001}
for attempt in $(seq 1 30); do
  if curl "${CURL_TRUST[@]}" --fail --silent --show-error --max-time 3 --resolve "$HOST:15001:127.0.0.1" "$ORIGIN/api/health" >/dev/null; then break; fi
  sleep 1
done
curl "${CURL_TRUST[@]}" --fail --silent --show-error --max-time 10 --resolve "$HOST:15001:127.0.0.1" "$ORIGIN/api/health" | /usr/bin/python3 -c 'import sys,json; assert json.load(sys.stdin)["ok"] is True'
# Full existing account/permission/CAS/SSE smoke runs locally with the exact public Origin.
(cd "$BASE/current" && "$NODE_BIN" dist-deploy/ops.mjs smoke "$CONF" https://localhost:8443 "$TLS/ca.crt")
systemctl restart chunmo-staging-api
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 --cacert "$TLS/ca.crt" https://localhost:8443/api/health >/dev/null; then break; fi
  sleep 1
done
(cd "$BASE/current" && "$NODE_BIN" dist-deploy/ops.mjs after-restart "$CONF" https://localhost:8443 "$TLS/ca.crt")
trap - ERR
printf 'PASS public HTTPS local verification: %s\nBackup: %s\nAllow inbound TCP 15001 in existing firewall/security group only after review; no rules changed.\nRenew the trusted certificate before expiry by rerunning this command with the renewed files.\n' "$ORIGIN" "$BACKUP"
if [[ -n $CA ]]; then
  printf 'Private CA mode: each employee must verify this SHA-256 fingerprint via a trusted channel before installing ONLY the public CA certificate: %s\n' "$CA"
  openssl x509 -in "$CA" -noout -fingerprint -sha256
fi
