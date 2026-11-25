#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

release=6bb23cad3f53740ba83bb6294e67be556330f003
previous=6d41027635bb776113199ecbce297bd6bb95eac65e90763fcbd7f8a48ecd6e9d
updated=93b98a7ece1430c664e525e3fce2a6f5d03bcf349b9076b48ae83e4347dec81f
source_url=https://github.com/qq850576557-debug/aaa/raw/ce247adb9bff876518495ffb86700a040f1740fe/chunmo-owner-test-handset.zip
origin=https://owner-test.chmsj.cn
state=/etc/chunmo-owner-test
unit=/etc/systemd/system/chunmo-owner-test-api.service
nginx=/opt/chunmo-staging/nginx.conf

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
digest() { sha256sum "$@" | cut -d ' ' -f 1; }
site() {
  curl -fsS --noproxy '*' --resolve owner-test.chmsj.cn:443:127.0.0.1 --max-time 15 "$origin/$1"
}

[[ $EUID == 0 ]] || fail '请在 Workbench root 终端执行'
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || fail '已有站点操作正在执行'
[[ -d $state && ! -L $state && -f $unit && ! -L $unit && -f $nginx && ! -L $nginx ]] ||
  fail '找不到已部署的隔离测试站配置'
[[ $(head -n 1 "$unit") == '# Managed by Chunmo owner-test installer' ]] ||
  fail '测试服务标记不匹配'
job=$(sed -n 's/^WorkingDirectory=//p' "$unit")
[[ $job =~ ^/opt/chunmo-owner-test/build\.[A-Za-z0-9]+$ && -d $job && ! -L $job ]] ||
  fail '测试站构建目录不匹配'
[[ -r $job/.verified-build && $(<"$job/.verified-build") == "$release" ]] ||
  fail '测试站发布版本与本 ZIP 不匹配'
zip="$job/chunmo-owner-test.zip"
[[ -f $zip && ! -L $zip ]] || fail '现有测试 ZIP 无效'
grep -Fxq "      alias $zip;" "$nginx" || fail '当前 Web 下载路由不匹配'
site api/health | python3 -I -B -c '
import json, sys
health=json.load(sys.stdin)
assert (health.get("ok"),health.get("environment"),health.get("release")) == (True,"test",sys.argv[1])
' "$release" || fail '隔离测试站健康检查失败'
current=$(digest "$zip")
[[ $current == "$previous" || $current == "$updated" ]] || fail '现有测试包哈希与已核对版本不一致'
[[ $(site chunmo-owner-test.zip | digest) == "$current" ]] || fail '网页下载与测试文件不一致'
if [[ $current == "$updated" ]]; then
  printf 'PASS %s/chunmo-owner-test.zip\n' "$origin"
  exit 0
fi

backup=$(mktemp -d "$state/download-backup.XXXXXXXX")
cp -p -- "$zip" "$backup/chunmo-owner-test.zip"
pending=$(mktemp "$job/.handset-download.XXXXXXXX")
rollback=
switched=0
cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [[ $rc != 0 && $switched == 1 ]]; then
    if mv -Tf -- "$rollback" "$zip"; then
      printf '已恢复原测试 ZIP。备份 %s\n' "$backup/chunmo-owner-test.zip" >&2
    else
      printf 'FAIL 恢复原测试 ZIP 失败。备份 %s\n' "$backup/chunmo-owner-test.zip" >&2
    fi
  fi
  rm -f -- "$pending"
  if [[ $switched == 0 && -n $rollback ]]; then rm -f -- "$rollback"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
curl -fLsS --proto '=https' --max-time 45 "$source_url" -o "$pending"
[[ $(digest "$pending") == "$updated" ]] || fail '新版 ZIP 校验未通过'
chmod 0644 "$pending"
rollback=$(mktemp "$job/.handset-rollback.XXXXXXXX")
cp -p -- "$zip" "$rollback"
switched=1
mv -Tf -- "$pending" "$zip"
[[ $(site chunmo-owner-test.zip | digest) == "$updated" ]] || fail '新版网页下载未通过校验'
switched=0
rm -f -- "$rollback"
rollback=
printf 'PASS %s/chunmo-owner-test.zip\n旧包备份 %s\n' "$origin" "$backup/chunmo-owner-test.zip"
