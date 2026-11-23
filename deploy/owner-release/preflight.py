#!/usr/bin/env python3
"""Print production release, schema, inventory and role checks without changing the host."""

import json
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


CONF = Path('/etc/chunmo-staging')
CURRENT = Path('/opt/chunmo-staging/current')
APP_DB = 'chunmo_staging'
SERVICES = ('chunmo-staging-web', 'chunmo-staging-api', 'chunmo-mini-photo', 'chunmo-mini-workbench')
OWNER_KEYS = ('CHUNMO_OWNER_DATABASE_URL', 'CHUNMO_OWNER_DATA_KEY', 'CHUNMO_OWNER_WECHAT_APP_ID', 'CHUNMO_OWNER_WECHAT_APP_SECRET')


class PreflightError(ValueError):
    pass


def runtime_values(path):
    pairs = (line.split('=', 1) for line in path.read_text().splitlines() if '=' in line and not line.lstrip().startswith('#'))
    return {key.strip(): value.strip().strip('"\'') for key, value in pairs}


def database_config(values):
    url = urlsplit(values['DATABASE_URL'])
    if (values.get('APP_ENV') != 'production' or url.hostname != '127.0.0.1' or url.port != 5432
            or url.path != '/' + APP_DB or not re.fullmatch(r'[a-z][a-z0-9_]{1,62}', url.username or '')):
        raise PreflightError('正式核心库配置与已知部署边界不同')
    return url.username


def fetch(path):
    run = subprocess.run(['curl', '-fsS', '--noproxy', '*', '--max-time', '8', '--resolve', 'chmsj.cn:443:127.0.0.1',
                          'https://chmsj.cn' + path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    return json.loads(run.stdout.decode('utf-8')) if run.returncode == 0 else {}


REPORT_SQL = r'''
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SELECT json_build_object(
  'currentDatabase', current_database(),
  'migrations', coalesce((SELECT json_object_agg(name,checksum) FROM public.schema_migration), '{}'::json),
  'rows', json_build_object(
    'workspaces', (SELECT count(*) FROM public.workspace_state),
    'projects', (SELECT count(*) FROM public.project),
    'purchaseDocument', (SELECT coalesce(sum(jsonb_array_length(data->'purchases')),0) FROM public.workspace_state),
    'purchaseIndex', (SELECT count(*) FROM public.purchase),
    'unmatchedPurchases', (SELECT count(*) FROM public.workspace_state w
      CROSS JOIN LATERAL jsonb_array_elements(w.data->'purchases') i(item)
      LEFT JOIN public.purchase p ON p.workspace_id=w.workspace_id AND p.id=i.item->>'id'
        AND p.project_id=i.item->>'projectId' WHERE p.id IS NULL),
    'internalRecords', (SELECT count(*) FROM public.work_record)),
  'ownerObjects', json_build_object(
    'identity', to_regclass('owner_portal.project_grant') IS NOT NULL,
    'purchase', to_regclass('owner_portal.purchase_collaboration') IS NOT NULL,
    'purchaseMigrationLedger', to_regclass('owner_portal.purchase_migration') IS NOT NULL),
  'staffRole', (SELECT json_build_object('role',rolname,'superuser',rolsuper)
    FROM pg_roles WHERE rolname=:'staff'),
  'ownerRole', (SELECT json_build_object('role',rolname,'superuser',rolsuper,'inherits',rolinherit,
    'canReadInternalPurchases',has_table_privilege(oid,'public.purchase','SELECT'),
    'canReadInternalRecords',has_table_privilege(oid,'public.work_record','SELECT'),
    'canReadWorkspace',has_table_privilege(oid,'public.workspace_state','SELECT'))
    FROM pg_roles WHERE rolname=:'owner'));
SELECT to_regclass('owner_portal.purchase_migration') IS NOT NULL AS purchase_ledger \gset
\if :purchase_ledger
SELECT json_build_object('ownerPurchaseMigrations',coalesce(json_object_agg(filename,sha256),'{}'::json))
  FROM owner_portal.purchase_migration;
\endif
COMMIT;
'''


def database_report(staff_role, owner_role=None):
    socket = next((item for item in ('/var/run/postgresql', '/run/postgresql', '/tmp')
                   if (Path(item) / '.s.PGSQL.5432').is_socket()), None)
    if not socket:
        raise PreflightError('未找到正式 PostgreSQL 5432 本机套接字')
    run = subprocess.run(
        ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1',
         '-v', 'staff=' + staff_role, '-v', 'owner=' + (owner_role or ''),
         '-h', socket, '-p', '5432', '-d', APP_DB],
        input=REPORT_SQL.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if run.returncode:
        raise PreflightError('正式库只读查询未完成，需现场核对表结构及 PostgreSQL 本机权限')
    report = {}
    for line in run.stdout.decode('utf-8').splitlines():
        if line.strip():
            report.update(json.loads(line))
    return report


def main():
    values = runtime_values(CONF / 'runtime.env')
    api = fetch('/api/health')
    result = {
        'releasePath': CURRENT.resolve().name,
        'api': {key: api.get(key) for key in ('ok', 'release', 'environment', 'capabilities')},
        'services': {unit: subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0
                     for unit in SERVICES},
        'miniPhotoHealth': fetch('/api/mini-photo/health').get('ok') is True,
        'ownerConfigurationPresent': {name: bool(values.get(name)) for name in OWNER_KEYS},
        'ownerFlags': {name: values.get(name) == '1'
                       for name in ('CHUNMO_OWNER_PORTAL_ENABLED', 'CHUNMO_OWNER_PURCHASE_ENABLED')},
    }
    try:
        staff_role = database_config(values)
        owner_url = urlsplit(values.get('CHUNMO_OWNER_DATABASE_URL', ''))
        owner_role = owner_url.username if (owner_url.hostname == '127.0.0.1' and owner_url.port == 5432
                    and owner_url.path == '/' + APP_DB and re.fullmatch(r'[a-z][a-z0-9_]{1,62}', owner_url.username or '')) else None
        result['database'] = database_report(staff_role, owner_role)
    except (KeyError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        result['database'] = '未核查'
        if isinstance(error, PreflightError):
            result['databaseMessage'] = str(error)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['database'] != '未核查' and api.get('ok') is True else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise SystemExit('预检未完成。请在正式站 Workbench 现场运行。')
