#!/usr/bin/env bash
set -Eeuo pipefail
systemctl is-active --quiet chunmo-staging-api chunmo-staging-web
curl --fail --silent --show-error --max-time 10 --cacert /etc/pki/chunmo-staging/ca.crt https://localhost:8443/api/health | /usr/bin/python3 -c 'import sys,json; assert json.load(sys.stdin)["ok"] is True'
openssl x509 -checkend 1209600 -noout -in /etc/pki/chunmo-staging/server.crt
printf 'PASS private HTTPS health and TLS validity.\n'
