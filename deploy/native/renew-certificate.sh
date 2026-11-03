#!/usr/bin/env bash
# Managed by chunmo native certificate renewal
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || exit 1
CERTBOT=/root/chunmo-acme-venv/bin/certbot
BASE=/opt/chunmo-staging
CONF=/etc/chunmo-staging
[[ -x $CERTBOT ]] || { echo 'Existing Certbot environment required.' >&2; exit 1; }
ORIGIN=$(python3 -c 'import json; print(json.load(open("/etc/chunmo-staging/public-https.json"))["origin"])')
[[ $ORIGIN == https://chmsj.cn ]] || { echo 'Renewal requires the configured chmsj.cn entry.' >&2; exit 1; }
if [[ ${1:-} == --install && $# == 1 ]]; then
  # Test HTTP validation without replacing the real certificate; save webroot
  # settings only after Certbot successfully reconfigures this lineage.
  "$CERTBOT" reconfigure --cert-name chmsj.cn --webroot \
    --webroot-path /var/lib/chunmo-acme --non-interactive
  [[ ! -L $BASE/renew-certificate.sh ]] || exit 1
  if [[ -e $BASE/renew-certificate.sh ]]; then
    grep -q '^# Managed by chunmo native certificate renewal$' "$BASE/renew-certificate.sh" || exit 1
  fi
  install -o root -g root -m 0700 "${BASH_SOURCE[0]}" "$BASE/renew-certificate.sh"
  for unit in service timer; do
    target=/etc/systemd/system/chunmo-certificate-renew.$unit
    [[ ! -L $target ]] || exit 1
    if [[ -e $target ]]; then grep -q '^# Managed by chunmo native certificate renewal$' "$target" || exit 1; fi
  done
  cat > /etc/systemd/system/chunmo-certificate-renew.service <<'UNIT'
# Managed by chunmo native certificate renewal
[Unit]
Description=Renew Chunmo domain certificate and activate changed certificate
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/chunmo-staging/renew-certificate.sh
TimeoutStartSec=20min
UMask=0077
UNIT
  cat > /etc/systemd/system/chunmo-certificate-renew.timer <<'UNIT'
# Managed by chunmo native certificate renewal
[Unit]
Description=Check Chunmo domain certificate twice daily
[Timer]
OnCalendar=*-*-* 03,15:20:00
RandomizedDelaySec=1800
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemd-analyze verify /etc/systemd/system/chunmo-certificate-renew.service /etc/systemd/system/chunmo-certificate-renew.timer
  systemctl daemon-reload
  systemctl enable --now chunmo-certificate-renew.timer
  printf 'PASS certificate renewal installed; webroot validation tested, twice-daily timer enabled.\n'
  exit 0
fi
[[ $# == 0 ]] || exit 1
exec 8>/run/lock/chunmo-certificate-renew.lock
flock -n 8 || exit 0
"$CERTBOT" renew --cert-name chmsj.cn --webroot \
  --webroot-path /var/lib/chunmo-acme --non-interactive
# Activation copies immutable certificate bundles. Compare every run so a prior
# failed activation is retried even when the certificate no longer needs renewal.
ACTIVE=$(python3 -c 'import json; print(json.load(open("/etc/chunmo-staging/public-https.json"))["certificate"])')
NEW=/etc/letsencrypt/live/chmsj.cn/fullchain.pem
if [[ $(openssl x509 -in "$ACTIVE" -noout -fingerprint -sha256) != "$(openssl x509 -in "$NEW" -noout -fingerprint -sha256)" ]]; then
  bash "$BASE/current/deploy/native/public-https.sh" https://chmsj.cn \
    "$NEW" /etc/letsencrypt/live/chmsj.cn/privkey.pem
fi
printf 'PASS certificate renewal check and activation.\n'
