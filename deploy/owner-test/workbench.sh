#!/usr/bin/env bash
# Dedicated owner test on the existing ECS. No production deployment scripts.
set -Eeuo pipefail
umask 077
export PATH=/usr/pgsql-17/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset PGHOST PGPORT PGSERVICE PGDATABASE PGUSER PGPASSWORD PGOPTIONS PGSSLMODE
tools=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=/opt/chunmo-source
pin=bf028df2d314717c99d52ac6911c969472548135
host=owner-test.chmsj.cn
app_id=wxb48a7abb3858a252
base=/opt/chunmo-owner-test
conf=/etc/chunmo-owner-test
nginx_config=/opt/chunmo-staging/nginx.conf
pgunit=chunmo-owner-test-pg.service
apiunit=chunmo-owner-test-api.service
marker='# Managed by Chunmo owner-test installer'
fail() { printf '未完成：%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail '请使用 Workbench root 终端'
for tool in awk curl flock nginx python3 setpriv systemctl; do
  command -v "$tool" >/dev/null || fail "缺少预检工具 $tool"
done
nginx_bin=$(command -v nginx)
[[ $nginx_bin == /* && -x $nginx_bin ]] || fail 'Nginx 可执行文件路径无效'
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || fail '已有站点更新或备份正在运行，请稍后重试'
[[ -f $nginx_config && ! -L $nginx_config ]] || fail '未找到受管理的正式站 Nginx 配置'

nginx_check() {
  setpriv --reuid=chunmo-staging-web --regid=chunmo-staging-web --init-groups \
    --bounding-set=-all,+net_bind_service --inh-caps=-all,+net_bind_service \
    --ambient-caps=-all,+net_bind_service --no-new-privs -- \
    "$nginx_bin" -t -p /var/lib/chunmo-staging-web/ -c "$1"
}
reload_web() {
  systemctl kill --kill-who=main --signal=HUP chunmo-staging-web
}
prod_health() {
  curl -fsS --max-time 12 --resolve chmsj.cn:443:127.0.0.1 https://chmsj.cn/api/health |
    python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] is True; print(d["release"])'
}
case ${1:-} in
  --rollback)
    [[ -f $conf/active ]] || fail '没有已激活的测试站'
    state=$(cat "$conf/active")
    [[ $state =~ ^/etc/chunmo-owner-test/install\.[a-zA-Z0-9]+$ ]] || fail '测试回退状态无效'
    if cmp -s "$state/nginx.active" "$nginx_config"; then
      install -m 0644 "$state/nginx.before" "$nginx_config.owner-next"
      nginx_check "$nginx_config.owner-next"
      mv -f "$nginx_config.owner-next" "$nginx_config"
      if ! reload_web; then
        install -m 0644 "$state/nginx.active" "$nginx_config.owner-next"
        mv -f "$nginx_config.owner-next" "$nginx_config"
        reload_web || true
        fail '回退重载未完成，配置备份已保留'
      fi
    elif ! cmp -s "$state/nginx.before" "$nginx_config"; then
      fail 'Nginx 已有其他改动，为避免覆盖，请先核对备份'
    fi
    prod_health >/dev/null
    systemctl stop "$apiunit" "$pgunit"
    systemctl disable "$apiunit" "$pgunit" >/dev/null
    mv "$conf/active" "$state/rolled-back"
    echo 'PASS 已移除测试域名接入并停止测试服务，正式站健康，测试数据保留'
    exit 0
    ;;
  --install) ;;
  *) fail '请指定 --install 或 --rollback' ;;
esac
[[ ! -e $conf/active ]] || fail '测试环境已安装'
git -C "$repo" cat-file -e "$pin^{commit}" || fail '未取得固定测试源码提交'
if command -v getenforce >/dev/null && [[ $(getenforce) == Enforcing ]]; then
  fail '当前 SELinux 为 Enforcing，需核对测试路径策略'
fi
for unit in "$pgunit" "$apiunit"; do
  if systemctl is-active --quiet "$unit"; then fail "独立测试单元已经运行 $unit"; fi
  file=/etc/systemd/system/$unit
  [[ ! -L $file && ( ! -e $file || $(head -n1 "$file") == "$marker" ) ]] || fail '检测到非本工具管理的同名服务'
done
check_test_ports() {
  local listeners busy
  command -v ss >/dev/null || fail '缺少端口检查工具 ss'
  listeners=$(ss -H -ltn) || fail '无法读取监听端口，安装停止'
  busy=$(awk '$4 ~ /:(4410|5441)$/ {print $4}' <<< "$listeners")
  [[ -z $busy ]] || fail "测试端口已被占用 $busy"
}
check_test_ports
[[ $(df -Pk /opt | awk 'NR==2 {print $4}') -ge 2097152 ]] || fail '/opt 需要至少 2GiB 可用空间'
cert=$conf/letsencrypt/live/$host
openssl verify -purpose sslserver -verify_hostname "$host" -untrusted "$cert/chain.pem" "$cert/cert.pem" >/dev/null
openssl x509 -checkend 86400 -in "$cert/cert.pem" -noout >/dev/null
cert_key=$(openssl x509 -in "$cert/cert.pem" -pubkey -noout | openssl dgst -sha256)
test_key=$(openssl pkey -in "$cert/privkey.pem" -pubout | openssl dgst -sha256)
[[ $cert_key == "$test_key" ]] || fail '测试证书与私钥不匹配'
[[ -r /etc/chunmo-staging/tools.env ]] || fail '未找到现有受管 Node 路径'
# This root-owned deployment file holds executable paths, not runtime secrets.
source /etc/chunmo-staging/tools.env
[[ ${NODE_BIN:-} =~ ^/[a-zA-Z0-9/._-]+$ && -x $NODE_BIN ]] || fail 'Node 路径不可用'
node_home=$(dirname "$(dirname "$NODE_BIN")")
build_path="$(dirname "$NODE_BIN"):$PATH"
build_python=
for candidate in /usr/bin/python3.11 /usr/bin/python3; do
  if [[ -x $candidate ]] && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3,10))'; then
    build_python=$candidate
    break
  fi
done
[[ -n $build_python ]] || fail '缺少原部署所需的 Python 3.10+ 构建工具'
for pg in initdb postgres psql; do command -v "$pg" >/dev/null || fail "缺少 PostgreSQL17 工具 $pg"; done
postgres --version | grep -q '17\.' || fail '需要 PostgreSQL17'
web_start=$(systemctl show --property=ExecStart --value chunmo-staging-web)
[[ $web_start == *"$nginx_config"* && $web_start == *'/var/lib/chunmo-staging-web/'* ]] ||
  fail '正式 Nginx 正在使用其他路径'
nginx_check "$nginx_config"
before=$(prod_health)
[[ $before =~ ^[a-f0-9]{40}$ ]] || fail '无法核对正在运行的正式站 SHA'
id chunmo-build >/dev/null || fail '缺少原构建账号'
for pair in chunmo_ownerpg chunmo_ownerap; do
  if ! id "$pair" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /var/lib/chunmo-owner-test --shell /sbin/nologin "$pair"
  fi
  passwd=$(getent passwd "$pair")
  [[ $(id -u "$pair") -ne 0 && $passwd == *:/var/lib/chunmo-owner-test:/sbin/nologin && $(id -G "$pair" | wc -w) == 1 ]] ||
    fail '同名测试服务账号不是预期的专用账号'
done

install -d -m 0755 "$base" /var/lib/chunmo-owner-test
state=$(mktemp -d "$conf/install.XXXXXXXX")
job=$(mktemp -d "$base/build.XXXXXXXX")
pgdata=/var/lib/chunmo-owner-test/pg.${state##*.}
tls=/etc/pki/chunmo-owner-test/${state##*.}
cp -p "$nginx_config" "$state/nginx.before"
echo "配置备份 $state"
activated=0
started=0
rollback_on_error() {
  local code=${1:-$?}
  trap - ERR HUP INT TERM
  set +e
  if (( activated )); then
    if cmp -s "$state/nginx.active" "$nginx_config"; then
      install -m 0644 "$state/nginx.before" "$nginx_config.owner-next" &&
        mv -f "$nginx_config.owner-next" "$nginx_config" &&
        nginx_check "$nginx_config" && reload_web && prod_health >/dev/null ||
        echo "正式站回滚未完全验证，备份 $state" >&2
    else
      echo "Nginx 已有其他改动，自动回滚跳过，备份 $state" >&2
    fi
  fi
  if (( started )); then
    if [[ -n ${admin:-} ]] && declare -F sql >/dev/null; then
      sql -d postgres -c 'ALTER ROLE chunmo_ownerpg PASSWORD NULL' >/dev/null 2>&1
    fi
    systemctl stop "$apiunit" "$pgunit"
    systemctl disable "$apiunit" "$pgunit" >/dev/null 2>&1
  fi
  printf '未安装完成，阶段 %s，备份 %s\n' "$phase" "$state" >&2
  exit "$code"
}
trap 'rollback_on_error "$?"' ERR
trap 'rollback_on_error 129' HUP
trap 'rollback_on_error 130' INT
trap 'rollback_on_error 143' TERM

phase=build
echo '正在独立构建测试包'
git -C "$repo" archive "$pin" | tar -x -C "$job"
install -d -m 0755 "$job/deploy/owner-test"
install -m 0644 "$tools/seed.ts" "$job/deploy/owner-test/seed.ts"
chown -R chunmo-build:chunmo-build "$job"
nice -n 10 runuser -u chunmo-build -- env -i HOME=/var/lib/chunmo-build PATH="$build_path" \
  NODE_OPTIONS=--max-old-space-size=768 npm_config_cache=/var/lib/chunmo-build/cache npm_config_fetch_retries=1 \
  PYTHON="$build_python" npm_config_python="$build_python" npm_config_nodedir="$node_home" \
  bash -c 'set -e; cd "$1"; npm ci --ignore-scripts; npm rebuild argon2 esbuild --ignore-scripts=false; npm run build' _ "$job"
printf '%s\n' "$pin" > "$job/.verified-build"
PYTHONDONTWRITEBYTECODE=1 python3 "$tools/package.py" "$repo" "$job" "$job/chunmo-owner-test.zip"
chown -R root:root "$job"
chmod -R a+rX,go-w "$job"
chmod 0755 "$job"

phase=db
echo '正在初始化独立 PostgreSQL 5441'
install -d -o chunmo_ownerpg -g chunmo_ownerpg -m 0700 "$pgdata"
runuser -u chunmo_ownerpg -- initdb -D "$pgdata" --username=chunmo_ownerpg --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --no-locale > "$state/initdb.log"
cat > "/etc/systemd/system/$pgunit" <<UNIT
$marker
[Unit]
Description=Chunmo owner test isolated PostgreSQL
After=network.target
[Service]
User=chunmo_ownerpg
Group=chunmo_ownerpg
RuntimeDirectory=chunmo-owner-test-pg
RuntimeDirectoryMode=0700
ExecStart=$(command -v postgres) -D $pgdata -h 127.0.0.1 -p 5441 -k /run/chunmo-owner-test-pg -c shared_buffers=32MB -c max_connections=24
ProtectSystem=strict
ReadWritePaths=$pgdata /run/chunmo-owner-test-pg
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
started=1
systemctl start "$pgunit"
sql() {
  runuser -u chunmo_ownerpg -- psql -X -q -v ON_ERROR_STOP=1 -h /run/chunmo-owner-test-pg -p 5441 "$@"
}
for attempt in $(seq 1 30); do
  if sql -d postgres -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
sql -d postgres -Atc 'SELECT 1' >/dev/null
admin=$(openssl rand -hex 24)
runtime=$(openssl rand -hex 24)
site=$(openssl rand -hex 24)
private=$(openssl rand -hex 24)
admin_password=$(openssl rand -hex 16)
sql -d postgres <<SQL
CREATE DATABASE chunmo_test;
ALTER ROLE chunmo_ownerpg PASSWORD '$admin';
CREATE ROLE chunmo_app LOGIN NOINHERIT PASSWORD '$site';
CREATE ROLE chunmo_private LOGIN NOINHERIT PASSWORD '$private';
CREATE ROLE owner_runtime LOGIN NOINHERIT PASSWORD '$runtime';
SQL
migration=postgresql://chunmo_ownerpg:$admin@127.0.0.1:5441/chunmo_test
: > "$job/.env.test.local"
(cd "$job"; env -i PATH="$build_path" MIGRATION_DATABASE_URL="$migration" "$NODE_BIN" --import tsx scripts/cloud-provision.ts test)
rm -- "$job/.env.test.local"
sql -d chunmo_test --single-transaction -f "$job/server/proposed/016_owner_identity.sql" \
  -v staff_role=chunmo_app -v owner_role=owner_runtime -f "$job/server/proposed/016_owner_identity_grants.sql"

phase=runtime
{
  printf 'APP_ENV=test\nAPP_ORIGIN=https://%s\nAPI_PORT=4410\n' "$host"
  printf 'DATABASE_URL=postgresql://chunmo_app:%s@127.0.0.1:5441/chunmo_test\n' "$site"
  printf 'PRIVATE_DATABASE_URL=postgresql://chunmo_private:%s@127.0.0.1:5441/chunmo_test\n' "$private"
  printf 'CHUNMO_OWNER_DATABASE_URL=postgresql://owner_runtime:%s@127.0.0.1:5441/chunmo_test\n' "$runtime"
  printf 'PRIVATE_DATA_KEY=%s\nCHUNMO_OWNER_DATA_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)"
  printf 'CHUNMO_OWNER_PORTAL_ENABLED=1\nCHUNMO_OWNER_WECHAT_APP_ID=%s\n' "$app_id"
  # Reuse only the existing AppID's secret, on the server, without sourcing or displaying it.
  python3 - "$app_id" <<'PY'
from pathlib import Path
import re
import sys
text = Path('/etc/chunmo-mini-photo.env').read_text()
app = re.findall(r'^CHUNMO_MINI_APP_ID=(wx[a-fA-F0-9]{16})$', text, re.M)
secret = re.findall(r'^CHUNMO_MINI_APP_SECRET=([a-fA-F0-9]{32})$', text, re.M)
if app != [sys.argv[1]] or len(secret) != 1:
    raise SystemExit('员工端已存微信配置与本次联调 AppID 不匹配')
print('CHUNMO_OWNER_WECHAT_APP_SECRET=' + secret[0])
PY
} > "$state/runtime.env"
(
  cd "$job"
  env -i PATH="$build_path" MIGRATION_DATABASE_URL="$migration" OWNER_PASSWORD="$admin_password" \
    "$NODE_BIN" --env-file="$state/runtime.env" --import tsx deploy/owner-test/seed.ts
)
sql -d postgres -c 'ALTER ROLE chunmo_ownerpg PASSWORD NULL'
unset admin migration site private runtime
printf '测试网址 https://%s\n测试账号 owner-test-admin\n测试密码 %s\n' "$host" "$admin_password" > "$state/login.txt"
unset admin_password
cat > "/etc/systemd/system/$apiunit" <<UNIT
$marker
[Unit]
Description=Chunmo owner test API
Requires=$pgunit
After=$pgunit
[Service]
User=chunmo_ownerap
Group=chunmo_ownerap
WorkingDirectory=$job
EnvironmentFile=$state/runtime.env
ExecStart=$NODE_BIN --max-old-space-size=384 dist-api/server.mjs
Restart=on-failure
RestartSec=4
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl start "$apiunit"
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:4410/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:4410/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["environment"]=="test"'

phase=nginx
install -d -o root -g chunmo-staging-web -m 0750 /etc/pki/chunmo-owner-test "$tls"
install -o root -g chunmo-staging-web -m 0640 "$cert/fullchain.pem" "$tls/fullchain.pem"
install -o root -g chunmo-staging-web -m 0640 "$cert/privkey.pem" "$tls/server.key"
candidate=/opt/chunmo-staging/.nginx.owner-test.${state##*.}.conf
PYTHONDONTWRITEBYTECODE=1 python3 "$tools/nginx-route.py" "$state/nginx.before" "$job" "$tls" > "$candidate"
chmod 0644 "$candidate"
cp "$candidate" "$state/nginx.active"
nginx_check "$candidate"
cmp -s "$state/nginx.before" "$nginx_config"
mv "$candidate" "$nginx_config"
activated=1
reload_web

phase=verify
check_test() {
  local origin=$1
  shift
  curl -fsS --max-time 10 "$@" "$origin/api/health" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["environment"]=="test" and d["release"]==sys.argv[1]' "$pin"
  local result
  result=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$@" "$origin/api/mini-owner/v1/projects")
  [[ $result == 401 ]]
}
for attempt in $(seq 1 12); do
  if check_test "https://$host" --resolve "$host:443:127.0.0.1" 2>/dev/null; then break; fi
  sleep 1
done
check_test "https://$host" --resolve "$host:443:127.0.0.1"
check_test "https://$host"
curl -fsS --max-time 20 "https://$host/chunmo-owner-test.zip" -o "$state/download.zip"
cmp "$state/download.zip" "$job/chunmo-owner-test.zip"
python3 "$tools/smoke.py" "$state/login.txt"
[[ $(prod_health) == "$before" ]]
curl -fsS --max-time 12 https://chmsj.cn/api/health |
  python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["release"]==sys.argv[1]' "$before"
systemctl enable "$pgunit" "$apiunit" >/dev/null
printf '%s\n' "$state" > "$conf/active"
trap - ERR HUP INT TERM
printf 'PASS 测试 HTTPS、授权拒绝、ZIP 与正式站版本已核验\n测试站 https://%s\n测试工程 https://%s/chunmo-owner-test.zip\n测试账号密码仅在服务器 %s/login.txt\n' "$host" "$host" "$state"
