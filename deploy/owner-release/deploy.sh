#!/usr/bin/env bash
# Promote a pinned release on the existing managed host.
set -Eeuo pipefail
umask 077
export PATH="/usr/pgsql-17/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

base=/opt/chunmo-staging
conf=/etc/chunmo-staging
backups=/var/backups/chunmo-staging
previous=04d1e6352e18d0861cc3e0bca2edc9ec3e122a7c
restore_database=chunmo_restorecheck_20261123075542_188a4d8d
repo=/opt/chunmo-source
mode=${1:-}
commit=${2:-}
studio_duty=0
owner_018=0
mini_monthly=0
v21=0
v21_pc=0
case $mode in
  --deploy-studio-duty|--rollback-studio-duty)
    studio_duty=1
    previous=0741da22e288b632fa3d1651903a09c0b97b4b9d
    mode=${mode%-studio-duty}
    ;;
  --deploy-owner-018|--rollback-owner-018)
    owner_018=1
    previous=8f241b577c4c60f70b06509257f4d43836ab61e0
    mode=${mode%-owner-018}
    ;;
  --deploy-mini-monthly|--rollback-mini-monthly)
    owner_018=1
    mini_monthly=1
    previous=4a6ff34497c67bed7bd71e2e89f4ac6339be1cff
    mode=${mode%-mini-monthly}
    ;;
  --deploy-v21|--rollback-v21)
    v21=1
    owner_018=1
    previous=8bbd1e818981d9d405dfbac8bc9a581768b648af
    mode=${mode%-v21}
    ;;
  --deploy-v21-pc|--rollback-v21-pc)
    v21=1
    v21_pc=1
    owner_018=1
    previous=53dad25c7161e2af33c008c89ee8fb8cd53902e9
    mode=${mode%-v21-pc}
    ;;
esac
phase=host
promoted=0
job=
sql_source=
owner_enabled=0
launch_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
units=(chunmo-staging-web chunmo-staging-api chunmo-mini-photo chunmo-mini-workbench)

fail() { printf 'FAIL %s — %s\n' "$phase" "$*" >&2; exit 1; }
[[ $# == 2 && ( $mode == --deploy || $mode == --rollback ) && $commit =~ ^[a-f0-9]{40}$ &&
    $commit != "$previous" ]] || fail '请使用已审核的发布入口和完整提交。'
[[ $EUID == 0 ]] || fail '请在 Workbench 的 root 终端执行。'
if [[ $v21_pc == 1 ]]; then
  [[ $commit == b696aab3e28299eb69fd134391dec8b5278d9e1c ]] || fail '本次正式网页升级仅允许固定候选 b696aab。'
elif [[ $v21 == 1 ]]; then
  [[ $commit == 53dad25c7161e2af33c008c89ee8fb8cd53902e9 ]] || fail 'V2.1 只能发布已验收的固定候选。'
fi
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || fail '已有部署或备份操作在运行。'
old="$base/releases/$previous"
new="$base/releases/$commit"
[[ -L $base/current && -d $old && -r $old/.verified-build && $(<"$old/.verified-build") == "$previous" ]] ||
  fail '找不到已核验的旧版本。'
