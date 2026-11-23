#!/usr/bin/env bash
# Promote the pinned owner release on the existing managed host, with access closed.
set -Eeuo pipefail
umask 077
export PATH="/usr/pgsql-17/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

base=/opt/chunmo-staging
conf=/etc/chunmo-staging
backups=/var/backups/chunmo-staging
previous=04d1e6352e18d0861cc3e0bca2edc9ec3e122a7c
restore_database=chunmo_restorecheck_20261123075542_188a4d8d
repo=/opt/chunmo-source
mode=${1:-}
commit=${2:-}
studio_duty=0
case $mode in
  --deploy-studio-duty|--rollback-studio-duty)
    studio_duty=1
    previous=0741da22e288b632fa3d1651903a09c0b97b4b9d
    mode=${mode%-studio-duty}
    ;;
esac
phase=host
promoted=0
job=
launch_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
units=(chunmo-staging-web chunmo-staging-api chunmo-mini-photo chunmo-mini-workbench)

fail() { printf 'FAIL %s — %s\n' "$phase" "$*" >&2; exit 1; }
[[ $# == 2 && ( $mode == --deploy || $mode == --rollback ) && $commit =~ ^[a-f0-9]{40}$ &&
    $commit != "$previous" ]] || fail '用法 deploy.sh --deploy|--rollback|--deploy-studio-duty|--rollback-studio-duty 完整提交'
[[ $EUID == 0 ]] || fail '请在 Workbench 的 root 终端执行。'
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || fail '已有部署或备份操作在运行。'
old="$base/releases/$previous"
new="$base/releases/$commit"
[[ -L $base/current && -d $old && -r $old/.verified-build && $(<"$old/.verified-build") == "$previous" ]] ||
  fail '找不到已核验的旧版本。'
source "$conf/tools.env"
export PG_ADMIN_SOCKET
[[ $NODE_BIN == /* && -x $NODE_BIN && -S $PG_ADMIN_SOCKET/.s.PGSQL.5432 ]] ||
  fail '当前 Node 或 PostgreSQL 工具路径不符合预检。'
export PATH="$(dirname -- "$NODE_BIN"):$PATH"
python3 - "$conf" <<'PY'
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
assert all(runtime.get(name, '0').strip('"\'') != '1' for name in
           ('CHUNMO_OWNER_PORTAL_ENABLED', 'CHUNMO_OWNER_PURCHASE_ENABLED'))
PY

site() {
  curl -sS --noproxy '*' --proto '=https' --max-time 10 --resolve chmsj.cn:443:127.0.0.1 "$@"
}

health() {
  local sha=$1 expected_index actual_index owner_status pid
  for unit in "${units[@]}"; do systemctl is-active --quiet "$unit" || return 1; done
  site -f https://chmsj.cn/api/health | python3 -c '
import json, sys
data = json.load(sys.stdin)
caps = data.get("capabilities", {})
assert (data.get("ok"), data.get("release"), data.get("environment")) == (True, sys.argv[1], "production")
assert caps.get("studioDaily") is True and caps.get("ownerPurchases") is not True
' "$sha" || return 1
  expected_index=$(sha256sum "$base/releases/$sha/dist/index.html") || return 1
  actual_index=$(site -f https://chmsj.cn/ | sha256sum) || return 1
  [[ ${actual_index%% *} == "${expected_index%% *}" ]] || return 1
  site -f https://chmsj.cn/api/mini-photo/health | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' || return 1
  site -f https://chmsj.cn/api/mini-photo-candidate/health | python3 -c '
import json, sys
data = json.load(sys.stdin)
assert data.get("ok") is True and "workbench-v1" in data.get("features", [])
' || return 1
  [[ $(site -o /dev/null -w '%{http_code}' https://chmsj.cn/api/workspace) == 401 ]] || return 1
  owner_status=$(site -o /dev/null -w '%{http_code}' https://chmsj.cn/api/mini-owner/v1/session) || return 1
  [[ $owner_status == 404 || ( $sha == "$previous" && $owner_status == 401 ) ]] || return 1
  pid=$(systemctl show -p MainPID --value chunmo-staging-api) || return 1
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  python3 - "$pid" <<'PY'
import sys
from pathlib import Path
environ = (Path('/proc') / sys.argv[1] / 'environ').read_bytes().split(b'\0')
assert b'CHUNMO_OWNER_PORTAL_ENABLED=1' not in environ
assert b'CHUNMO_OWNER_PURCHASE_ENABLED=1' not in environ
PY
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
  select_release "$old" &&
    systemctl restart chunmo-staging-api &&
    wait_health "$previous"
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
[[ $(df -Pk "$base" | awk 'NR==2 {print $4}') -ge 2097152 ]] ||
  fail '发布目录剩余空间不足 2GiB。'

phase=backup-evidence
python3 - "$backups" "$conf/control.json" "$restore_database" <<'PY'
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

sql() {
  runuser -u postgres -- env -i PATH="$PATH" psql -X -qAt -w -v ON_ERROR_STOP=1 \
    -U postgres -h "$PG_ADMIN_SOCKET" -p 5432 -d chunmo_staging "$@"
}

phase=database-preflight
if [[ $studio_duty == 0 ]]; then
  migration_check=$(python3 "$launch_dir/prepare-migration.py" --check)
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
if [[ $studio_duty == 0 ]]; then
  if [[ $db_state == absent ]]; then
    phase=pre-migration-backup
    (cd "$old" && "$NODE_BIN" dist-deploy/ops.mjs backup "$conf" "$backups" "$PG_DUMP_BIN")
    phase=database
    migration=$(python3 "$launch_dir/prepare-migration.py")
    sql <<< "$migration" >/dev/null
  fi
  [[ $(sql <<< "$migration_check") == ready ]] || fail '业主表、权限或校验值未通过复验。'
  printf 'PASS 数据库 016/017、分权和关闭状态已核验。\n'
else
  printf 'PASS 卫生值日发布只切换代码，已核验数据库就绪状态。\n'
fi
phase=backup
(cd "$new" && "$NODE_BIN" dist-deploy/ops.mjs backup "$conf" "$backups" "$PG_DUMP_BIN")

phase=promotion
promoted=1
select_release "$new"
systemctl restart chunmo-staging-api
wait_health "$commit" || fail '新版网页、API 或员工服务未通过验收。'
phase=complete
printf 'PASS 正式网页/API/数据库部署通过 %s，业主开放保持关闭。\n' "$commit"
