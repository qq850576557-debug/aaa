#!/usr/bin/env python3
"""Read-only Python 3.6+ readiness check. Never prints credentials or writes config."""
import hashlib
import json
from pathlib import Path
import subprocess


def inspect(base=Path('/opt/chunmo-staging'), conf=Path('/etc/chunmo-staging')):
    current = base / 'current'
    bundle = current / 'dist-api/server.mjs'
    source = bundle.read_bytes() if bundle.is_file() else b''
    env = conf / 'runtime.env'
    names = set()
    if env.is_file():
        for line in env.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                name, value = line.split('=', 1)
                if value.strip():
                    names.add(name.strip())
    return {
        'release': current.resolve().name if current.exists() else 'missing',
        'apiBundlePresent': bool(source),
        'apiBundleSha256': hashlib.sha256(source).hexdigest() if source else None,
        'miniGatewayCodePresent': b'/api/mini-photo/' in source and b'CHUNMO_MINI_PHOTO_ENABLED' in source,
        'miniConfigurationPresent': all(n in names for n in ('CHUNMO_MINI_APP_ID', 'CHUNMO_MINI_APP_SECRET', 'CHUNMO_MINI_PHOTO_ENABLED')),
        'amapConfigurationPresent': all(n in names for n in ('CHUNMO_AMAP_KEY', 'CHUNMO_AMAP_ENABLED')),
    }


if __name__ == '__main__':
    try:
        result = inspect()
        for unit in ('chunmo-staging-api', 'chunmo-staging-web'):
            result[unit] = subprocess.call(['systemctl', 'is-active', '--quiet', unit]) == 0
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print('只读检查完成：未修改配置、未读取输出密钥、未重启服务、未操作数据库。')
    except Exception:
        print('检查未完成：请确认在阿里云Workbench的root终端执行；不要发送runtime.env内容。')
        raise SystemExit(1)