source "$conf/tools.env"
export PG_ADMIN_SOCKET
[[ $NODE_BIN == /* && -x $NODE_BIN &&
  ( ( $v21_pc == 1 && $mode == --rollback ) || -S $PG_ADMIN_SOCKET/.s.PGSQL.5432 ) ]] ||
  fail '当前 Node 或 PostgreSQL 工具路径不符合预检。'
export PATH="$(dirname -- "$NODE_BIN"):$PATH"
python3 -I -B - "$conf" "$v21" <<'PY'
import json, sys
from pathlib import Path
from urllib.parse import urlsplit

root = Path(sys.argv[1])
cfg = json.loads((root / 'control.json').read_text())
assert (cfg['db'], cfg['host'], cfg['port']) == ('chunmo_staging', '127.0.0.1', 5432)
for role in ('migrator', 'app', 'backup'):
    assert cfg['roles'][role]['name'] == 'cm_stg_' + role
runtime = dict(line.split('=', 1) for line in (root / 'runtime.env').read_text().splitlines()
               if '=' in line and not line.lstrip().startswith('#'))
db = urlsplit(runtime['DATABASE_URL'])
assert (db.username, db.hostname, db.port, db.path) == ('cm_stg_app', '127.0.0.1', 5432, '/chunmo_staging')
assert runtime['APP_ENV'] == 'production'
if sys.argv[2] == '0':
    assert all(runtime.get(name, '0').strip('"\'') != '1' for name in
               ('CHUNMO_OWNER_PORTAL_ENABLED', 'CHUNMO_OWNER_PURCHASE_ENABLED'))
PY

runtime_v21() {
  python3 -I -B "$launch_dir/runtime-v21.py" "$1" "$conf" "$commit"
}

if [[ $v21 == 1 ]]; then
  owner_enabled=$(runtime_v21 --owner-state) || fail '无法读取当前正式业主服务状态。'
fi
if [[ $v21_pc == 1 ]]; then
  [[ $owner_enabled == 1 ]] || fail '本次发布需要保留已开启的正式业主采购服务，请核对现有配置。'
  runtime_digest=$(sha256sum "$conf/runtime.env")
fi

site() {
  curl -q -sS --noproxy '*' --proto '=https' --max-time 10 --resolve chmsj.cn:443:127.0.0.1 "$@"
}

health() {
  local sha=$1 expected_index actual_index owner_status pid endpoint expect_new=0
  if [[ $v21 == 1 && ( $sha == "$commit" || $v21_pc == 1 ) ]]; then expect_new=1; fi
  for unit in "${units[@]}"; do systemctl is-active --quiet "$unit" || return 1; done
  site -f https://chmsj.cn/api/health | python3 -I -B -c '
import json, sys
data = json.load(sys.stdin)
caps = data.get("capabilities", {})
assert (data.get("ok"), data.get("release"), data.get("environment")) == (True, sys.argv[1], "production")
assert caps.get("studioDaily") is True and (caps.get("ownerPurchases") is True) == (sys.argv[2] == "1")
' "$sha" "$owner_enabled" || return 1
  expected_index=$(sha256sum "$base/releases/$sha/dist/index.html") || return 1
  actual_index=$(site -f https://chmsj.cn/ | sha256sum) || return 1
  [[ ${actual_index%% *} == "${expected_index%% *}" ]] || return 1
  site -f https://chmsj.cn/api/mini-photo/health | python3 -I -B -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' || return 1
  site -f https://chmsj.cn/api/mini-photo-candidate/health | python3 -I -B -c '
import json, sys
data = json.load(sys.stdin)
assert data.get("ok") is True and "workbench-v1" in data.get("features", [])
' || return 1
  [[ $(site -o /dev/null -w '%{http_code}' https://chmsj.cn/api/workspace) == 401 ]] || return 1
  owner_status=$(site -o /dev/null -w '%{http_code}' https://chmsj.cn/api/mini-owner/v1/session) || return 1
  if [[ $v21 == 1 ]]; then
    [[ ( $owner_enabled == 1 && $owner_status == 401 ) || ( $owner_enabled == 0 && $owner_status == 404 ) ]] || return 1
  else
    [[ $owner_status == 404 || ( $sha == "$previous" && $owner_status == 401 ) ]] || return 1
  fi
  pid=$(systemctl show -p MainPID --value chunmo-staging-api) || return 1
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  python3 -I -B - "$pid" "$owner_enabled" "$expect_new" <<'PY' || return 1
import sys
from pathlib import Path
environ = (Path('/proc') / sys.argv[1] / 'environ').read_bytes().split(b'\0')
for flag in (b'CHUNMO_OWNER_PORTAL_ENABLED=1', b'CHUNMO_OWNER_PURCHASE_ENABLED=1'):
    assert (flag in environ) == (sys.argv[2] == '1')
if sys.argv[3] == '1':
    assert b'CHUNMO_MINI_UNIFIED_ENABLED=1' in environ and b'CHUNMO_OWNER_DESIGN_ENABLED=1' in environ
PY
  if [[ $expect_new == 1 ]]; then
    # Invalid input proves the new route is mounted without fetching a WeChat identity or writing a session.
    [[ $(site -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
        -H 'Referer: https://servicewechat.com/wxb48a7abb3858a252/0/page-frame.html' --data '{}' \
        https://chmsj.cn/api/mini-login/v1/discover) == 400 ]] || return 1
  fi
  if [[ $owner_018 == 1 ]]; then
    for endpoint in /api/records /api/studio-daily; do
      [[ $(site -o /dev/null -w '%{http_code}' "https://chmsj.cn$endpoint") == 401 ]] || return 1
    done
  fi
  if [[ $v21_pc == 1 ]]; then
    [[ $(sha256sum "$conf/runtime.env") == "$runtime_digest" ]] || return 1
    for endpoint in /api/accounts/wechat /api/owner-accounts /api/projects/release-probe/owner-design \
      /api/mini-owner/v1/projects/release-probe/design; do
      [[ $(site -o /dev/null -w '%{http_code}' "https://chmsj.cn$endpoint") == 401 ]] || return 1
    done
    if [[ $sha == "$commit" ]]; then
      for endpoint in /api/mini-employee/v1/profile /api/mini-employee/v1/avatar; do
        [[ $(site -o /dev/null -w '%{http_code}' \
          -H 'Referer: https://servicewechat.com/wxb48a7abb3858a252/0/page-frame.html' \
          "https://chmsj.cn$endpoint") == 401 ]] || return 1
      done
    fi
  fi
}

wait_health() {
  local attempt
  for attempt in $(seq 1 15); do
    if health "$1"; then return 0; fi
    sleep 2
  done
  return 1
}

select_release() {
  local directory
  directory=$(mktemp -d "$base/.owner-switch.XXXXXXXX") || return 1
  if ln -s -- "$1" "$directory/current" && mv -Tf -- "$directory/current" "$base/current"; then
    rmdir -- "$directory"
  else
    rm -f -- "$directory/current"
    rmdir -- "$directory"
    return 1
  fi
}

restore_app() {
  if [[ $v21 == 1 && $v21_pc == 0 ]]; then runtime_v21 --restore || return 1; fi
  select_release "$old" || return 1
  if [[ $v21_pc == 1 ]]; then systemctl reset-failed chunmo-staging-api || return 1; fi
  systemctl restart chunmo-staging-api && wait_health "$previous"
}

finish() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ $status != 0 ]]; then
    printf '部署在 %s 阶段终止（退出码 %s）。\n' "$phase" "$status" >&2
    if [[ $promoted == 1 ]]; then
      if restore_app; then
        printf 'PASS 已恢复旧版网页和 API %s，数据库增量及备份保留。\n' "$previous" >&2
      else
        printf 'FAIL 自动回退后的健康检查失败，请保留现场并检查 API 服务。\n' >&2
      fi
    fi
  fi
  if [[ -n $job && $job == /var/lib/chunmo-build/jobs/owner.* ]]; then rm -rf -- "$job"; fi
  if [[ -n $sql_source && $sql_source == /tmp/chunmo-v21-sql.* ]]; then rm -rf -- "$sql_source"; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

active=$(readlink -e "$base/current")
if [[ $mode == --rollback ]]; then
  phase=rollback
  [[ $active == "$old" || $active == "$new" ]] || fail '当前版本与本次发布不匹配。'
  if [[ $active == "$old" ]]; then
    if [[ $v21 == 1 && $v21_pc == 0 && -d $conf/release-v21-$commit ]]; then
      runtime_v21 --restore
    fi
    if ! health "$previous"; then restore_app; fi
  else
    restore_app
  fi
  printf 'PASS 已恢复旧版网页和 API %s，数据库增量及备份保留。\n' "$previous"
  exit 0
fi

phase=baseline
[[ $active == "$old" || $active == "$new" ]] || fail '当前正式版本已变化。'
health "${active##*/}" || fail '当前正式站健康检查未通过。'
git -C "$repo" merge-base --is-ancestor "$previous" "$commit" ||
  fail '发布版本并非当前正式基线的后继。'
git -C "$repo" diff --quiet "$previous" "$commit" -- server/migrations package-lock.json ||
  fail '基础迁移或依赖锁定文件已变化。'
if [[ $studio_duty == 1 ]]; then
  changes=$(git -C "$repo" diff --name-only "$previous" "$commit")
  while IFS= read -r path; do
    case "$path" in
      server/studio-daily.ts|server/studio-daily.test.ts|src/components/StudioDaily.tsx|src/lib/studio-daily.ts|\
      src/lib/studio-rotation.ts|src/lib/studio-rotation.test.ts|cloud-tests/studio-daily.spec.ts|\
      deploy/owner-release/deploy.sh|deploy/studio-daily/rotation-snapshot.sh|docs/studio-duty-calendar-release.md) ;;
      *) fail "卫生值日发布包含范围外文件：$path" ;;
    esac
  done <<< "$changes"
