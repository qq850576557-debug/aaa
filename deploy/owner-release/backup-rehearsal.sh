#!/usr/bin/env bash
# Run only the approved backup and restore rehearsal against the preflighted release.
set -Eeuo pipefail
umask 077

root=/opt/chunmo-staging
conf=/etc/chunmo-staging
backups=/var/backups/chunmo-staging
release=04d1e6352e18d0861cc3e0bca2edc9ec3e122a7c
installed="$root/releases/$release"

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $EUID == 0 ]] || fail '请在阿里云 Workbench 的 root 终端运行。'
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || fail '已有备份、恢复或更新在运行，请等它结束。'
[[ $(readlink -e "$root/current") == "$installed" && -r $installed/.verified-build ]] ||
  fail '当前正式版本与已核查版本不同，请先核对版本。'
[[ $(<"$installed/.verified-build") == "$release" && -f $installed/dist-deploy/ops.mjs ]] ||
  fail '当前版本的构建标记或备份工具缺失。'
[[ -d $backups && ! -L $backups ]] || fail '正式备份目录未就绪。'

check_release() {
  curl -fsS --noproxy '*' --max-time 10 --resolve chmsj.cn:443:127.0.0.1 \
    'https://chmsj.cn/api/health' | python3 -c '
import json, sys
d = json.load(sys.stdin)
sys.exit(0 if d.get("ok") is True and d.get("environment") == "production" and d.get("release") == sys.argv[1] else 1)
' "$release"
}

check_release || fail '正式 API 健康检查未通过，或返回了不同版本。'
python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    cfg = json.load(source)
sys.exit(0 if cfg.get("db") == "chunmo_staging" and cfg.get("host") == "127.0.0.1" and cfg.get("port") == 5432 else 1)
' "$conf/control.json" || fail '备份配置未指向已核查的正式核心库。'

# Use the existing installed database tools, including the local admin socket.
# shellcheck disable=SC1091
source "$conf/tools.env"
export PG_ADMIN_SOCKET
cd "$installed"

printf '正在生成正式库加密备份…\n'
backup_output=$("$NODE_BIN" dist-deploy/ops.mjs backup "$conf" "$backups" "$PG_DUMP_BIN") ||
  fail '加密备份未完成，请查看上方错误。'
archive=$(sed -n 's/^Encrypted consistent database backup complete: //p' <<< "$backup_output")
[[ $archive == "$backups/"* && ${archive#"$backups/"} =~ ^backup-[a-f0-9]{32}-[0-9TZ-]+-[a-f0-9]{8}\.cmbackup$ &&
   -f $archive && ! -L $archive && -f $archive.json ]] ||
  fail '未能确认本轮新生成的备份归档，已停止恢复。'
printf '加密备份已生成，正在恢复到新建的隔离库…\n'
"$NODE_BIN" dist-deploy/ops.mjs restore-check "$conf" "$archive" "$PG_RESTORE_BIN" ||
  fail '隔离恢复尚未通过，生产加密备份已保留。'
[[ -f $archive.restore-verified.json ]] || fail '缺少隔离恢复核验记录。'
check_release || fail '隔离恢复已完成，正式 API 健康状态需复核。'
printf 'PASS 正式库加密备份与隔离恢复验收通过，正式服务版本 %s\n' "$release"
