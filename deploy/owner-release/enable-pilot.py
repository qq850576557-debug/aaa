"""Enable the already installed owner portal for a founder-managed pilot."""

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


CONF = Path('/etc/chunmo-staging')
CURRENT = Path('/opt/chunmo-staging/current')
UNIT = 'chunmo-staging-api'
OWNER = 'cm_stg_owner_runtime'
APP_ID = 'wxb48a7abb3858a252'
SUPPORTED = {
    '8bbd1e818981d9d405dfbac8bc9a581768b648af',
    '6aef816bd4a4e541dcf6425843050080d288aac4',
}
FLAGS = ('CHUNMO_OWNER_PORTAL_ENABLED', 'CHUNMO_OWNER_PURCHASE_ENABLED')
REQUIRED_RECEIPTS = (
    ('018_owner_purchase_evidence.sql', 'd562e48c74ab8fd4ed41aeb87d49df8925757adfcc0cad29783ba929063c72b3'),
    ('018_owner_purchase_evidence_grants.sql', 'bc833575b26f3ea49c58c876be9fe9562e35460dd958e809af98da47c46947de'),
)
MANAGED_HBA = ('# BEGIN CHUNMO STAGING MANAGED\n'
               'host chunmo_staging all 127.0.0.1/32 scram-sha-256\n'
               'host chunmo_staging all ::1/128 scram-sha-256\n'
               '# END CHUNMO STAGING MANAGED\n')
OWNER_HBA = ('# BEGIN CHUNMO OWNER PILOT\n'
             'local all cm_stg_owner_runtime reject\n'
             'host all cm_stg_owner_runtime all reject\n'
             '# END CHUNMO OWNER PILOT\n')
ROLE_CHECK = """
SELECT current_database() = 'chunmo_staging'
  AND current_user = 'cm_stg_owner_runtime'
  AND pg_has_role(current_user, 'cm_stg_owner_portal', 'USAGE')
  AND has_function_privilege(current_user,'owner_portal.owner_purchases(text,text)','EXECUTE')
  AND has_function_privilege(current_user,'owner_portal.owner_purchase_photo(text,text,text,text)','EXECUTE')
  AND has_table_privilege(current_user,'owner_portal.available_project','SELECT')
  AND NOT has_any_column_privilege(current_user,'owner_portal.purchase_feedback_photo','SELECT')
  AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND
      (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND (has_any_column_privilege(current_user,c.oid,'SELECT')
        OR has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE'))
  );
"""


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(args, data=None, env=None, timeout=15):
    return subprocess.run(args, input=data, env=env, timeout=timeout,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)


def result(args, message, data=None):
    proc = run(args, data=data)
    check(proc.returncode == 0, message)
    return proc.stdout.strip()


def env_values(text):
    values = {}
    for line in text.splitlines():
        if '=' not in line or line.lstrip().startswith('#'):
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        check(key not in values, '配置中有重复选项')
        values[key] = value.strip().strip('"\'')
    return values


def protected(path):
    check(path.is_file() and not path.is_symlink(), '找不到有效服务器私有配置')
    mode = path.stat()
    check(mode.st_uid == 0 and not (mode.st_mode & 0o077), '服务器私有配置权限不正确')
    return path.read_text(encoding='utf-8')


def site(path):
    return ['curl', '-sS', '--noproxy', '*', '--proto', '=https',
            '--resolve', 'chmsj.cn:443:127.0.0.1', '--max-time', '5', 'https://chmsj.cn' + path]