fi
if [[ $mini_monthly == 1 ]]; then
  changes=$(git -C "$repo" diff --name-only "$previous" "$commit")
  while IFS= read -r path; do
    case "$path" in
      deploy/owner-release/deploy.sh|deploy/owner-release/package.py|docs/owner-legal-review.md|\
      docs/owner-mini-monthly-login.md|server/app.ts|server/mini-employee-session.ts|server/owner-wechat.ts|\
      server/owner-portal.ts|server/owner-portal.test.ts|miniprogram/chunmo-photo/lib/api.js|\
      miniprogram/chunmo-photo/lib/employee-remember.js|miniprogram/chunmo-photo/pages/login/index.js|\
      miniprogram/chunmo-photo/pages/password/index.js|miniprogram/chunmo-photo/owner-login/owner-session.js|\
      miniprogram/chunmo-photo/owner-login/pages/welcome/index.js|\
      miniprogram/chunmo-photo/tests/employee-remember.test.cjs|miniprogram/chunmo-photo/tests/login.test.cjs|\
      miniprogram/chunmo-photo/tests/owner-login.test.cjs) ;;
      *) fail "小程序免登录发布包含范围外文件：$path" ;;
    esac
  done <<< "$changes"
elif [[ $owner_018 == 1 && $v21 == 0 ]]; then
  features=6bb23cad3f53740ba83bb6294e67be556330f003
  git -C "$repo" merge-base --is-ancestor "$features" "$commit" ||
    fail '缺少已验收的 OWNER-005 基线。'
  changes=$(git -C "$repo" diff --name-only "$features" "$commit")
  while IFS= read -r path; do
    case "$path" in
      deploy/owner-release/deploy.sh|deploy/owner-release/prepare-018.py|\
      deploy/owner-release/upgrade-018.sh|deploy/owner-release/test-018.py|\
      docs/owner-007-production.md) ;;
      *) fail "018 发布包含范围外文件：$path" ;;
    esac
  done <<< "$changes"
