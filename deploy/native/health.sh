#!/usr/bin/env bash
set -Eeuo pipefail
systemctl is-active --quiet chunmo-staging-api chunmo-staging-web
curl --fail --silent --show-error --max-time 10 --cacert /etc/pki/chunmo-staging/ca.crt https://localhost:8443/api/health | /usr/bin/python3 -c 'import sys,json; assert json.load(sys.stdin)["ok"] is True'
openssl x509 -checkend 1209600 -noout -in /etc/pki/chunmo-staging/server.crt
printf 'PASS private HTTPS health and TLS validity.\n'
if [[ -f /etc/chunmo-staging/public-https.json ]]; then
  readarray -t PUBLIC < <(/usr/bin/python3 -c 'import json; c=json.load(open("/etc/chunmo-staging/public-https.json")); print(c["origin"]); print(c["certificate"])')
  HOST=${PUBLIC[0]#https://}; HOST=${HOST%:15001}
  curl --fail --silent --show-error --max-time 10 --resolve "$HOST:15001:127.0.0.1" "${PUBLIC[0]}/api/health" | /usr/bin/python3 -c 'import sys,json; assert json.load(sys.stdin)["ok"] is True'
  openssl x509 -checkend 86400 -noout -in "${PUBLIC[1]}"
  printf 'PASS public HTTPS health (24-hour certificate expiry warning threshold).\n'
fi
