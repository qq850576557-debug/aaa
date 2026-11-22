#!/usr/bin/env bash
# Upgrade the already installed owner-test site in place. Never provision a fresh cluster.
set -Eeuo pipefail
umask 077
export PATH=/usr/pgsql-17/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset PGHOST PGPORT PGSERVICE PGDATABASE PGUSER PGPASSWORD PGOPTIONS PGSSLMODE
repo=/opt/chunmo-source
conf=/etc/chunmo-owner-test
nginx=/opt/chunmo-staging/nginx.conf
unit=/etc/systemd/system/chunmo-owner-test-api.service
marker='# Managed by Chunmo owner-test installer'
test_origin=https://owner-test.chmsj.cn
base_release=bf028df2d314717c99d52ac6911c969472548135
fail() { printf '未完成：%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail '请使用 Workbench root 终端'
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || fail '已有站点更新正在运行'
for tool in awk curl git nginx pg_dump pg_restore psql python3 runuser setpriv systemctl; do
  command -v "$tool" >/dev/null || fail "缺少 $tool"
done
for file in "$nginx" "$unit" "$conf/active"; do
  [[ -f $file && ! -L $file ]] || fail "测试站配置无效 $file"
done
[[ $(head -n1 "$unit") == "$marker" ]] || fail 'API 单元不是已知测试服务'
state=$(cat "$conf/active")
[[ $state =~ ^/etc/chunmo-owner-test/install\.[a-zA-Z0-9]+$ && -d $state && ! -L $state ]] ||
  fail '找不到有效的测试站安装目录'
sql() {
  runuser -u chunmo_ownerpg -- psql -X -q -v ON_ERROR_STOP=1 -h /run/chunmo-owner-test-pg -p 5441 -d chunmo_test "$@"
}
health() {
  curl -fsS --max-time 10 "$1/api/health" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["ok"] is True
if sys.argv[1]=="test":
    assert d["environment"]=="test"
print(d["release"])
' "$2"
}
nginx_check() {
  setpriv --reuid=chunmo-staging-web --regid=chunmo-staging-web --init-groups \
    --bounding-set=-all,+net_bind_service --inh-caps=-all,+net_bind_service \
    --ambient-caps=-all,+net_bind_service --no-new-privs -- \
    "$(command -v nginx)" -t -p /var/lib/chunmo-staging-web/ -c "$1"
}
switch_unit() {
  install -m 0644 "$1" "$unit.owner-purchase-next"
  mv -f "$unit.owner-purchase-next" "$unit"
  systemctl daemon-reload
  systemctl restart chunmo-owner-test-api.service
}
switch_nginx() {
  install -m 0644 "$1" "$nginx.owner-purchase-next"
  nginx_check "$nginx.owner-purchase-next"
  mv -f "$nginx.owner-purchase-next" "$nginx"
  systemctl kill --kill-who=main --signal=HUP chunmo-staging-web
}
wait_test() {
  local release=$1
  for attempt in $(seq 1 24); do
    if [[ $(health "$test_origin" test 2>/dev/null) == "$release" ]]; then return; fi
    sleep 1
  done
  return 1
}
prod=$(health https://chmsj.cn production)
[[ $prod =~ ^[a-f0-9]{40}$ ]] || fail '无法核对正式站版本'
pointer="$conf/purchase-upgrade-active"
if [[ ${1:-} == --rollback ]]; then
  [[ -f $pointer && ! -L $pointer ]] || fail '没有已激活的采购测试升级'
  upgrade=$(cat "$pointer")
  [[ $upgrade =~ ^/etc/chunmo-owner-test/upgrade-purchases\.[a-zA-Z0-9]+$ && ! -L $upgrade ]] ||
    fail '采购升级备份路径无效'
  cmp -s "$nginx" "$upgrade/nginx.after" && cmp -s "$unit" "$upgrade/api.after" ||
    fail '测试入口或 API 单元有后续改动，保留原配置'
  restore_release() {
    local code=$1
    trap - ERR INT TERM HUP
    set +e
    switch_unit "$upgrade/api.after"
    switch_nginx "$upgrade/nginx.after"
    printf '回退未完成，已尝试重新启用采购联调配置。备份目录 %s\n' "$upgrade" >&2
    exit "$code"
  }
  trap 'restore_release "$?"' ERR
  trap 'restore_release 130' INT
  trap 'restore_release 143' TERM
  trap 'restore_release 129' HUP
  switch_unit "$upgrade/api.before"
  switch_nginx "$upgrade/nginx.before"
  wait_test "$base_release"
  [[ $(health https://chmsj.cn production) == "$prod" ]]
  mv "$pointer" "$upgrade/rolled-back"
  trap - ERR INT TERM HUP
  echo 'PASS 已回退到身份联调版，采购数据和迁移记录已保留'
  exit 0
fi

pin=${1:-}
[[ $# == 1 && $pin =~ ^[a-f0-9]{40}$ ]] || fail '请提供已审核的完整 Git SHA'
[[ ! -e $pointer && ! -L $pointer ]] || fail '已有采购升级激活'
git -C "$repo" merge-base --is-ancestor 69af2ffbc5060e1a7c32336b02d7aea6bfcb06e6 "$pin" ||
  fail '提交缺少已审核的基础版本'
[[ $(health "$test_origin" test) == "$base_release" ]] || fail '正在运行的测试站不是已知身份联调版'
cmp -s "$nginx" "$state/nginx.active" || fail '现有 Nginx 与原测试站激活快照不同'
systemctl is-active --quiet chunmo-owner-test-pg.service
systemctl is-active --quiet chunmo-owner-test-api.service
[[ $(sql -Atc "SELECT current_database() || ':' || current_user || ':' || current_setting('port')") == chunmo_test:chunmo_ownerpg:5441 ]] ||
  fail '数据库身份未通过测试环境校验'
[[ $(sql -Atc 'SELECT count(*) FROM schema_migration') == 15 ]] || fail '隔离库基础迁移数量与预期不同'
test_db_bytes=$(sql -Atc 'SELECT pg_database_size(current_database())')
[[ $test_db_bytes =~ ^[0-9]+$ ]] || fail '无法核对测试备份大小'
conf_kib=$(df -Pk "$conf" | awk 'NR==2 {print $4}')
build_kib=$(df -Pk /opt/chunmo-owner-test | awk 'NR==2 {print $4}')
[[ $conf_kib =~ ^[0-9]+$ && $build_kib =~ ^[0-9]+$ ]] || fail '无法核对剩余磁盘空间'
(( conf_kib >= test_db_bytes / 512 + 262144 && build_kib >= test_db_bytes / 512 + 2097152 )) ||
  fail '测试升级和备份所需磁盘空间不足'
python3 - "$state/runtime.env" "$unit" <<'PY'
import re, sys
from pathlib import Path
runtime, unit = map(Path, sys.argv[1:])
assert not runtime.is_symlink() and runtime.stat().st_uid == 0 and (runtime.stat().st_mode & 63)==0
text = runtime.read_text()
assert re.findall(r'^APP_ENV=(.+)$',text,re.M)==['test']
assert re.findall(r'^APP_ORIGIN=(.+)$',text,re.M)==['https://owner-test.chmsj.cn']
for name, role in [('DATABASE_URL','chunmo_app'),('PRIVATE_DATABASE_URL','chunmo_private'),
                   ('CHUNMO_OWNER_DATABASE_URL','owner_runtime')]:
    assert len(re.findall(r'^'+name+r'=postgresql://'+role+r':[0-9a-f]{48}@127\.0\.0\.1:5441/chunmo_test$',text,re.M))==1
assert re.findall(r'^EnvironmentFile=(.+)$',unit.read_text(),re.M)==[str(runtime)]
PY
upgrade=$(mktemp -d "$conf/upgrade-purchases.XXXXXXXX")
job=$(mktemp -d /opt/chunmo-owner-test/build.XXXXXXXX)
cp -p "$unit" "$upgrade/api.before"
cp -p "$nginx" "$upgrade/nginx.before"
echo "已建立测试升级目录 $upgrade"
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
[[ -n $build_python ]] || fail '需要 Python 3.10 或更高版本构建'
mkdir "$upgrade/source"
git -C "$repo" archive "$pin" deploy/owner-test deploy/apk-download/publish.py deploy/source-download/owner_preview.py deploy/source-download/publish.py server/proposed/017_owner_purchase.sql server/proposed/017_owner_purchase_grants.sql | tar -x -C "$upgrade/source"
git -C "$repo" archive "$pin" | tar -x -C "$job"
chown -R chunmo-build:chunmo-build "$job"
nice -n 10 runuser -u chunmo-build -- env -i HOME=/var/lib/chunmo-build PATH="$build_path" \
  NODE_OPTIONS=--max-old-space-size=768 npm_config_cache=/var/lib/chunmo-build/cache npm_config_fetch_retries=1 \
  PYTHON="$build_python" npm_config_python="$build_python" npm_config_nodedir="$node_home" \
  bash -c 'set -e; cd "$1"; npm ci --ignore-scripts; npm rebuild argon2 esbuild --ignore-scripts=false; npm run build' _ "$job"
chown -R root:root "$job"
chmod -R a+rX,go-w "$job"
chmod 0755 "$job"
printf '%s\n' "$pin" > "$job/.verified-build"
PYTHONDONTWRITEBYTECODE=1 python3 "$upgrade/source/deploy/owner-test/package.py" "$repo" "$job" "$job/chunmo-owner-test.zip"
chmod 0644 "$job/chunmo-owner-test.zip"
python3 - "$job" "$upgrade" <<'PY'
from pathlib import Path
import re, sys
job = sys.argv[1]
state = Path(sys.argv[2])
unit = (state/'api.before').read_text()
old, = re.findall(r'^WorkingDirectory=(/opt/chunmo-owner-test/build\.[a-zA-Z0-9]+)$',unit,re.M)
assert 'Environment=CHUNMO_OWNER_PURCHASE_ENABLED=' not in unit
unit = unit.replace('WorkingDirectory='+old,'WorkingDirectory='+job+'\nEnvironment=CHUNMO_OWNER_PURCHASE_ENABLED=1')
(state/'api.after').write_text(unit)
nginx = (state/'nginx.before').read_text()
assert nginx.count(old)==2
nginx = nginx.replace('root '+old+'/dist;','root '+job+'/dist;').replace(
    'alias '+old+'/chunmo-owner-test.zip;','alias '+job+'/chunmo-owner-test.zip;')
assert old not in nginx
(state/'nginx.after').write_text(nginx)
PY
install -m 0644 "$upgrade/nginx.after" "$nginx.owner-purchase-next"
nginx_check "$nginx.owner-purchase-next"
runuser -u chunmo_ownerpg -- pg_dump -Fc -h /run/chunmo-owner-test-pg -p 5441 -d chunmo_test > "$upgrade/chunmo_test.before.dump"
pg_restore -l "$upgrade/chunmo_test.before.dump" > "$upgrade/backup.contents"
sql_dir="$upgrade/source/server/proposed"
migration_sha=$(sha256sum "$sql_dir/017_owner_purchase.sql" | awk '{print $1}')
grants_sha=$(sha256sum "$sql_dir/017_owner_purchase_grants.sql" | awk '{print $1}')
expected=$(printf '017_owner_purchase.sql:%s\n017_owner_purchase_grants.sql:%s' "$migration_sha" "$grants_sha")
if [[ $(sql -Atc "SELECT coalesce(to_regclass('owner_portal.purchase_migration')::text,'')") ]]; then
  [[ $(sql -Atc "SELECT filename || ':' || sha256 FROM owner_portal.purchase_migration ORDER BY filename COLLATE \"C\"") == "$expected" ]] ||
    fail '采购迁移校验值与发布文件不同'
else
  migration_input="$upgrade/migration.sql"
  {
    cat "$sql_dir/017_owner_purchase.sql" "$sql_dir/017_owner_purchase_grants.sql"
    cat <<'SQL'
INSERT INTO owner_portal.purchase_migration(filename,sha256) VALUES
  ('017_owner_purchase.sql', :'migration_sha'), ('017_owner_purchase_grants.sql', :'grants_sha');
SQL
  } > "$migration_input"
  # The root shell opens the private file before runuser starts psql.
  sql --single-transaction -v staff_role=chunmo_app -v owner_role=owner_runtime \
    -v migration_sha="$migration_sha" -v grants_sha="$grants_sha" -f - < "$migration_input"
fi
[[ $(sql -Atc "SELECT has_function_privilege('owner_runtime','owner_portal.owner_purchases(text,text)','EXECUTE')
 AND NOT has_table_privilege('owner_runtime','public.purchase','SELECT')
 AND NOT has_table_privilege('owner_runtime','owner_portal.purchase_collaboration','SELECT')") == t ]] ||
  fail '独立业主权限校验失败'
cmp -s "$nginx" "$upgrade/nginx.before"
cmp -s "$unit" "$upgrade/api.before"
switched_api=0
switched_nginx=0
restore_on_error() {
  local code=$1
  trap - ERR INT TERM HUP
  set +e
  if (( switched_api )); then switch_unit "$upgrade/api.before"; fi
  if (( switched_nginx )); then switch_nginx "$upgrade/nginx.before"; fi
  if wait_test "$base_release" && [[ $(health https://chmsj.cn production) == "$prod" ]]; then
    printf '测试站已回退；测试库与备份保留在 %s\n' "$upgrade" >&2
  else
    printf '回退后需复查服务，配置备份位于 %s\n' "$upgrade" >&2
  fi
  exit "$code"
}
trap 'restore_on_error "$?"' ERR
trap 'restore_on_error 130' INT
trap 'restore_on_error 143' TERM
trap 'restore_on_error 129' HUP
switched_api=1
switch_unit "$upgrade/api.after"
wait_test "$pin"
switched_nginx=1
switch_nginx "$upgrade/nginx.after"
wait_test "$pin"
curl -fsS --max-time 10 "$test_origin/api/health" | python3 -c 'import json,sys; assert json.load(sys.stdin)["capabilities"]["ownerPurchases"] is True'
[[ $(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$test_origin/api/mini-owner/v1/projects/test/purchases") == 401 ]]
curl -fsS --max-time 20 "$test_origin/chunmo-owner-test.zip" -o "$upgrade/download.zip"
cmp "$job/chunmo-owner-test.zip" "$upgrade/download.zip"
PYTHONDONTWRITEBYTECODE=1 python3 "$upgrade/source/deploy/owner-test/smoke.py" "$state/login.txt" --upgrade
[[ $(health https://chmsj.cn production) == "$prod" ]]
printf '%s\n' "$upgrade" > "$pointer"
trap - ERR INT TERM HUP
printf 'PASS 采购联调测试站已升级，正式站版本一致\n测试提交 %s\n下载 %s/chunmo-owner-test.zip\n' "$pin" "$test_origin"
