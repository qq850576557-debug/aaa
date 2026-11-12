#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
if [[ -z ${DEVECO_SDK_HOME:-} || ! -d ${DEVECO_SDK_HOME:-} ]]; then
  echo '未找到HarmonyOS SDK。尚未构建HAP；请在目标DevEco环境核验6.1/API和签名。' >&2
  exit 2
fi
if [[ -z ${HVIGORW:-} || ! -x ${HVIGORW:-} ]]; then
  echo '请将HVIGORW设置为目标DevEco Studio提供的实际hvigorw可执行路径。' >&2
  exit 2
fi
"$HVIGORW" --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
rg --files entry/build -g '*.hap'
echo '以上仅列出实际构建产物；安装前还需在DevEco核验签名/profile及目标设备授权。'