def site_health(sha, enabled):
    health = json.loads(result(site('/api/health'), '正式 API 健康检查失败'))
    check((health.get('ok'), health.get('environment'), health.get('release')) ==
          (True, 'production', sha), '正式 API 版本或环境不匹配')
    features = health.get('capabilities', {})
    check(features.get('studioDaily') is True and (features.get('ownerPurchases') is True) == enabled,
          '正式 API 功能状态与预期不一致')
    for path in ('/api/mini-photo/health', '/api/mini-photo-candidate/health'):
        data = json.loads(result(site(path), '员工拍照服务检查失败'))
        check(data.get('ok') is True, '员工拍照服务检查失败')
        if 'candidate' in path:
            check('workbench-v1' in data.get('features', []), '员工工作台服务未就绪')
    status = result(site('/api/mini-owner/v1/session') + ['-o', '/dev/null', '-w', '%{http_code}'],
                    '业主入口检查失败')
    check(status == ('401' if enabled else '404'), '业主入口匿名访问状态不符')
    if enabled:
        status = result(site('/api/mini-employee/v1/resume') + [
            '-H', 'Content-Type: application/json', '--data', '{}', '-o', '/dev/null', '-w', '%{http_code}',
        ], '员工自动登录入口检查失败')
        check(status == '403', '员工自动登录配置或来源校验不符')


def wait_health(sha, enabled):
    for attempt in range(12):
        try:
            site_health(sha, enabled)
            return
        except (RuntimeError, subprocess.SubprocessError, ValueError):
            if attempt == 11:
                raise
            time.sleep(1)


def db(args, sql):
    return result(args, '正式库或角色检查失败', data=sql)


def project_check(args, name):
    # The caller provides the exact authorized name; remove display spacing only.
    expr = "convert_from(decode('{}','hex'),'UTF8')".format(''.join(name.split()).encode().hex())
    matched = "regexp_replace(payload->>'name','[[:space:]]+','','g')=" + expr
    count = db(args, 'SELECT count(*) FROM public.project WHERE ' + matched + ';')
    check(count == '1', '正式站未找到唯一匹配的试点项目，请从项目编辑里复制完整项目名称')
    count = db(args, """
SELECT count(*) FROM owner_portal.project_service s
WHERE s.enabled AND NOT EXISTS (
  SELECT 1 FROM public.project p
  WHERE p.workspace_id=s.workspace_id AND p.id=s.project_id AND {}
);""".format(matched))
    check(count == '0', '已有其它住宅开启服务，先核对本次试点范围')


def scram_verifier(password):
    def b64(value):
        return base64.b64encode(value).decode('ascii')

    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac('sha256', password.encode('ascii'), salt, 4096)
    key = lambda name: hmac.new(salted, name, hashlib.sha256).digest()
    return 'SCRAM-SHA-256$4096:{}${}:{}'.format(
        b64(salt), b64(hashlib.sha256(key(b'Client Key')).digest()), b64(key(b'Server Key')))