fi
[[ $(df -Pk "$base" | awk 'NR==2 {print $4}') -ge 2097152 ]] ||
  fail '发布目录剩余空间不足 2GiB。'

if [[ $owner_018 == 0 ]]; then
phase=backup-evidence
python3 -I -B - "$backups" "$conf/control.json" "$restore_database" <<'PY'
from hashlib import sha256
import json, re, sys
from pathlib import Path

root, config, restored = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
cfg = json.loads(config.read_text())
for report in root.glob('backup-*.cmbackup.restore-verified.json'):
    if report.is_symlink():
        continue
    verified = json.loads(report.read_text())
    if verified.get('database') != restored:
        continue
    assert verified.get('countsVerified') is True and verified.get('privateKeyVerified') is True
    archive = report.with_suffix('').with_suffix('')
    assert re.fullmatch(r'backup-[a-f0-9]{32}-[0-9TZ-]+-[a-f0-9]{8}\.cmbackup', archive.name)
    manifest = archive.with_suffix('.cmbackup.json')
    assert archive.is_file() and not archive.is_symlink() and not manifest.is_symlink()
    data = json.loads(manifest.read_text())
    assert data.get('deployment') == cfg['id'] and data.get('database') == cfg['db']
    digest = sha256()
    with archive.open('rb') as source:
        for chunk in iter(lambda: source.read(1048576), b''):
            digest.update(chunk)
    assert digest.hexdigest() == data.get('sha256')
    print('PASS 正式备份归档及隔离恢复核验记录一致。')
    break
