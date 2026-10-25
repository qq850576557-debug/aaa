#!/usr/bin/env bash
# Native INTERNAL staging deployment. No containers, firewall/SG changes or local-data import.
set -Eeuo pipefail
umask 077
export PATH="/usr/pgsql-17/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
BASE=/opt/chunmo-staging
CONF=/etc/chunmo-staging
TLS=/etc/pki/chunmo-staging
BACKUPS=/var/backups/chunmo-staging
SOURCE_REPO=${CHUNMO_SOURCE_REPO:-/opt/chunmo-source}
PHASE=preflight
PROMOTED=0
PREVIOUS=
NODE=
RELEASE=
fail() { printf 'ERROR: %s\n' "$*" >&2; return 1; }
# BEGIN CHUNMO TLS FUNCTIONS (also exercised by the isolated TLS tests)
tls_openssl() { OPENSSL_CONF="$tls_config" openssl "$@"; }
tls_key_matches() {
  local certificate=$1 key=$2 from_cert from_key
  from_cert=$(tls_openssl x509 -in "$certificate" -pubkey -noout | tls_openssl pkey -pubin -outform DER | tls_openssl dgst -sha256) || return 1
  from_key=$(tls_openssl pkey -in "$key" -pubout -outform DER | tls_openssl dgst -sha256) || return 1
  [[ $from_cert == "$from_key" ]]
}
tls_unique_extensions() {
  local text
  text=$(tls_openssl x509 -in "$1" -text -noout) || return 1
  [[ -z $(printf '%s\n' "$text" | sed -n 's/^[[:space:]]*\(X509v3 [^:]*\):.*/\1/p' | sort | uniq -d) ]] || { printf 'TLS validation failed: duplicate certificate extensions.\n' >&2; return 1; }
}
tls_validate_pair() {
  local ca=$1 server=$2 ca_key=$3 server_key=$4 text
  tls_unique_extensions "$ca" && tls_unique_extensions "$server" || return 1
  tls_key_matches "$ca" "$ca_key" && tls_key_matches "$server" "$server_key" || return 1
  tls_openssl x509 -checkend 1209600 -noout -in "$ca" >/dev/null || return 1
  tls_openssl x509 -checkend 1209600 -noout -in "$server" >/dev/null || return 1
  text=$(tls_openssl x509 -in "$server" -text -noout) || return 1
  [[ $text == *'DNS:localhost'* && $text == *'IP Address:127.0.0.1'* && $text == *'CA:FALSE'* ]] || return 1
  tls_openssl verify -x509_strict -check_ss_sig -CAfile "$ca" "$ca" >/dev/null || return 1
  tls_openssl verify -x509_strict -purpose sslserver -CAfile "$ca" -verify_hostname localhost "$server" >/dev/null || return 1
  tls_openssl verify -x509_strict -purpose sslserver -CAfile "$ca" -verify_ip 127.0.0.1 "$server" >/dev/null
}
tls_manage_pair() {
  local mode=$1 work tls_config ca_key server_key backup name legacy bundle target
  work=$(mktemp -d "$TLS/.tls-candidate.XXXXXXXX")
  tls_config=$work/openssl.cnf
  cat > "$tls_config" <<'CNF'
[ req ]
prompt = no
distinguished_name = ca_dn
[ ca_dn ]
CN = Chunmo Internal Staging CA
[ ca_extensions ]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[ server_extensions ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
subjectAltName = DNS:localhost,IP:127.0.0.1
CNF
  [[ ! -L $TLS/.certificates ]] || { printf 'Unmanaged TLS bundle directory symlink; refusing changes.\n' >&2; return 1; }
  if [[ -e $TLS/.certificates/current || -L $TLS/.certificates/current ]]; then
    [[ -L $TLS/.certificates/current && $(readlink "$TLS/.certificates/current") =~ ^(cert-|legacy\.)[a-zA-Z0-9]{8}$ ]] || { printf 'Unmanaged TLS current path; refusing changes.\n' >&2; return 1; }
  fi
  for name in ca.crt server.crt; do
    [[ ! -L $TLS/$name || $(readlink "$TLS/$name") == ".certificates/current/$name" ]] || { printf 'Unmanaged certificate symlink; refusing changes.\n' >&2; return 1; }
  done
  ca_key=$TLS/ca.key
  server_key=$TLS/server.key
  for name in ca.key server.key; do [[ ! -L $TLS/$name ]] || { printf 'Refusing to replace a symlinked private key.\n' >&2; return 1; }; done
  if [[ -f $ca_key && -f $server_key && -f $TLS/ca.crt && -f $TLS/server.crt ]]; then
    # Resolve a managed bundle once, so validation sees one certificate generation.
    target=$TLS
    if [[ -L $TLS/.certificates/current ]]; then target=$(readlink -e "$TLS/.certificates/current"); fi
    if tls_validate_pair "$target/ca.crt" "$target/server.crt" "$ca_key" "$server_key"; then
      printf 'TLS pair already valid; existing certificates and private keys retained.\n'
      return 0
    fi
  fi
  if [[ $mode == repair ]]; then
    [[ -r $ca_key && -r $server_key ]] || { printf 'TLS repair requires both original private keys; no keys regenerated.\n' >&2; return 1; }
    # A mismatched key must be investigated, never silently adopted as a new identity.
    for name in ca server; do
      if [[ -f $TLS/$name.crt ]]; then tls_key_matches "$TLS/$name.crt" "$TLS/$name.key" || { printf 'Original certificate/private-key mismatch; active files unchanged.\n' >&2; return 1; }; fi
    done
  else
    for name in ca.key server.key ca.crt server.crt; do
      [[ ! -e $TLS/$name && ! -L $TLS/$name ]] || { printf 'TLS pair is invalid/partial; run deploy.sh --repair-tls with retained keys.\n' >&2; return 1; }
    done
    ca_key=$work/ca.key
    server_key=$work/server.key
    tls_openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$ca_key" >/dev/null 2>&1
    tls_openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$server_key" >/dev/null 2>&1
  fi
  # Everything is issued with explicit sections; no default config or -addext merging.
  tls_openssl req -new -x509 -key "$ca_key" -config "$tls_config" -extensions ca_extensions -sha256 -days 3650 -set_serial "0x$(tls_openssl rand -hex 16)" -out "$work/ca.crt"
  tls_openssl req -new -key "$server_key" -config "$tls_config" -subj '/CN=localhost' -out "$work/server.csr"
  tls_openssl x509 -req -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$ca_key" -set_serial "0x$(tls_openssl rand -hex 16)" -days 365 -sha256 -extfile "$tls_config" -extensions server_extensions -out "$work/server.crt"
  tls_validate_pair "$work/ca.crt" "$work/server.crt" "$ca_key" "$server_key" || { printf 'Candidate TLS validation failed; active certificates/private keys unchanged.\n' >&2; return 1; }
  if [[ $mode == repair ]]; then
    backup=$(mktemp -d "$TLS/backup-$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")
    chmod 0700 "$backup"
    for name in ca.key server.key ca.crt server.crt ca.srl server.csr server.ext; do
      if [[ -f $TLS/$name ]]; then cp -pL "$TLS/$name" "$backup/$name"; fi
    done
    if [[ -n ${BASE:-} && -f ${BASE:-}/chunmo-staging-ca.crt ]]; then cp -pL "$BASE/chunmo-staging-ca.crt" "$backup/exported-ca.crt"; fi
    printf 'Original TLS files backed up privately: %s\n' "$backup"
  fi
  # Publish certificates together via one atomic current-symlink replacement.
  # Existing legacy aliases are first pointed at an unchanged legacy bundle.
  mkdir -p "$TLS/.certificates"
  chgrp --reference="$TLS" "$TLS/.certificates" "$work"
  chmod 0750 "$TLS/.certificates"
  if [[ -e $TLS/.certificates/current && ! -L $TLS/.certificates/current ]]; then printf 'Unmanaged TLS current path; refusing overwrite.\n' >&2; return 1; fi
  for name in ca.crt server.crt; do
    [[ ! -L $TLS/$name || $(readlink "$TLS/$name") == ".certificates/current/$name" ]] || { printf 'Unmanaged certificate symlink; refusing overwrite.\n' >&2; return 1; }
  done
  if [[ ! -L $TLS/.certificates/current && -f $TLS/ca.crt && -f $TLS/server.crt ]]; then
    legacy=$(mktemp -d "$TLS/.certificates/legacy.XXXXXXXX")
    cp -pL "$TLS/ca.crt" "$TLS/server.crt" "$legacy/"
    chgrp --reference="$TLS" "$legacy"
    chmod 0750 "$legacy"
    chmod 0644 "$legacy/ca.crt" "$legacy/server.crt"
    ln -s "${legacy##*/}" "$TLS/.certificates/current"
  fi
  if [[ $mode != repair ]]; then mv -T "$ca_key" "$TLS/ca.key"; mv -T "$server_key" "$TLS/server.key"; fi
  chmod 0644 "$work/ca.crt" "$work/server.crt"
  chmod 0750 "$work"
  bundle=$TLS/.certificates/cert-${work##*.tls-candidate.}
  mv -T "$work" "$bundle"
  for name in ca.crt server.crt; do
    if [[ ! -L $TLS/$name ]]; then
      ln -s ".certificates/current/$name" "$TLS/.$name.next.$$"
      mv -Tf "$TLS/.$name.next.$$" "$TLS/$name"
    fi
  done
  ln -s "${bundle##*/}" "$TLS/.certificates/.current.next.$$"
  mv -Tf "$TLS/.certificates/.current.next.$$" "$TLS/.certificates/current"
  printf 'Validated TLS certificate pair atomically activated; private keys retained.\n'
}
tls_finish_permissions() {
  chown root:chunmo-staging-web "$TLS/server.key" "$TLS/server.crt" "$TLS/ca.crt"
  chmod 0600 "$TLS/ca.key"
  chmod 0640 "$TLS/server.key"
  chmod 0644 "$TLS/server.crt" "$TLS/ca.crt"
  install -m 0644 "$TLS/ca.crt" "$BASE/.chunmo-staging-ca.crt.next.$$"
  mv -Tf "$BASE/.chunmo-staging-ca.crt.next.$$" "$BASE/chunmo-staging-ca.crt"
}
# END CHUNMO TLS FUNCTIONS

on_error() {
  local code=$? line=$1
  trap - ERR
  printf 'Deployment stopped (phase=%s, line=%s, exit=%s). No database reset/down-migration performed.\n' "$PHASE" "$line" "$code" >&2
  if [[ -n "$NODE" && -n "$RELEASE" && -f "$RELEASE/dist-deploy/ops.mjs" && -f "$CONF/control.json" ]]; then
    (cd "$RELEASE" && "$NODE" dist-deploy/ops.mjs cleanup "$CONF") || true
  fi
  if [[ $PROMOTED == 1 ]]; then
    if [[ -n "$PREVIOUS" ]]; then
      ln -s "$PREVIOUS" "$BASE/.rollback-next.$$"
      mv -Tf "$BASE/.rollback-next.$$" "$BASE/current"
      systemctl restart chunmo-staging-api chunmo-staging-web || true
      if [[ $PREVIOUS != "$RELEASE" ]]; then printf 'Previous code release restored. Database migration was NOT reversed; inspect compatibility.\n' >&2
      else printf 'Current release retained; no distinct previous code release exists. Database was not reversed.\n' >&2; fi
    else
      systemctl stop chunmo-staging-web chunmo-staging-api || true
    fi
  fi
  printf 'Diagnostics: systemctl status chunmo-staging-api chunmo-staging-web; journalctl -u chunmo-staging-api -u chunmo-staging-web -n 60\n' >&2
  exit "$code"
}
# Explicit certificate-only repair: exits before PostgreSQL/build/service deployment.
if [[ ${1:-} == --repair-tls ]]; then
  [[ $EUID == 0 && $# == 1 ]] || fail 'Use sudo bash deploy.sh --repair-tls.'
  [[ -d $TLS && ! -L $TLS && -d $BASE ]] || fail 'Existing staging TLS/base directories required; nothing deleted.'
  command -v openssl >/dev/null || fail 'OpenSSL required.'
  exec 9>/run/lock/chunmo-staging-deploy.lock
  flock -n 9 || fail 'Deployment/backup/TLS repair busy.'
  trap 'printf "TLS repair stopped; originals and backup retained; PostgreSQL was not accessed.\n" >&2' ERR
  tls_manage_pair repair
  tls_finish_permissions
  openssl x509 -noout -fingerprint -sha256 -in "$TLS/ca.crt"
  printf 'TLS-only repair passed. Reimport the verified public CA if its fingerprint changed, then rerun deployment to reload HTTPS.\n'
  exit 0
fi
trap 'on_error "$LINENO"' ERR
[[ $EUID == 0 ]] || fail 'Run with sudo/root in Workbench.'
[[ -d /run/systemd/system ]] || fail 'A native systemd host is required; no container deployment.'
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || fail 'Another deployment/backup/restore is running.'
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == alinux && ${VERSION_ID:-} == 3* ]] || fail 'This installer targets Alibaba Cloud Linux 3 only.'
for command in git runuser openssl curl python3 flock systemctl ss; do command -v "$command" >/dev/null || fail "Missing prerequisite: $command"; done
NODE=$(readlink -f "$(command -v node)")
[[ $NODE =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail 'Node must have a system-wide executable path without spaces.'
"$NODE" -e 'const [m,n]=process.versions.node.split(".").map(Number);if(!((m===22&&n>=12)||m===24))process.exit(1)' || fail 'Use supported Node22.12+ or Node24; Node22.23.4 is supported.'
PSQL=$(command -v psql || true); DUMP=$(command -v pg_dump || true); RESTORE=$(command -v pg_restore || true)
[[ -n $PSQL && -n $DUMP && -n $RESTORE ]] || fail 'PostgreSQL17 client tools required (often /usr/pgsql-17/bin). No server will be installed/initialized.'
"$DUMP" --version | grep -Eq 'PostgreSQL\) 17\.' || fail 'pg_dump major must be17.'
PG_UNIT=
for candidate in postgresql-17.service postgresql.service; do if systemctl is-active --quiet "$candidate"; then PG_UNIT=$candidate; break; fi; done
[[ -n $PG_UNIT ]] || fail 'Existing PostgreSQL systemd service is not active.'
PG_ADMIN_SOCKET=
for candidate in /var/run/postgresql /run/postgresql /tmp; do if [[ -S $candidate/.s.PGSQL.5432 ]]; then PG_ADMIN_SOCKET=$candidate; break; fi; done
[[ -n $PG_ADMIN_SOCKET ]] || fail 'No existing local PostgreSQL5432 Unix socket found.'
export PG_ADMIN_SOCKET
sql() { runuser -u postgres -- env -i PATH="$PATH" "$PSQL" -X --no-password -v ON_ERROR_STOP=1 -h "$PG_ADMIN_SOCKET" -p 5432 -d postgres -Atqc "$1"; }
VERSION=$(sql 'SHOW server_version_num')
[[ $VERSION -ge 170000 && $VERSION -lt 180000 ]] || fail 'Existing server must be PostgreSQL17.'
LISTEN=$(sql 'SHOW listen_addresses')
[[ $LISTEN =~ ^(localhost|127\.0\.0\.1|::1)(,(localhost|127\.0\.0\.1|::1))*$ ]] || fail 'PostgreSQL listens beyond loopback. Review listen_addresses manually; installer will not change existing network policy.'
[[ $(sql "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL") == 0 ]] || fail 'Existing pg_hba.conf contains errors; resolve before deployment.'
[[ $(sql "SELECT count(*) FROM pg_hba_file_rules WHERE type LIKE 'host%' AND auth_method='trust'") == 0 ]] || fail 'Existing host trust authentication could bypass passwords via another database. Review host trust rules before deploying; no global auth policy changed.'
[[ -d $SOURCE_REPO/.git ]] || fail 'Clone the repository into /opt/chunmo-source first (see deployment guide).'
[[ $(git -C "$SOURCE_REPO" branch --show-current) == feat/chunmo-project-manager ]] || fail 'Source checkout must remain on feat/chunmo-project-manager.'
[[ -z $(git -C "$SOURCE_REPO" status --porcelain) ]] || fail 'Source has uncommitted files; preserve them and resolve before deploying.'
REMOTE=$(git -C "$SOURCE_REPO" remote get-url origin)
[[ $REMOTE == https://github.com/qq850576557-debug/aaa.git || $REMOTE == git@github.com:qq850576557-debug/aaa.git ]] || fail 'Unexpected origin or embedded credentials; configure a clean authenticated remote.'
REF=HEAD
case ${1:-} in
  '') ;;
  --update) git -C "$SOURCE_REPO" fetch origin feat/chunmo-project-manager; REF=origin/feat/chunmo-project-manager ;;
  --ref) [[ ${2:-} =~ ^[a-f0-9]{40}$ ]] || fail '--ref requires a full commit hash'; REF=$2 ;;
  *) fail 'Usage: deploy.sh [--update | --ref FULL_COMMIT]' ;;
esac
COMMIT=$(git -C "$SOURCE_REPO" rev-parse "$REF^{commit}")
git -C "$SOURCE_REPO" merge-base --is-ancestor "$COMMIT" origin/feat/chunmo-project-manager || fail 'Commit is outside the feature branch history.'
[[ $(df -Pk /opt | awk 'NR==2 {print $4}') -ge 2097152 ]] || fail 'At least2GiB free space required; no automatic cleanup.'
if command -v getenforce >/dev/null && [[ $(getenforce) == Enforcing ]]; then
  fail 'SELinux is Enforcing. Review required nginx file/network policy with your administrator before deployment; installer will not disable SELinux or broadly grant network access.'
fi
if ! command -v nginx >/dev/null; then dnf -y install nginx; fi
NGINX=$(command -v nginx)
for user in chunmo-build chunmo-staging-api chunmo-staging-web; do
  if ! id "$user" >/dev/null 2>&1; then useradd --system --user-group --create-home --home-dir "/var/lib/$user" --shell /sbin/nologin "$user"; fi
  [[ $(id -u "$user") -ne 0 ]] || fail 'Service accounts must not be root.'
  [[ $(getent passwd "$user" | cut -d: -f6) == "/var/lib/$user" && $(getent passwd "$user" | cut -d: -f7) == /sbin/nologin ]] || fail 'Existing service account is not a managed non-login identity.'
  [[ $(id -G "$user" | wc -w) == 1 ]] || fail 'Service accounts must not have extra group privileges.'

  runuser -u "$user" -- "$NODE" --version >/dev/null || fail 'Node binary is not executable by service accounts (avoid /root/nvm paths).'
done
install -d -m 0755 "$BASE" "$BASE/releases"
install -d -o chunmo-build -g chunmo-build -m 0700 /var/lib/chunmo-build/jobs /var/lib/chunmo-build/cache
install -d -o root -g root -m 0700 "$BACKUPS"
RELEASE=$BASE/releases/$COMMIT
PHASE=build
prepare_build_environment() {
  local node_dir build_path build_python candidate
  node_dir=$(dirname "$(dirname "$NODE")")
  build_path="$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin"
  # Use the headers shipped with the resolved Node binary, never a remote download.
  runuser -u chunmo-build -- env -i PATH="$build_path" "$NODE" -e '
    const fs = require("node:fs"), path = require("node:path"), dir = process.argv[1];
    try {
      for (const file of ["node.h", "node_version.h", "common.gypi", "config.gypi"])
        fs.accessSync(path.join(dir, "include/node", file), fs.constants.R_OK);
      const header = fs.readFileSync(path.join(dir, "include/node/node_version.h"), "utf8");
      const actual = ["MAJOR", "MINOR", "PATCH"].map(part =>
        header.match(new RegExp("^#define\\s+NODE_" + part + "_VERSION\\s+(\\d+)", "m"))?.[1]).join(".");
      if (actual !== process.versions.node) process.exit(1);
    } catch { process.exit(1); }
  ' "$node_dir" || fail 'Build account cannot read matching local Node headers (node.h, node_version.h, common.gypi, config.gypi); install the complete matching Node distribution.'
  build_python=
  for candidate in /usr/bin/python3.11 "$(command -v python3.11 || true)" "$(command -v python3 || true)"; do
    [[ -n $candidate && -x $candidate ]] || continue
    candidate=$(readlink -f "$candidate")
    if runuser -u chunmo-build -- env -i PATH="$build_path" "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
      build_python=$candidate
      break
    fi
  done
  [[ -n $build_python ]] || fail 'Build account needs executable Python3.10+ (prefer /usr/bin/python3.11); Python3.6 is not supported.'
  BUILD_ENV=("HOME=/var/lib/chunmo-build" "PATH=$build_path" "npm_config_cache=/var/lib/chunmo-build/cache" "NODE_OPTIONS=--max-old-space-size=768"
    "PYTHON=$build_python" "npm_config_python=$build_python" "npm_config_nodedir=$node_dir")
  for key in HTTP_PROXY HTTPS_PROXY NO_PROXY NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do if [[ -n ${!key:-} ]]; then BUILD_ENV+=("$key=${!key}"); fi; done
}
if [[ -e $RELEASE ]]; then
  [[ -f $RELEASE/.verified-build && $(cat "$RELEASE/.verified-build") == "$COMMIT" ]] || fail 'Existing release is not a verified managed build.'
else
  JOB=$(mktemp -d /var/lib/chunmo-build/jobs/build.XXXXXXXX)
  git -C "$SOURCE_REPO" archive "$COMMIT" | tar -x -C "$JOB"
  chown -R chunmo-build:chunmo-build "$JOB"
  prepare_build_environment
  runuser -u chunmo-build -- env -i "${BUILD_ENV[@]}" bash -c 'set -e; cd "$1"; npm ci --ignore-scripts; npm rebuild argon2 esbuild --ignore-scripts=false --foreground-scripts; npm run verify:native; npm test; npm run build; npm run build:deploy; npm audit --omit=dev; npm prune --omit=dev --ignore-scripts; node scripts/verify-native.mjs --production' _ "$JOB"
  printf '%s\n' "$COMMIT" > "$JOB/.verified-build"
  chown -R root:root "$JOB"
  chmod -R a+rX,go-w "$JOB"
  chmod 0755 "$JOB"
  mv "$JOB" "$RELEASE"
fi
PHASE=database
"$NODE" "$RELEASE/dist-deploy/ops.mjs" config "$CONF"
"$NODE" "$RELEASE/dist-deploy/ops.mjs" cluster-input "$CONF" | runuser -u postgres -- "$NODE" "$RELEASE/dist-deploy/admin.mjs" cluster
HBA=$(sql 'SHOW hba_file')
"$NODE" "$RELEASE/dist-deploy/ops.mjs" hba "$CONF" "$HBA"
command -v restorecon >/dev/null && restorecon "$HBA" || true
[[ $(sql "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL") == 0 ]] || fail 'HBA validation failed; original copy is in protected config directory.'
sql 'SELECT pg_reload_conf()' >/dev/null
sleep 1
if [[ -L $BASE/current ]]; then
  PREVIOUS=$(readlink -e "$BASE/current")
  [[ $PREVIOUS == "$BASE/releases/"* && -f $PREVIOUS/.verified-build ]] || fail 'Current symlink is not a managed release.'
elif [[ -e $BASE/current ]]; then fail 'Current release path must be a managed symlink.'; fi
if [[ -n $PREVIOUS && $PREVIOUS != "$RELEASE" ]]; then
  (cd "$PREVIOUS" && "$NODE" dist-deploy/ops.mjs backup "$CONF" "$BACKUPS" "$DUMP")
fi
(cd "$RELEASE" && "$NODE" dist-deploy/admin.mjs migrate "$CONF" && "$NODE" dist-deploy/admin.mjs owner "$CONF")
printf 'NODE_BIN=%q\nPG_DUMP_BIN=%q\nPG_RESTORE_BIN=%q\nPG_ADMIN_SOCKET=%q\n' "$NODE" "$DUMP" "$RESTORE" "$PG_ADMIN_SOCKET" > "$CONF/tools.env"
chmod 0600 "$CONF/tools.env"
PHASE=tls
install -d -o root -g chunmo-staging-web -m 0750 "$TLS"
tls_manage_pair normal
tls_finish_permissions
PHASE=services
for unit in chunmo-staging-api chunmo-staging-web chunmo-staging-backup chunmo-staging-health; do
  if [[ -f /etc/systemd/system/$unit.service ]] && ! grep -q '^# Managed by chunmo native staging deploy' /etc/systemd/system/"$unit".service; then fail "Unmanaged unit exists: $unit"; fi
done
python3 "$RELEASE/deploy/native/render-units.py" "$NODE" "$NGINX" "$PG_UNIT"
systemd-analyze verify /etc/systemd/system/chunmo-staging-*.service /etc/systemd/system/chunmo-staging-*.timer
install -d -o chunmo-staging-web -g chunmo-staging-web -m 0700 /var/lib/chunmo-staging-web/body /var/lib/chunmo-staging-web/proxy
"$NODE" "$RELEASE/dist-deploy/ops.mjs" nginx "$BASE/current" "$TLS" /var/lib/chunmo-staging-web > "$BASE/nginx.conf.next"
chmod 0644 "$BASE/nginx.conf.next"
ln -s "$RELEASE" "$BASE/.current-next.$$"
mv -Tf "$BASE/.current-next.$$" "$BASE/current"
PROMOTED=1
mv -f "$BASE/nginx.conf.next" "$BASE/nginx.conf"
runuser -u chunmo-staging-web -- "$NGINX" -t -p /var/lib/chunmo-staging-web/ -c "$BASE/nginx.conf"
systemctl daemon-reload
systemctl enable chunmo-staging-api chunmo-staging-web
systemctl restart chunmo-staging-api chunmo-staging-web
PHASE=internal-validation
for attempt in $(seq 1 30); do if curl --silent --fail --cacert "$TLS/ca.crt" https://localhost:8443/api/health >/dev/null; then break; fi; sleep 1; done
curl --silent --show-error --fail --cacert "$TLS/ca.crt" https://localhost:8443/api/health >/dev/null
(cd "$RELEASE" && "$NODE" dist-deploy/ops.mjs smoke "$CONF" https://localhost:8443 "$TLS/ca.crt")
systemctl restart chunmo-staging-api
for attempt in $(seq 1 30); do if curl --silent --fail --cacert "$TLS/ca.crt" https://localhost:8443/api/health >/dev/null; then break; fi; sleep 1; done
(cd "$RELEASE" && "$NODE" dist-deploy/ops.mjs after-restart "$CONF" https://localhost:8443 "$TLS/ca.crt")
ARCHIVE=$(cd "$RELEASE" && "$NODE" dist-deploy/ops.mjs backup "$CONF" "$BACKUPS" "$DUMP" | sed -n 's/^Encrypted consistent database backup complete: //p')
[[ -f $ARCHIVE ]] || fail 'Backup did not produce an authenticated archive.'
(cd "$RELEASE" && "$NODE" dist-deploy/ops.mjs restore-check "$CONF" "$ARCHIVE" "$RESTORE")
systemctl enable --now chunmo-staging-backup.timer chunmo-staging-health.timer
PHASE=complete
printf 'PASS INTERNAL deployment %s. Not approved for formal launch.\n' "$COMMIT"
printf 'Owner credentials: sudo cat /etc/chunmo-staging/owner.env (do not paste into chat/logs).\n'
printf 'Public trust certificate: /opt/chunmo-staging/chunmo-staging-ca.crt\n'
openssl x509 -noout -fingerprint -sha256 -in "$TLS/ca.crt"
printf 'Windows SSH tunnel: ssh -N -L 127.0.0.1:8443:127.0.0.1:8443 YOUR_SSH_USER@YOUR_ECS_IP\nOpen https://localhost:8443 after trusting the verified public CA. No application/DB public port was opened.\n'
