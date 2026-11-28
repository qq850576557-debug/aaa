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
  local origin=${2:-$test_origin}
  for attempt in $(seq 1 24); do
    if [[ $(health "$origin" test 2>/dev/null) == "$release" ]]; then return 0; fi
    sleep 1
  done
  printf '版本校验超时 %s，预期 %s，实测 %s\n' "$origin" "$release" \
    "$(health "$origin" test 2>/dev/null || printf '健康检查失败')" >&2
  systemctl show chunmo-owner-test-api.service -p ActiveState -p SubState -p Result >&2 || true
  return 1
}
prod=$(health https://chmsj.cn production)
[[ $prod =~ ^[a-f0-9]{40}$ ]] || fail '无法核对正式站版本'
pointer="$conf/purchase-upgrade-active"
active_upgrade() {
  [[ -f $pointer && ! -L $pointer ]] || fail '没有有效的采购升级记录'
  local path
  path=$(cat "$pointer")
  [[ $path =~ ^/etc/chunmo-owner-test/upgrade-purchases\.[a-zA-Z0-9]+$ && -d $path && ! -L $path ]] ||
    fail '采购升级备份路径无效'
  cmp -s "$nginx" "$path/nginx.after" && cmp -s "$unit" "$path/api.after" ||
    fail '测试入口或 API 单元有后续改动，保留原配置'
  printf '%s\n' "$path"
}
write_active_upgrade() {
  local next="$conf/.purchase-active.XXXXXXXX"
  next=$(mktemp "$next")
  printf '%s\n' "$1" > "$next"
  mv -f "$next" "$pointer"
}
if [[ ${1:-} == --rollback ]]; then
  upgrade=$(active_upgrade)
  previous_release=$base_release
  previous_upgrade=
  if [[ -f $upgrade/previous-upgrade ]]; then
    previous_upgrade=$(cat "$upgrade/previous-upgrade")
    previous_release=$(cat "$upgrade/release.before")
    [[ $previous_release =~ ^[a-f0-9]{40}$ && $previous_upgrade =~ ^/etc/chunmo-owner-test/upgrade-purchases\.[a-zA-Z0-9]+$ && $previous_upgrade != "$upgrade" && -d $previous_upgrade && ! -L $previous_upgrade ]] ||
      fail '上一个测试版本的回退记录无效'
    cmp -s "$upgrade/nginx.before" "$previous_upgrade/nginx.after" && cmp -s "$upgrade/api.before" "$previous_upgrade/api.after" ||
      fail '上一个测试版本的配置与回退快照不同'
  fi
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
  wait_test "$previous_release"
  [[ $(health https://chmsj.cn production) == "$prod" ]]
  if [[ $previous_upgrade ]]; then
    write_active_upgrade "$previous_upgrade"
  else
    mv "$pointer" "$upgrade/rolled-back"
  fi
  trap - ERR INT TERM HUP
  printf 'PASS 已回退到 %s，采购数据和迁移记录已保留\n' "$previous_release"
  exit 0
fi

v21=0
if [[ ${1:-} == --v21 ]]; then v21=1; shift; fi
pin=${1:-}
[[ $# == 1 && $pin =~ ^[a-f0-9]{40}$ ]] || fail '请提供已审核的完整 Git SHA'
git -C "$repo" merge-base --is-ancestor 69af2ffbc5060e1a7c32336b02d7aea6bfcb06e6 "$pin" ||
  fail '提交缺少已审核的基础版本'
current_release=$(health "$test_origin" test) || fail '测试站健康检查失败，请先确认上次回退状态'
previous_upgrade=
if [[ -e $pointer || -L $pointer ]]; then
  previous_upgrade=$(active_upgrade)
  marker_path=$(awk -F= '$1=="WorkingDirectory" {print $2}' "$unit")
  [[ $marker_path =~ ^/opt/chunmo-owner-test/build\.[a-zA-Z0-9]+$ && $current_release =~ ^[a-f0-9]{40}$ && $current_release != "$base_release" ]] ||
    fail '测试服务的工作目录或版本无效'
  [[ $(cat "$marker_path/.verified-build") == "$current_release" ]] || fail '测试站运行版本与构建标记不一致'
  if [[ $current_release == "$pin" ]]; then
    printf 'PASS 测试站已运行 %s\n下载 %s/chunmo-owner-test.zip\n' "$pin" "$test_origin"
    exit 0
  fi
  git -C "$repo" merge-base --is-ancestor "$current_release" "$pin" || fail '新版本必须继承当前测试版本'
else
  [[ $current_release == "$base_release" ]] || fail "未知测试站版本 $current_release，已停止"
  cmp -s "$nginx" "$state/nginx.active" || fail '现有 Nginx 与原测试站激活快照不同'
fi
systemctl is-active --quiet chunmo-owner-test-pg.service
systemctl is-active --quiet chunmo-owner-test-api.service
[[ $(sql -Atc "SELECT current_database() || ':' || current_user || ':' || current_setting('port')") == chunmo_test:chunmo_ownerpg:5441 ]] ||
  fail '数据库身份未通过测试环境校验'
[[ $(sql -Atc "SELECT count(*) FROM schema_migration WHERE name NOT IN ('019_employee_wechat.sql','019_employee_wechat_grants.sql','020_owner_design.sql','020_owner_design_grants.sql','021_account_retirement.sql','022_owner_purchase_status.sql')") == 15 ]] ||
  fail '隔离库基础迁移数量与预期不同'
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
if [[ $previous_upgrade ]]; then
  printf '%s\n' "$previous_upgrade" > "$upgrade/previous-upgrade"
  printf '%s\n' "$current_release" > "$upgrade/release.before"
fi
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
git -C "$repo" archive "$pin" deploy/owner-test deploy/apk-download/publish.py deploy/source-download/owner_preview.py deploy/source-download/publish.py \
  server/proposed/017_owner_purchase.sql server/proposed/017_owner_purchase_grants.sql \
  server/proposed/018_owner_purchase_evidence.sql server/proposed/018_owner_purchase_evidence_grants.sql | tar -x -C "$upgrade/source"
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
chmod 0644 "$job/.verified-build"
[[ $(runuser -u chunmo_ownerap -- cat "$job/.verified-build") == "$pin" ]] ||
  fail '测试 API 账号无法读取发布版本标记'
if (( v21 )); then
  test_app_id=$(python3 - "$state/runtime.env" <<'PY'
import re,sys
from pathlib import Path
app_ids=re.findall(r'^CHUNMO_OWNER_WECHAT_APP_ID=(wx[a-f0-9]{16})$', Path(sys.argv[1]).read_text(), re.M)
assert len(app_ids)==1
print(app_ids[0])
PY
)
  "$build_python" -B "$job/deploy/owner-release/package-v21.py" --repo "$repo" --sha "$pin" \
    --test-app-id "$test_app_id" --output "$job/chunmo-owner-test.zip"
else
  PYTHONDONTWRITEBYTECODE=1 python3 "$upgrade/source/deploy/owner-test/package.py" "$repo" "$job" "$job/chunmo-owner-test.zip"
fi
chmod 0644 "$job/chunmo-owner-test.zip"
python3 - "$job" "$upgrade" "$v21" <<'PY'
from pathlib import Path
import re, sys
job = sys.argv[1]
state = Path(sys.argv[2])
unit = (state/'api.before').read_text()
old, = re.findall(r'^WorkingDirectory=(/opt/chunmo-owner-test/build\.[a-zA-Z0-9]+)$',unit,re.M)
flag = 'Environment=CHUNMO_OWNER_PURCHASE_ENABLED=1'
assert re.findall(r'^Environment=CHUNMO_OWNER_PURCHASE_ENABLED=.*$',unit,re.M) in ([], [flag])
unit = unit.replace('WorkingDirectory='+old, 'WorkingDirectory='+job + ('' if flag in unit else '\n'+flag))
if sys.argv[3] == '1':
    for key in ('CHUNMO_MINI_UNIFIED_ENABLED','CHUNMO_OWNER_DESIGN_ENABLED'):
        flag = 'Environment='+key+'=1'
        assert re.findall(r'^Environment='+key+r'=.*$',unit,re.M) in ([], [flag])
        if flag not in unit:
            unit = unit.replace('WorkingDirectory='+job,'WorkingDirectory='+job+'\n'+flag)
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
evidence_sha=$(sha256sum "$sql_dir/018_owner_purchase_evidence.sql" | awk '{print $1}')
evidence_grants_sha=$(sha256sum "$sql_dir/018_owner_purchase_evidence_grants.sql" | awk '{print $1}')
expected_evidence=$(printf '%s\n018_owner_purchase_evidence.sql:%s\n018_owner_purchase_evidence_grants.sql:%s' \
  "$expected" "$evidence_sha" "$evidence_grants_sha")
ledger() {
  sql -Atc "SELECT filename || ':' || sha256 FROM owner_portal.purchase_migration ORDER BY filename COLLATE \"C\""
}
if [[ $(sql -Atc "SELECT coalesce(to_regclass('owner_portal.purchase_migration')::text,'')") ]]; then
  installed=$(ledger)
  [[ $installed == "$expected" || $installed == "$expected_evidence" ]] ||
    fail '采购迁移校验值与发布文件不同'
else
  [[ ! $previous_upgrade ]] || fail '当前版本缺少采购迁移记录，已停止'
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
if [[ $(ledger) == "$expected" ]]; then
  {
    printf "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';\n"
    cat "$sql_dir/018_owner_purchase_evidence.sql" "$sql_dir/018_owner_purchase_evidence_grants.sql"
    cat <<'SQL'
INSERT INTO owner_portal.purchase_migration(filename,sha256) VALUES
  ('018_owner_purchase_evidence.sql', :'migration_sha'),
  ('018_owner_purchase_evidence_grants.sql', :'grants_sha');
SQL
  } | sql --single-transaction -v staff_role=chunmo_app -v owner_role=owner_runtime \
    -v backup_role=chunmo_ownerpg -v migration_sha="$evidence_sha" -v grants_sha="$evidence_grants_sha" -f -
fi
[[ $(ledger) == "$expected_evidence" ]] || fail '测试库 018 校验值不一致'
[[ $(sql -Atc "SELECT has_function_privilege('owner_runtime','owner_portal.owner_purchases(text,text)','EXECUTE')
 AND has_function_privilege('owner_runtime','owner_portal.owner_purchase_photo(text,text,text,text)','EXECUTE')
 AND NOT has_table_privilege('owner_runtime','owner_portal.purchase_feedback_photo','SELECT')
 AND NOT has_table_privilege('owner_runtime','public.purchase','SELECT')
 AND NOT has_table_privilege('owner_runtime','owner_portal.purchase_collaboration','SELECT')") == t ]] ||
  fail '独立业主权限校验失败'
if (( v21 )); then
  staff_sql="$job/server/proposed/019_employee_wechat.sql"
  staff_grants="$job/server/proposed/019_employee_wechat_grants.sql"
  staff_sha=$(sha256sum "$staff_sql" | awk '{print $1}')
  staff_grants_sha=$(sha256sum "$staff_grants" | awk '{print $1}')
  staff_expected=$(printf '019_employee_wechat.sql:%s\n019_employee_wechat_grants.sql:%s' "$staff_sha" "$staff_grants_sha")
  staff_ledger() { sql -Atc "SELECT name || ':' || checksum FROM schema_migration WHERE name LIKE '019_%' ORDER BY name"; }
  installed_staff=$(staff_ledger)
  [[ ! $installed_staff || $installed_staff == "$staff_expected" ]] ||
    fail '测试库 019 账本不完整或校验值不一致'
  if [[ ! $installed_staff ]]; then
    {
      printf "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(62109684);\n"
      cat "$staff_sql" "$staff_grants"
      cat <<'SQL'
INSERT INTO schema_migration(name,checksum) VALUES
  ('019_employee_wechat.sql', :'staff_sha'),('019_employee_wechat_grants.sql', :'staff_grants_sha');
SQL
    } | sql --single-transaction -v staff_role=chunmo_app -v staff_sha="$staff_sha" -v staff_grants_sha="$staff_grants_sha" -f -
  fi
  [[ $(staff_ledger) == "$staff_expected" ]] || fail '测试库 019 校验值不一致'
  [[ $(sql -Atc "SELECT has_table_privilege('chunmo_app','public.employee_wechat_binding','SELECT') AND NOT has_table_privilege('owner_runtime','public.employee_wechat_binding','SELECT')") == t ]] ||
    fail '测试库 019 角色隔离校验失败'
  design_sql="$job/server/proposed/020_owner_design.sql"
  design_grants="$job/server/proposed/020_owner_design_grants.sql"
  design_sha=$(sha256sum "$design_sql" | awk '{print $1}')
  design_grants_sha=$(sha256sum "$design_grants" | awk '{print $1}')
  design_expected=$(printf '020_owner_design.sql:%s\n020_owner_design_grants.sql:%s' "$design_sha" "$design_grants_sha")
  design_ledger() { sql -Atc "SELECT name || ':' || checksum FROM schema_migration WHERE name LIKE '020_%' ORDER BY name"; }
  installed_design=$(design_ledger)
  [[ ! $installed_design || $installed_design == "$design_expected" ]] ||
    fail '测试库 020 账本不完整或校验值不一致'
  if [[ ! $installed_design ]]; then
    {
      printf "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(62109684);\n"
      cat "$design_sql" "$design_grants"
      cat <<'SQL'
INSERT INTO schema_migration(name,checksum) VALUES
  ('020_owner_design.sql', :'design_sha'), ('020_owner_design_grants.sql', :'design_grants_sha');
SQL
    } | sql --single-transaction -v staff_role=chunmo_app -v owner_role=owner_runtime \
      -v design_sha="$design_sha" -v design_grants_sha="$design_grants_sha" -f -
  fi
  [[ $(design_ledger) == "$design_expected" ]] || fail '测试库 020 校验值不一致'
  [[ $(sql -Atc "SELECT has_table_privilege('chunmo_app','owner_portal.project_design','SELECT')
    AND has_table_privilege('chunmo_app','owner_portal.project_design','INSERT')
    AND has_table_privilege('chunmo_app','owner_portal.project_design','UPDATE')
    AND NOT has_table_privilege('owner_runtime','owner_portal.project_design','SELECT,INSERT,UPDATE,DELETE')
    AND has_function_privilege('owner_runtime','owner_portal.authorized_design(text,text)','EXECUTE')") == t ]] ||
    fail '测试库 020 角色隔离校验失败'
  retirement_sql="$job/server/proposed/021_account_retirement.sql"
  if [[ -f $retirement_sql ]]; then
    retirement_sha=598a3af4f31670f55358755c441e4036273ca57f0bff1148b00a0fd45ac973ea
    [[ $(sha256sum "$retirement_sql" | awk '{print $1}') == "$retirement_sha" ]] ||
      fail '测试库 021 迁移文件校验失败'
    retirement_ledger() {
      sql -Atc "SELECT checksum FROM schema_migration WHERE name='021_account_retirement.sql'"
    }
    [[ ! $(retirement_ledger) || $(retirement_ledger) == "$retirement_sha" ]] ||
      fail '测试库 021 账本校验失败'
    if [[ -z $(retirement_ledger) ]]; then
      {
        printf "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(62109684);
"
        cat "$retirement_sql"
        cat <<'SQL'
INSERT INTO schema_migration(name,checksum) VALUES('021_account_retirement.sql', :'retirement_sha');
SQL
      } | sql --single-transaction -v retirement_sha="$retirement_sha" -f -
    fi
    [[ $(retirement_ledger) == "$retirement_sha" ]] ||
      fail '测试库 021 迁移登记失败'
    [[ $(sql -Atc "SELECT
      (SELECT count(*) FROM pg_constraint WHERE conname IN ('retired_employee_inactive','retired_owner_unbound'))=2
      AND position('deleted_at IS NULL' in pg_get_viewdef('owner_portal.available_project'::regclass,true))>0
      AND NOT has_column_privilege('owner_runtime','owner_portal.member','deleted_at','UPDATE')") == t ]] ||
      fail '测试库 021 结构或权限隔离检查失败'
  fi
  status_sql="$job/server/proposed/022_owner_purchase_status.sql"
  if [[ -f $status_sql ]]; then
    status_sha=46e30049d32246456dce864fdc72174e19b08fd9b908691506ed9ee411b6fc23
    [[ $(sha256sum "$status_sql" | awk '{print $1}') == "$status_sha" ]] ||
      fail '测试库 022 迁移文件校验失败'
    status_ledger() {
      sql -Atc "SELECT checksum FROM schema_migration WHERE name='022_owner_purchase_status.sql'"
    }
    installed_status=$(status_ledger)
    if [[ -z $installed_status ]]; then
      {
        printf "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(62109684);\n"
        cat "$status_sql"
        printf "INSERT INTO schema_migration(name,checksum) VALUES('022_owner_purchase_status.sql', :'status_sha');\n"
      } | sql --single-transaction -v status_sha="$status_sha" -f -
    fi
    [[ $(status_ledger) == "$status_sha" ]] || fail '测试库 022 账本校验失败'
    [[ $(sql -Atc "SELECT has_function_privilege('owner_runtime','owner_portal.owner_purchase_feedback(text,text,text,uuid,text,text,jsonb)','EXECUTE')
      AND NOT has_table_privilege('owner_runtime','public.workspace_state','SELECT,UPDATE')
      AND NOT has_table_privilege('owner_runtime','public.purchase','SELECT,UPDATE')
      AND position('chunmo_updates' in pg_get_functiondef('owner_portal.owner_purchase_feedback(text,text,text,uuid,text,text,jsonb)'::regprocedure))>0") == t ]] ||
      fail '测试库 022 状态写入或业主权限校验失败'
  fi
fi
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
  if wait_test "$current_release" && [[ $(health https://chmsj.cn production) == "$prod" ]]; then
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
wait_test "$pin" http://127.0.0.1:4410
switched_nginx=1
switch_nginx "$upgrade/nginx.after"
wait_test "$pin"
curl -fsS --max-time 10 "$test_origin/api/health" | python3 -c 'import json,sys; assert json.load(sys.stdin)["capabilities"]["ownerPurchases"] is True'
if (( v21 )); then
  [[ $(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{}' "$test_origin/api/mini-login/v1/discover") == 403 ]]
  [[ $(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$test_origin/api/mini-photo-candidate/workbench/workspace") == 403 ]]
  [[ $(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$test_origin/api/mini-owner/v1/projects/test/design") == 401 ]]
fi
[[ $(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$test_origin/api/mini-owner/v1/projects/test/purchases") == 401 ]]
curl -fsS --max-time 20 "$test_origin/chunmo-owner-test.zip" -o "$upgrade/download.zip"
cmp "$job/chunmo-owner-test.zip" "$upgrade/download.zip"
smoke_flags=(--upgrade)
if (( v21 )); then smoke_flags+=(--design); fi
PYTHONDONTWRITEBYTECODE=1 python3 "$upgrade/source/deploy/owner-test/smoke.py" "$state/login.txt" "${smoke_flags[@]}"
[[ $(health https://chmsj.cn production) == "$prod" ]]
write_active_upgrade "$upgrade"
trap - ERR INT TERM HUP
printf 'PASS 采购联调测试站已升级，正式站版本一致\n测试提交 %s\n下载 %s/chunmo-owner-test.zip\n' "$pin" "$test_origin"
