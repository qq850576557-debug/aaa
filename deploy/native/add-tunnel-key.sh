#!/usr/bin/env bash
# OPTIONAL, explicitly invoked by ECS administrator after reviewing the guide.
# Adds a public key to a forwarding-only OS account; never grants shell/PG access.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 && $# == 1 && -f $1 ]] || { echo 'Usage: sudo bash add-tunnel-key.sh /path/to/one-ed25519-public-key' >&2; exit 1; }
KEY_FILE=$1
[[ $(wc -l < "$KEY_FILE") == 1 ]] || { echo 'Exactly one public key line is required.' >&2; exit 1; }
grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( [^[:cntrl:]]*)?$' "$KEY_FILE" || { echo 'Only a plain Ed25519 public key is accepted; never upload a private key.' >&2; exit 1; }
ssh-keygen -l -f "$KEY_FILE" >/dev/null
SSHD=$(command -v sshd || true)
[[ -n $SSHD ]] || { echo 'OpenSSH server is required.' >&2; exit 1; }
exec 9>/run/lock/chunmo-tunnel-config.lock
flock -n 9 || exit 1
if ! id chunmo-tunnel >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/empty/chunmo-tunnel --shell /sbin/nologin --password '*' chunmo-tunnel
fi
[[ $(getent passwd chunmo-tunnel | cut -d: -f6) == /var/empty/chunmo-tunnel && $(getent passwd chunmo-tunnel | cut -d: -f7) == /sbin/nologin ]] || { echo 'Unexpected existing tunnel account; refusing reuse.' >&2; exit 1; }
install -d -o root -g root -m 0755 /etc/chunmo-tunnel
CONFIG=/etc/ssh/sshd_config
TEMP=$(mktemp /etc/ssh/chunmo-sshd.XXXXXXXX)
trap 'rm -f "$TEMP"' EXIT
python3 - "$CONFIG" "$TEMP" <<'PY'
import sys
old=open(sys.argv[1]).read()
start='# BEGIN CHUNMO TUNNEL MANAGED'
end='# END CHUNMO TUNNEL MANAGED'
block='''# BEGIN CHUNMO TUNNEL MANAGED
Match User chunmo-tunnel
  AuthenticationMethods publickey
  PubkeyAuthentication yes
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  AuthorizedKeysFile /etc/chunmo-tunnel/authorized_keys
  ForceCommand /bin/false
  PermitTTY no
  X11Forwarding no
  AllowAgentForwarding no
  AllowTcpForwarding local
  AllowStreamLocalForwarding no
  PermitOpen 127.0.0.1:8443
  GatewayPorts no
  PermitTunnel no
Match all
# END CHUNMO TUNNEL MANAGED
'''
if start in old or end in old:
    if old.count(start)!=1 or old.count(end)!=1 or block not in old:
        raise SystemExit('Existing managed SSH block was changed; review manually.')
    new=old
else:
    new=old+'\n'+block
open(sys.argv[2],'w').write(new)
PY
"$SSHD" -t -f "$TEMP"
CHECK=$($SSHD -T -f "$TEMP" -C user=chunmo-tunnel,host=localhost,addr=127.0.0.1)
for expected in 'forcecommand /bin/false' 'allowtcpforwarding local' 'allowstreamlocalforwarding no' 'permitopen 127.0.0.1:8443' 'passwordauthentication no' 'authenticationmethods publickey' 'authorizedkeysfile /etc/chunmo-tunnel/authorized_keys'; do
  grep -Fxq "$expected" <<< "$CHECK" || { echo 'Existing SSH rules conflict with the restricted account; no SSH config changed.' >&2; exit 1; }
done
[[ -f /etc/chunmo-tunnel/sshd_config.before ]] || install -m 0600 "$CONFIG" /etc/chunmo-tunnel/sshd_config.before
# Keep a per-run rollback copy so a failed reload restores the immediate previous config.
ROLLBACK=$(mktemp /etc/ssh/chunmo-rollback.XXXXXXXX)
cp -p "$CONFIG" "$ROLLBACK"
install -o root -g root -m 0600 "$TEMP" "$CONFIG"
command -v restorecon >/dev/null && restorecon "$CONFIG" || true
if ! systemctl reload sshd; then
  cp -p "$ROLLBACK" "$CONFIG"
  command -v restorecon >/dev/null && restorecon "$CONFIG" || true
  echo 'SSH reload failed; previous config restored. Existing sessions preserved.' >&2
  exit 1
fi
rm -f "$ROLLBACK"
KEY=$(cat "$KEY_FILE")
# Plain public keys only, written after the restricted server policy is active.
touch /etc/chunmo-tunnel/authorized_keys
if ! grep -Fxq "$KEY" /etc/chunmo-tunnel/authorized_keys; then printf '%s\n' "$KEY" >> /etc/chunmo-tunnel/authorized_keys; fi
chmod 0644 /etc/chunmo-tunnel/authorized_keys
printf 'Forward-only key enrolled. No shell/SFTP/remote-forward/Unix-socket/PG forwarding. No security group changed.\n'
ssh-keygen -l -f "$KEY_FILE"