else:
    raise SystemExit('未找到现场验收通过的隔离恢复记录。')
PY
fi

sql() {
  runuser -u postgres -- env -i PATH="$PATH" psql -X -qAt -w -v ON_ERROR_STOP=1 \
    -U postgres -h "$PG_ADMIN_SOCKET" -p 5432 -d chunmo_staging "$@"
}

check_018() {
  local report
  report=$(sql <<< "$migration_check") || fail '018 账本、权限或数据核查失败。'
  db_state=${report##*$'\n'}
  [[ $db_state == pending || $db_state == ready ]] || fail '无法识别 018 状态。'
  printf '核查 018 状态 %s 现有行数 %s\n' "$db_state" "${report%$'\n'*}"
}

check_v21() {
  db_state=$(sql <<< "$migration_check") || fail '019/020 账本、结构或权限检查失败。'
  [[ $db_state == pending || $db_state == ready ]] || fail '无法识别 019/020 状态。'
  printf 'PASS 016–018 校验一致；019/020 状态 %s。\n' "$db_state"
}

check_021() {
  db_state=$(sql <<< "$migration_check") || fail '019/020 正式账本或 021 结构核查失败。'
  [[ $db_state == pending || $db_state == ready ]] || fail '无法识别 021 状态。'
  printf 'PASS 019/020 已安装且核验通过；021 状态 %s。\n' "$db_state"
}

backup_and_rehearse_018() {
  local output archive
  output=$(cd "$old" && "$NODE_BIN" dist-deploy/ops.mjs backup "$conf" "$backups" "$PG_DUMP_BIN")
  archive=$(sed -n 's/^Encrypted consistent database backup complete: //p' <<< "$output")
  [[ $archive == "$backups/"* && ${archive#"$backups/"} =~ ^backup-[a-f0-9]{32}-[0-9TZ-]+-[a-f0-9]{8}\.cmbackup$ &&
     -f $archive && ! -L $archive && -f $archive.json && ! -e $archive.restore-verified.json ]] ||
    fail '无法确认刚生成的正式库加密归档。'
  printf '最新迁移前归档 %s\n' "$archive"
  (cd "$old" && "$NODE_BIN" dist-deploy/ops.mjs restore-check "$conf" "$archive" "$PG_RESTORE_BIN")
  python3 -I -B - "$archive.restore-verified.json" <<'PY'
import json, re, sys
with open(sys.argv[1]) as report:
    restored = json.load(report)
assert re.fullmatch(r'chunmo_restorecheck_[0-9]{14}_[a-f0-9]{8}', restored['database'])
assert restored['countsVerified'] is True and restored['privateKeyVerified'] is True
PY
  printf 'PASS 最新加密备份已在新建隔离库恢复。\n'
}

phase=database-preflight
if [[ $owner_018 == 1 ]]; then
  if [[ $v21 == 1 ]]; then
    runtime_v21 --verify
    sql_source=$(mktemp -d /tmp/chunmo-v21-sql.XXXXXXXX)
    git -C "$repo" archive "$commit" server/proposed deploy/native/approved-migrations.json | tar -xf - -C "$sql_source"
    if [[ $v21_pc == 1 ]]; then
      migration_check=$(python3 -I -B "$launch_dir/prepare-021.py" --check "$sql_source")
      check_021
    else
      migration_check=$(python3 -I -B "$launch_dir/prepare-v21.py" --check "$sql_source")
      check_v21
    fi
  else
    migration_check=$(python3 -I -B "$launch_dir/prepare-018.py" --check)
    check_018
    [[ $mini_monthly == 0 || $db_state == ready ]] || fail '正式库需要已部署的 018'
  fi
  pg_data=$(sql -Atc 'SHOW data_directory')
  db_bytes=$(sql -Atc 'SELECT pg_database_size(current_database())')
  python3 -I -B - "$backups" "$pg_data" "$db_bytes" <<'PY'
from pathlib import Path
import os, sys
backup, database = map(Path, sys.argv[1:3])
size = int(sys.argv[3])
def available(path):
    disk = os.statvfs(str(path))
    return disk.f_frsize * disk.f_bavail
if not database.is_absolute() or size <= 0:
    raise SystemExit('FAIL 无法确定正式库磁盘和数据库大小')
gib = 1024**3
shared = os.stat(backup).st_dev == os.stat(database).st_dev
if available(backup) < max(gib, 2*size) + (size if shared else 0) or available(database) < size:
    raise SystemExit('FAIL 加密备份及新建隔离恢复库的可用空间不足')
print('PASS 加密备份及隔离恢复空间核查')
PY
elif [[ $studio_duty == 0 ]]; then
  migration_check=$(python3 -I -B "$launch_dir/prepare-migration.py" --check)
  db_state=$(sql <<< "$migration_check")
  [[ $db_state == absent || $db_state == ready ]] || fail '数据库状态不符合发布计划。'
fi
if [[ $active == "$new" ]]; then
  [[ $studio_duty == 1 || $db_state == ready ]] || fail '已运行候选版本，但迁移状态异常。'
  printf 'PASS 正式版本已部署并验收 %s\n' "$commit"
  exit 0
fi

phase=build
if [[ ! -e $new ]]; then
  build_python=/usr/bin/python3.11
  if [[ ! -x $build_python ]]; then build_python=$(command -v python3); fi
  runtime_root=$(dirname "$(dirname "$NODE_BIN")")
  [[ -r $runtime_root/include/node/node.h ]] || fail '找不到当前 Node 的构建头文件。'
  job=$(mktemp -d /var/lib/chunmo-build/jobs/owner.XXXXXXXX)
  git -C "$repo" archive "$commit" | tar -x -C "$job"
  chown -R chunmo-build:chunmo-build "$job"
  runuser -u chunmo-build -- env -i HOME=/var/lib/chunmo-build PATH="$PATH" \
    npm_config_cache=/var/lib/chunmo-build/cache NODE_OPTIONS=--max-old-space-size=768 \
    PYTHON="$build_python" npm_config_python="$build_python" npm_config_nodedir="$runtime_root" \
    bash -Eeuo pipefail -c '
      cd -- "$1"
      npm ci --ignore-scripts
      npm rebuild argon2 esbuild --ignore-scripts=false --foreground-scripts
      npm run verify:native
      npm test
      npm run build
      npm run build:deploy
      node scripts/audit-production.mjs
      npm prune --omit=dev --ignore-scripts
      node scripts/verify-native.mjs --production
      node scripts/verify-release.mjs
    ' _ "$job"
  printf '%s\n' "$commit" > "$job/.verified-build"
  chown -R root:root "$job"
  chmod -R a+rX,go-w "$job"
  chmod 0755 "$job"
  mv -T -- "$job" "$new"
  job=
fi
[[ -d $new && ! -L $new && -r $new/.verified-build && $(<"$new/.verified-build") == "$commit" ]] ||
  fail '候选目录没有匹配的构建标记。'
(cd "$new" && "$NODE_BIN" scripts/verify-release.mjs && "$NODE_BIN" scripts/verify-native.mjs --production &&
  "$NODE_BIN" dist-deploy/ops.mjs studio-db-ready "$conf")

phase=database
health "$previous" || fail '构建期间正式站状态发生变化。'
if [[ $v21_pc == 1 ]]; then
  phase=pre-021-backup-and-restore
  backup_and_rehearse_018
  phase=database-021
  check_021
  if [[ $db_state == pending ]]; then
    migration=$(python3 -I -B "$launch_dir/prepare-021.py" --apply "$sql_source")
    sql <<< "$migration" >/dev/null
  fi
  check_021
  [[ $db_state == ready ]] || fail '021 提交后核查失败。'
elif [[ $v21 == 1 ]]; then
  phase=pre-v21-backup-and-restore
  backup_and_rehearse_018
  phase=database-019-020
  check_v21
  if [[ $db_state == pending ]]; then
    migration=$(python3 -I -B "$launch_dir/prepare-v21.py" --apply "$sql_source")
    sql <<< "$migration" >/dev/null
  fi
  check_v21
  [[ $db_state == ready ]] || fail '019/020 提交后核查失败。'
elif [[ $owner_018 == 1 ]]; then
  phase=pre-018-backup-and-restore
  backup_and_rehearse_018
  phase=database-018
  check_018
  if [[ $db_state == pending ]]; then
    [[ $mini_monthly == 0 ]] || fail '正式库 018 状态已变化'
    migration=$(python3 -I -B "$launch_dir/prepare-018.py" --apply)
    sql <<< "$migration"
  fi
  check_018
  [[ $db_state == ready ]] || fail '018 提交后的账本或权限核查失败。'
elif [[ $studio_duty == 0 ]]; then
  if [[ $db_state == absent ]]; then
    phase=pre-migration-backup
    (cd "$old" && "$NODE_BIN" dist-deploy/ops.mjs backup "$conf" "$backups" "$PG_DUMP_BIN")
    phase=database
    migration=$(python3 -I -B "$launch_dir/prepare-migration.py")
    sql <<< "$migration" >/dev/null
  fi
  [[ $(sql <<< "$migration_check") == ready ]] || fail '业主表、权限或校验值未通过复验。'
  printf 'PASS 数据库 016/017、分权和关闭状态已核验。\n'
else
  printf 'PASS 卫生值日发布只切换代码，已核验数据库就绪状态。\n'
fi
if [[ $v21_pc == 0 ]]; then
  phase=backup
  (cd "$new" && "$NODE_BIN" dist-deploy/ops.mjs backup "$conf" "$backups" "$PG_DUMP_BIN")
fi

phase=promotion
if [[ $v21_pc == 1 ]]; then
  [[ $(readlink -e "$base/current") == "$old" && $(sha256sum "$conf/runtime.env") == "$runtime_digest" ]] ||
    fail '候选构建期间正式版本或原有配置已变化。'
elif [[ $v21 == 1 ]]; then runtime_v21 --prepare; fi
promoted=1
if [[ $v21 == 1 && $v21_pc == 0 ]]; then runtime_v21 --apply; fi
select_release "$new"
systemctl restart chunmo-staging-api
wait_health "$commit" || fail '新版网页、API 或员工服务未通过验收。'
if [[ $v21_pc == 1 ]]; then
  phase=post-021-acceptance
  check_021
  [[ $db_state == ready ]] || fail '上线后 021 核查失败。'
elif [[ $v21 == 1 ]]; then
  phase=post-v21-acceptance
  check_v21
  [[ $db_state == ready ]] || fail '上线后 019/020 核查失败。'
elif [[ $owner_018 == 1 ]]; then
  phase=post-018-acceptance
  check_018
  [[ $db_state == ready ]] || fail '上线后 018 核查失败。'
fi
phase=complete
if [[ $v21 == 1 ]]; then
  printf 'PASS 正式 V2.1 网页/API/数据库部署通过 %s，业主服务开关保持 %s。\n' "$commit" "$owner_enabled"
else
  printf 'PASS 正式网页/API/数据库部署通过 %s，业主开放保持关闭。\n' "$commit"
fi
