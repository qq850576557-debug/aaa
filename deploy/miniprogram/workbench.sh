#!/usr/bin/env bash
# Run ONLY the reviewed commit and chosen stage; never runs chunmo-update.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo '请在阿里云Workbench的root交互终端执行。' >&2; exit 1; }
commit=${1:-}
mode=${2:-}
[[ $commit =~ ^[a-f0-9]{40}$ ]] || { echo '需要已审核的完整提交SHA。' >&2; exit 1; }
case "$mode" in --check|--install|--rollback) ;; *) echo '模式必须为 --check、--install 或 --rollback。' >&2; exit 1;; esac
repo=/opt/chunmo-source
work=$(mktemp -d /tmp/chunmo-mini-stage.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
git -C "$repo" show "$commit:deploy/miniprogram/install.py" > "$work/install.py"
case "$mode" in
  --check)
    python3 "$work/install.py" --repo "$repo" --commit "$commit" --check
    ;;
  --install)
    printf '%s\n' '此步骤新增独立服务、私有密钥文件及小程序Nginx路由。必须先获得负责人确认。'
    read -r -p '粘贴刚才只读检查的 approvalToken（核验指纹，不是AppSecret）：' approval </dev/tty
    python3 "$work/install.py" --repo "$repo" --commit "$commit" --install --approve "$approval"
    ;;
  --rollback)
    read -r -p '粘贴安装时输出的 install- 开头备份编号：' backup </dev/tty
    python3 "$work/install.py" --repo "$repo" --commit "$commit" --rollback "$backup"
    ;;
esac
