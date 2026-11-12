#!/usr/bin/env bash
# Run from a source-only git archive in Workbench. Does NOT run chunmo-update.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo '请在阿里云 Workbench 使用 root 执行。' >&2; exit 1; }
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SOURCE_REPO=${CHUNMO_SOURCE_REPO:-/opt/chunmo-source}
APK_COMMIT=2756068e6ce7f6f39a90c75610d24e9479b13f0d
APK_PATH=native/releases/chunmo-photo-1.0.0-debug.apk
APK_SHA=f6a1046dbd7b66125971573b16b435d31b34bc1f45e1d12543d0d8b7859a4d8d
work=$(mktemp -d /tmp/chunmo-apk-publish.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
# Prefer the existing server repository; do not checkout/reset/pull any source.
if git -C "$SOURCE_REPO" cat-file -e "$APK_COMMIT:$APK_PATH" 2>/dev/null; then
  git -C "$SOURCE_REPO" show "$APK_COMMIT:$APK_PATH" > "$work/chunmo-photo-test.apk"
else
  # Same already-built artifact, publicly downloaded and SHA-verified in Codex.
  curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 \
    "https://raw.githubusercontent.com/qq850576557-debug/aaa/$APK_COMMIT/$APK_PATH" \
    --output "$work/chunmo-photo-test.apk"
fi
printf '%s  %s\n' "$APK_SHA" "$work/chunmo-photo-test.apk" | sha256sum --check --status
python3 "$SCRIPT_DIR/publish.py" --apk "$work/chunmo-photo-test.apk" \
  --logo "$SCRIPT_DIR/../../public/brand/source/chunmo-original-circle.png" "$@"
