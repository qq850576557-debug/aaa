"""Preserve existing pilot configuration while switching the production client API."""
import os
from pathlib import Path
import re
import runpy
import shutil
import sys
import tempfile
from urllib.parse import unquote, urlsplit


pilot = runpy.run_path(str(Path(__file__).with_name('enable-pilot.py')))
check = pilot['check']
protected = pilot['protected']
env_values = pilot['env_values']
flags = pilot['FLAGS']
new_flags = ('CHUNMO_MINI_UNIFIED_ENABLED', 'CHUNMO_OWNER_DESIGN_ENABLED')


def owner_state(values):
    portal, purchase = (values.get(flag, '0') for flag in flags)
    check(portal == purchase and portal in ('0', '1'), '业主服务开关状态不一致')
    return portal


def verify_config(values):
    enabled = owner_state(values)
    app_id, secret = values.get('CHUNMO_MINI_APP_ID'), values.get('CHUNMO_MINI_APP_SECRET')
    if not (app_id and secret):
        app_id = values.get('CHUNMO_OWNER_WECHAT_APP_ID')
        secret = values.get('CHUNMO_OWNER_WECHAT_APP_SECRET')
    check(app_id == pilot['APP_ID'] and bool(re.fullmatch(r'[a-fA-F0-9]{32}', secret or '')),
          '正式微信 AppID 或凭证配置不匹配')
    if enabled == '1':
        owner = urlsplit(values.get('CHUNMO_OWNER_DATABASE_URL', ''))
        check((owner.username, owner.hostname, owner.port, owner.path) ==
              (pilot['OWNER'], '127.0.0.1', 5432, '/chunmo_staging') and owner.password and
              values.get('CHUNMO_OWNER_WECHAT_APP_ID') == app_id and
              values.get('CHUNMO_OWNER_WECHAT_APP_SECRET') == secret,
              '已有业主试点连接或微信配置不一致')
        psql = shutil.which('psql')
        check(psql, '找不到 PostgreSQL 客户端')
        pilot['verify_owner'](psql, unquote(owner.password))
    return enabled


def prepare(runtime, current, directory):
    text = current
    for flag in new_flags:
        text, replacements = re.subn(r'(?m)^[ \t]*' + flag + r'[ \t]*=[^\n]*$', flag + '=1', text)
        if not replacements:
            text = text.rstrip('\n') + '\n' + flag + '=1\n'
    if directory.exists():
        check(not directory.is_symlink() and (directory / 'before').is_file() and
              protected(directory / 'before') == current and protected(directory / 'after') == text,
              '已有回退配置与当前配置不匹配')
        return
    with tempfile.TemporaryDirectory(prefix='.v21-runtime.', dir=str(runtime.parent)) as temp:
        snapshot = Path(temp) / 'snapshot'
        snapshot.mkdir(mode=0o700)
        for name, content in (('before', current), ('after', text)):
            with (snapshot / name).open('x', encoding='utf-8') as dest:
                dest.write(content)
                dest.flush()
                os.fsync(dest.fileno())
        snapshot.rename(directory)


def run(operation, root, candidate):
    check(bool(re.fullmatch(r'[a-f0-9]{40}', candidate)), '无效发布 SHA')
    umask = os.umask(0o077)
    try:
        runtime = root / 'runtime.env'
        current = protected(runtime)
        values = env_values(current)
        directory = root / ('release-v21-' + candidate)
        if operation == '--owner-state':
            print(owner_state(values))
        elif operation == '--verify':
            verify_config(values)
            print('PASS 正式微信配置及现有试点连接通过核查。')
        elif operation == '--prepare':
            prepare(runtime, current, directory)
        elif operation in ('--apply', '--restore'):
            before, after = ('before', 'after') if operation == '--apply' else ('after', 'before')
            check(directory.is_dir() and not directory.is_symlink(), '找不到回退配置目录')
            saved, target = (protected(directory / name) for name in (before, after))
            if current != target:
                check(current == saved, '配置在发布后已变更，需现场处理')
                pilot['replace_from'](runtime, directory / after)
        else:
            raise RuntimeError('无效发布配置操作')
    finally:
        os.umask(umask)


if __name__ == '__main__':
    try:
        run(sys.argv[1], Path(sys.argv[2]), sys.argv[3])
    except RuntimeError as error:
        raise SystemExit('FAIL ' + str(error)) from None
    except (IndexError, KeyError, OSError, ValueError):
        raise SystemExit('FAIL 正式运行配置或其私有回退记录无法读取。') from None