def replace_from(path, source):
    fd, temporary = tempfile.mkstemp(prefix='.owner-pilot.', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(source.read_bytes())
            output.flush()
            os.fsync(output.fileno())
        meta = path.stat()
        os.chown(temporary, meta.st_uid, meta.st_gid)
        shutil.copystat(str(path), temporary)
        os.chmod(temporary, stat.S_IMODE(meta.st_mode))
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verify_owner(psql, password):
    env = {'PATH': os.environ['PATH'], 'PGPASSWORD': password, 'PGCONNECT_TIMEOUT': '4', 'LC_ALL': 'C'}
    args = [psql, '-XqAtw', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '5432', '-U', OWNER]
    app = run(args + ['-d', 'chunmo_staging'], data=ROLE_CHECK, env=env)
    check(app.returncode == 0 and app.stdout.strip() == 't', '业主登录角色未通过实际权限检查')
    other = run(args + ['-d', 'postgres'], data='SELECT 1;', env=env)
    check(other.returncode != 0 and 'pg_hba.conf rejects connection' in other.stderr,
          '业主账号未通过其他数据库隔离检查')


def database_tools():
    psql = shutil.which('psql', path='/usr/pgsql-17/bin:/usr/local/bin:/usr/bin:/bin')
    check(psql is not None, '找不到 PostgreSQL 17 客户端')
    socket = next((p for p in ('/var/run/postgresql', '/run/postgresql', '/tmp')
                   if (Path(p) / '.s.PGSQL.5432').is_socket()), None)
    check(socket is not None, '未发现正式库本机套接字')
    args = ['runuser', '-u', 'postgres', '--', 'env', '-i',
            'PATH=/usr/pgsql-17/bin:/usr/local/bin:/usr/bin:/bin', 'LC_ALL=C',
            psql, '-XqAtw', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1',
            '-h', socket, '-p', '5432', '-d', 'chunmo_staging']
    return psql, args


def activation_secret():
    for path in (Path('/etc/chunmo-mini-workbench.env'), Path('/etc/chunmo-mini-photo.env')):
        if path.is_file():
            existing = env_values(protected(path))
            secret = existing.get('CHUNMO_MINI_APP_SECRET', '')
            if existing.get('CHUNMO_MINI_APP_ID') == APP_ID and re.fullmatch(r'[a-fA-F0-9]{32}', secret):
                return secret
    raise RuntimeError('找不到同一 AppID 的现用员工小程序凭据')


def activate(name):
    sha = CURRENT.resolve().name
    check(sha in SUPPORTED and (CURRENT / '.verified-build').read_text().strip() == sha,
          '正式版本没有包含本次小程序后端')
    runtime = CONF / 'runtime.env'
    original = protected(runtime)
    values = env_values(original)
    staff = urlsplit(values['DATABASE_URL'])
    check(values.get('APP_ENV') == 'production' and values.get('APP_ORIGIN') == 'https://chmsj.cn'
          and (staff.username, staff.hostname, staff.port, staff.path) ==
          ('cm_stg_app', '127.0.0.1', 5432, '/chunmo_staging'), '正式环境边界校验失败')
    psql, args = database_tools()
    project_check(args, name)
    hashes = ','.join("('{}','{}')".format(*pair) for pair in REQUIRED_RECEIPTS)
    check(db(args, """SELECT count(*) FROM owner_portal.purchase_migration
        WHERE (filename,sha256) IN ({});""".format(hashes)) == '2',
          '正式库未完成 018')
    if all(values.get(flag) == '1' for flag in FLAGS):
        owner = urlsplit(values['CHUNMO_OWNER_DATABASE_URL'])
        check((owner.username, owner.hostname, owner.port, owner.path) ==
              (OWNER, '127.0.0.1', 5432, '/chunmo_staging') and owner.password,
              '已有业主配置与本次试点不一致')
        verify_owner(psql, owner.password)
        site_health(sha, True)
        print('PASS 正式业主入口已就绪，项目授权在网页办理。')
        return

    group_ready = db(args, """
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cm_stg_owner_portal'
  AND NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cm_stg_owner_runtime');
""")
    check(group_ready == 't' and not any(key.startswith('CHUNMO_OWNER_') and key not in FLAGS
                                        for key in values)
          and all(values.get(key, '0') == '0' for key in FLAGS),
          '已有部分业主配置，需核对后继续')
    site_health(sha, False)

    credential = activation_secret()
    if values.get('CHUNMO_MINI_APP_ID') or values.get('CHUNMO_MINI_APP_SECRET'):
        check(values.get('CHUNMO_MINI_APP_ID') == APP_ID and values.get('CHUNMO_MINI_APP_SECRET') == credential,
              '正式 API 的员工微信配置与当前 AppID 不一致')
    hba = Path(db(args, 'SHOW hba_file;'))
    check(hba.is_absolute() and hba.is_file() and not hba.is_symlink(), 'PostgreSQL 认证配置路径无效')
    hba_text = hba.read_text(encoding='utf-8')
    check(hba_text.startswith(MANAGED_HBA) and OWNER not in hba_text, 'PostgreSQL 认证规则与已知模板不一致')

    backup = Path(tempfile.mkdtemp(prefix='owner-pilot.', dir=str(CONF)))
    shutil.copy2(str(runtime), str(backup / 'runtime.before'))
    shutil.copy2(str(hba), str(backup / 'hba.before'))
    password = secrets.token_hex(32)
    packed = dict(zip(FLAGS, ('1', '1')))
    packed.update(
        CHUNMO_OWNER_DATABASE_URL='postgresql://{}:{}@127.0.0.1:5432/chunmo_staging'.format(OWNER, password),
        CHUNMO_OWNER_DATA_KEY=secrets.token_hex(32),
        CHUNMO_OWNER_WECHAT_APP_ID=APP_ID,
        CHUNMO_OWNER_WECHAT_APP_SECRET=credential,
    )
    lines = [line for line in original.splitlines() if line.split('=', 1)[0].strip() not in FLAGS]
    lines.extend('{}={}'.format(key, value) for key, value in packed.items())
    (backup / 'runtime.next').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    (backup / 'hba.next').write_text(MANAGED_HBA + OWNER_HBA + hba_text[len(MANAGED_HBA):], encoding='utf-8')
    for path in (backup / 'runtime.next', backup / 'hba.next'):
        path.chmod(0o600)

    hba_changed = role_created = runtime_changed = False
    try:
        replace_from(hba, backup / 'hba.next')
        hba_changed = True
        check(db(args, 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;') == '0',
              'PostgreSQL 认证规则校验失败')
        check(db(args, 'SELECT pg_reload_conf();') == 't', '加载 PostgreSQL 认证规则失败')
        db(args, """
BEGIN;
CREATE ROLE cm_stg_owner_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '{}';
GRANT CONNECT ON DATABASE chunmo_staging TO cm_stg_owner_runtime;
GRANT cm_stg_owner_portal TO cm_stg_owner_runtime WITH INHERIT TRUE, SET FALSE;
COMMIT;
""".format(scram_verifier(password)))
        role_created = True
        verify_owner(psql, password)
        replace_from(runtime, backup / 'runtime.next')
        runtime_changed = True
        result(['systemctl', 'restart', UNIT], '正式 API 重载失败')
        wait_health(sha, True)
        project_check(args, name)
    except (Exception, KeyboardInterrupt):
        try:
            if runtime_changed:
                replace_from(runtime, backup / 'runtime.before')
                result(['systemctl', 'restart', UNIT], '恢复原 API 配置后服务启动失败')
            if role_created:
                db(args, """BEGIN;
ALTER ROLE cm_stg_owner_runtime NOLOGIN PASSWORD NULL;
REVOKE cm_stg_owner_portal FROM cm_stg_owner_runtime;
REVOKE CONNECT ON DATABASE chunmo_staging FROM cm_stg_owner_runtime;
DROP ROLE cm_stg_owner_runtime;
COMMIT;""")
            if hba_changed:
                replace_from(hba, backup / 'hba.before')
                check(db(args, 'SELECT pg_reload_conf();') == 't', '原认证配置重载失败')
            if runtime_changed:
                wait_health(sha, False)
            print('已回到原配置，备份目录 {}'.format(backup), file=sys.stderr)
        except Exception:
            print('FAIL 自动恢复需现场复核，备份目录 {}'.format(backup), file=sys.stderr)
        raise
    finally:
        for transient in (backup / 'runtime.next', backup / 'hba.next'):
            transient.unlink()
    print('PASS 正式业主入口已就绪，项目授权在网页办理。')
    print('配置备份目录 {}'.format(backup))


if __name__ == '__main__':
    def stop(_signum, _frame):
        raise KeyboardInterrupt

    for received in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(received, stop)
    try:
        activate(sys.argv[1])
    except RuntimeError as error:
        raise SystemExit('FAIL ' + str(error))
    except (OSError, subprocess.SubprocessError, KeyError, ValueError, IndexError, KeyboardInterrupt):
        raise SystemExit('FAIL 正式试点配置未完成，请核对服务器状态及配置备份。')
