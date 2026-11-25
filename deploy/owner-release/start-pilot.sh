#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# == 2 && $EUID == 0 ]] || { printf '请在 Workbench root 终端提供项目名称与隐私邮箱。\n' >&2; exit 1; }
dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=/opt/chunmo-source
staff=1904785647c91f0ad524dbf156650898fcdd4921
if ! git -C "$repo" cat-file -e "$staff^{commit}" 2>/dev/null; then
  timeout 120 git -C "$repo" -c http.version=HTTP/1.1 fetch --no-tags \
    https://github.com/qq850576557-debug/aaa.git refs/heads/fix/mini-workbench-ios-save
  [[ $(git -C "$repo" rev-parse FETCH_HEAD) == "$staff" ]]
fi
builder=python3
if [[ -x /usr/bin/python3.11 ]]; then builder=/usr/bin/python3.11; fi
downloads=$(mktemp -d /root/chunmo-wechat.XXXXXXXX)
"$builder" -I -B "$dir/build-pilot-package.py" "$repo" "$downloads" "$2"
printf '正式小程序包 %s/chunmo-wechat-formal-candidate.zip\n隐私指引文案 %s/wechat-privacy-text.txt\n' "$downloads" "$downloads"
active=$(readlink -e /opt/chunmo-staging/current)
case "${active##*/}" in
  4a6ff34497c67bed7bd71e2e89f4ac6339be1cff)
    bash "$dir/deploy.sh" --deploy-mini-monthly 8bbd1e818981d9d405dfbac8bc9a581768b648af
    ;;
  8bbd1e818981d9d405dfbac8bc9a581768b648af|6aef816bd4a4e541dcf6425843050080d288aac4) ;;
  *) printf 'FAIL 当前正式版本不在本次试点范围。\n' >&2; exit 1 ;;
esac
exec 9>/run/lock/chunmo-staging-deploy.lock
flock -n 9 || { printf 'FAIL 正在执行另一项正式站操作。\n' >&2; exit 1; }
exec python3 -I -B "$dir/enable-pilot.py" "$1"
