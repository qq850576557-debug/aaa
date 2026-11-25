"""Inspect the existing production release without changing services, files, or database."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


def command(args, **kwargs):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          timeout=20, check=True, **kwargs).stdout.strip()


def health(host):
    return json.loads(command([
        'curl', '-fsS', '--noproxy', '*', '--proto', '=https', '--max-time', '10',
        '--resolve', host + ':443:127.0.0.1', 'https://' + host + '/api/health',
    ]))


def run(candidate):
    assert os.geteuid() == 0 and re.fullmatch(r'[a-f0-9]{40}', candidate)
    conf = Path('/etc/chunmo-staging/runtime.env')
    assert conf.is_file() and not conf.is_symlink() and conf.stat().st_uid == 0
    config = dict(item.split('=', 1) for item in conf.read_text().splitlines()
                  if '=' in item and not item.lstrip().startswith('#'))
    config = {key: value.strip().strip('"\'') for key, value in config.items()}
    staff = urlsplit(config['DATABASE_URL'])
    assert config['APP_ENV'] == 'production' and config['APP_ORIGIN'] == 'https://chmsj.cn'
    assert (staff.username, staff.hostname, staff.port, staff.path) == (
        'cm_stg_app', '127.0.0.1', 5432, '/chunmo_staging',
    )
    active = Path('/opt/chunmo-staging/current').resolve(strict=True)
    assert active.parent == Path('/opt/chunmo-staging/releases')
    sha = active.name
    assert re.fullmatch(r'[a-f0-9]{40}', sha)
    assert (active / '.verified-build').read_text().strip() == sha
    prod = health('chmsj.cn')
    assert (prod['ok'], prod['environment'], prod['release']) == (True, 'production', sha)
    print('正式站', sha)
    try:
        test = health('owner-test.chmsj.cn')
        assert (test['ok'], test['environment']) == (True, 'test')
        assert re.fullmatch(r'[a-f0-9]{40}', test['release'])
        print('测试站', test['release'])
    except (subprocess.SubprocessError, AssertionError, KeyError, ValueError):
        print('测试站 现场健康接口未通过')

    env = {'PATH': '/usr/pgsql-17/bin:/usr/local/bin:/usr/bin:/bin', 'LC_ALL': 'C'}
    tool_config = (conf.parent / 'tools.env').read_text()
    setting = re.search(r'^PG_ADMIN_SOCKET=["\']?(/[A-Za-z0-9._/-]+)["\']?$', tool_config, re.M)
    candidates = ([setting.group(1)] if setting else []) + ['/var/run/postgresql', '/run/postgresql', '/tmp']
    socket = next(path for path in candidates if (Path(path) / '.s.PGSQL.5432').is_socket())
    sql = """
BEGIN READ ONLY;
SELECT jsonb_build_object(
  'database',current_database(),
  'migration018', CASE WHEN to_regprocedure('owner_portal.owner_purchase_photo(text,text,text,text)') IS NULL THEN false ELSE true END,
  'migration019', to_regclass('public.employee_wechat_binding') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='clear_employee_wechat_on_credential_change' AND tgenabled='O'),
  'migration020', to_regclass('owner_portal.project_design') IS NOT NULL
    AND to_regprocedure('owner_portal.authorized_design(text,text)') IS NOT NULL
);
ROLLBACK;
"""
    record = json.loads(command([
        'runuser', '-u', 'postgres', '--', 'env', '-i', *[k + '=' + v for k, v in env.items()],
        'psql', '-XqAtw', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-h', socket,
        '-p', '5432', '-d', 'chunmo_staging',
    ], input=sql, env=env))
    assert record.pop('database') == 'chunmo_staging'
    for key, value in record.items():
        print(key[-3:], '结构已存在' if value else '结构缺失或未启用')

    pid = command(['systemctl', 'show', '-p', 'MainPID', '--value', 'chunmo-staging-api'])
    assert re.fullmatch(r'[1-9][0-9]*', pid)
    live = set((Path('/proc') / pid / 'environ').read_bytes().split(b'\0'))
    flags = {name: (name + '=1').encode() in live for name in (
        'CHUNMO_OWNER_PORTAL_ENABLED', 'CHUNMO_OWNER_PURCHASE_ENABLED',
        'CHUNMO_MINI_UNIFIED_ENABLED', 'CHUNMO_OWNER_DESIGN_ENABLED',
    )}
    print('业主服务', '开启' if flags['CHUNMO_OWNER_PORTAL_ENABLED'] else '关闭')
    print('业主采购', '开启' if flags['CHUNMO_OWNER_PURCHASE_ENABLED'] else '关闭')
    print('统一登录', '开启' if flags['CHUNMO_MINI_UNIFIED_ENABLED'] else '关闭')
    print('设计成果', '开启' if flags['CHUNMO_OWNER_DESIGN_ENABLED'] else '关闭')
    design_domains = any(
        item.startswith(b'CHUNMO_OWNER_DESIGN_ORIGINS=') and item.split(b'=', 1)[1].strip()
        for item in live
    )
    print('业务域名', '生产进程已配置' if design_domains else '生产进程未配置')
    if sha == candidate and all(record.values()) and all(flags.values()) and design_domains:
        print('PASS 正式 V2.1 服务结构及开关已就绪，微信后台审核状态需单独核对。')
    else:
        print('PENDING 正式 V2.1 尚有发布准备项，以上命令仅做只读核查。')


if __name__ == '__main__':
    try:
        run(sys.argv[1])
    except (OSError, StopIteration, IndexError, AssertionError, KeyError, ValueError, subprocess.SubprocessError):
        raise SystemExit('FAIL 现场只读核查未通过。请核对正式网站、当前发布目录和 PostgreSQL 本机连接。')
