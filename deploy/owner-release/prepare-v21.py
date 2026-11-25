"""Render an idempotent production V2.1 add-only migration and read-only checks."""
from hashlib import sha256
import json
from pathlib import Path
import sys

V21 = {
    '019_employee_wechat.sql': 'fe894c57915e563f699fcfe175b47da152c20208d2709ac758dc89b765debdf9',
    '019_employee_wechat_grants.sql': 'dbf2af4cce8163e9112a0c86b8d53068bc4f5395482b641abd9d9054fcd4abee',
    '020_owner_design.sql': '0f90870559c6cc9d6efc42c1967da29df170971220c4529281868e63ab5a654b',
    '020_owner_design_grants.sql': '6599c8924e7d4ac6a12d29385dcb4f4872b7759135d57174d67c5f65cd987bd6',
}
BASE = 'd77a295fa2fe7fddab16c2bebfd18f8c28dbbcaf11e3c979dbd710e96d46def0'
OWNER_BASE = {
    '016_owner_identity.sql': '8c110b96e681c0e5c22b53bc999313db8f6540ea683894a9154cd0721543bcea',
    '016_owner_identity_grants.sql': '04b52e53296e8398f05961afd5019dd8c8aa708107a512ca9268870908abcb8a',
    '017_owner_purchase.sql': '82f113be318eab52b218518fb5dfa8377bfc30d69114819b582244df2ac3b403',
    '017_owner_purchase_grants.sql': 'c127c862a46a673f3eb0f48dc3f96d15c28ab975826d14b4c151045321d084cb',
    '018_owner_purchase_evidence.sql': 'd562e48c74ab8fd4ed41aeb87d49df8925757adfcc0cad29783ba929063c72b3',
    '018_owner_purchase_evidence_grants.sql': 'bc833575b26f3ea49c58c876be9fe9562e35460dd958e809af98da47c46947de',
    'backup-grants.sql': 'df74624064a748a956cbb85aabb3176a969878dcac8f19e8508d493e18d36610',
}

GUARDS = """
SET LOCAL search_path=public,pg_catalog;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$
BEGIN
  IF current_database()<>'chunmo_staging' OR current_user<>'postgres'
     OR current_setting('port')<>'5432'
     OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
     OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())<>'cm_stg_migrator'
     OR (SELECT nspowner FROM pg_namespace WHERE nspname='owner_portal') IS DISTINCT FROM 'cm_stg_migrator'::regrole::oid
     OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('cm_stg_app','cm_stg_migrator','cm_stg_backup')
         AND rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))<>3
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cm_stg_owner_portal'
         AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
         WHERE (m.roleid='cm_stg_owner_portal'::regrole
                AND (r.rolname<>'cm_stg_owner_runtime' OR m.admin_option OR m.set_option OR NOT m.inherit_option))
            OR r.rolname IN ('cm_stg_owner_portal','cm_stg_app','cm_stg_migrator','cm_stg_backup')
            OR (r.rolname='cm_stg_owner_runtime' AND m.roleid<>'cm_stg_owner_portal'::regrole))
  THEN RAISE EXCEPTION 'V2.1 正式库身份或角色不匹配'; END IF;
  IF (SELECT jsonb_object_agg(name,checksum) FROM public.schema_migration)
        IS DISTINCT FROM $base$BASE_LEDGER$base$::jsonb
     OR (SELECT jsonb_object_agg(filename,sha256) FROM owner_portal.purchase_migration)
        IS DISTINCT FROM $owner$OWNER_LEDGER$owner$::jsonb
     OR NOT has_function_privilege('cm_stg_owner_portal','owner_portal.owner_purchase_photo(text,text,text,text)','EXECUTE')
     OR NOT has_table_privilege('cm_stg_backup','owner_portal.purchase_feedback_photo','SELECT')
     OR (SELECT bool_or(has_any_column_privilege('cm_stg_owner_portal',r,'SELECT'))
           FROM unnest(ARRAY['public.purchase','public.work_record','public.workspace_state','public.account']) AS scopes(r))
  THEN RAISE EXCEPTION 'V2.1 基础迁移、旧业主权限或备份授权不匹配'; END IF;
END
$guard$;
"""

EMPTY = """
DO $empty$
BEGIN
  IF to_regclass('public.employee_wechat_binding') IS NOT NULL
     OR to_regclass('owner_portal.project_design') IS NOT NULL
     OR to_regprocedure('public.clear_employee_wechat_on_credential_change()') IS NOT NULL
     OR to_regprocedure('public.retire_employee_project_permission()') IS NOT NULL
     OR to_regprocedure('owner_portal.authorized_design(text,text)') IS NOT NULL
  THEN RAISE EXCEPTION 'V2.1 对象已存在但缺少发布账本'; END IF;
END
$empty$;
"""

READY = """
DO $ready$
BEGIN
  IF (SELECT jsonb_object_agg(name,checksum) FROM owner_portal.v21_migration)
        IS DISTINCT FROM $v21$V21_LEDGER$v21$::jsonb
     OR (SELECT count(*) FROM pg_class WHERE oid IN (
             'owner_portal.v21_migration'::regclass,'public.employee_wechat_binding'::regclass,'owner_portal.project_design'::regclass
           ) AND relowner='cm_stg_migrator'::regrole)<>3
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
          AND ((tgrelid='public.account'::regclass AND tgname='clear_employee_wechat_on_credential_change') OR
               (tgrelid='public.project'::regclass AND tgname='retire_employee_project_permission')))<>2
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='owner_portal.authorized_design(text,text)'::regprocedure
                    AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog']
                    AND proowner='cm_stg_migrator'::regrole
                    AND NOT EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0))
     OR NOT (SELECT bool_and(has_table_privilege('cm_stg_app','public.employee_wechat_binding',p))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privileges(p))
     OR NOT (SELECT bool_and(has_table_privilege('cm_stg_app','owner_portal.project_design',p))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE']) AS privileges(p))
     OR NOT has_function_privilege('cm_stg_owner_portal','owner_portal.authorized_design(text,text)','EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_class WHERE oid IN (
             'owner_portal.v21_migration'::regclass,'public.employee_wechat_binding'::regclass,'owner_portal.project_design'::regclass
           ) AND (has_any_column_privilege('cm_stg_owner_portal',oid,'SELECT')
                OR has_table_privilege('cm_stg_owner_portal',oid,'INSERT,UPDATE,DELETE,TRUNCATE')
                OR NOT has_table_privilege('cm_stg_backup',oid,'SELECT')
                OR has_table_privilege('cm_stg_backup',oid,'INSERT,UPDATE,DELETE,TRUNCATE')))
  THEN RAISE EXCEPTION 'V2.1 账本、对象或隔离权限核验失败'; END IF;
END
$ready$;
"""

COUNTS = """SELECT jsonb_build_object(
    'projects',(SELECT count(*) FROM public.project),
    'purchases',(SELECT count(*) FROM public.purchase),
    'records',(SELECT count(*) FROM public.work_record),
    'accounts',(SELECT count(*) FROM public.account),
    'history',(SELECT count(*) FROM public.workspace_history_revision),
    'studio',(SELECT count(*) FROM public.studio_daily),
    'owners',(SELECT count(*) FROM owner_portal.member),
    'grants',(SELECT count(*) FROM owner_portal.project_grant),
    'purchases_shared',(SELECT count(*) FROM owner_portal.purchase_collaboration)
)"""


def checked(path, digest):
    raw = path.read_bytes()
    if sha256(raw).hexdigest() != digest:
        raise ValueError('迁移 SHA-256 不匹配 ' + path.name)
    return raw.decode()


def render(release, apply):
    base = json.dumps(json.loads(checked(release / 'deploy/native/approved-migrations.json', BASE)))
    guards = GUARDS.replace('BASE_LEDGER', base).replace('OWNER_LEDGER', json.dumps(OWNER_BASE))
    ready = READY.replace('V21_LEDGER', json.dumps(V21))
    files = [checked(release / 'server/proposed' / name, sha) for name, sha in V21.items()]
    sql = r'''\set ON_ERROR_STOP on
\set staff_role cm_stg_app
\set owner_role cm_stg_owner_portal
'''
    sql += 'BEGIN ISOLATION LEVEL REPEATABLE READ' + (';\n' if apply else ' READ ONLY;\n')
    if apply:
        sql += "SET LOCAL lock_timeout='3s'; SELECT pg_advisory_xact_lock(62109684);\n"
    sql += guards + r"""
SELECT (to_regclass('owner_portal.v21_migration') IS NOT NULL) AS v21_applied \gset
\if :v21_applied
""" + ready + "SELECT 'ready';\n" + r'\else' + '\n' + EMPTY
    if apply:
        rows = ','.join("('{}','{}')".format(*pair) for pair in V21.items())
        sql += (
            COUNTS + ' AS before_counts \\gset\n'
            + 'SET LOCAL ROLE cm_stg_migrator;\n'
            + '\n'.join(files)
            + '''
CREATE TABLE owner_portal.v21_migration(name text PRIMARY KEY, checksum text NOT NULL);
REVOKE ALL ON owner_portal.v21_migration FROM PUBLIC;
GRANT SELECT ON public.employee_wechat_binding, owner_portal.project_design,
  owner_portal.v21_migration TO cm_stg_backup;
INSERT INTO owner_portal.v21_migration VALUES ''' + rows + ';\nRESET ROLE;\n'
            + ready
            + 'SELECT (' + COUNTS + ") = :'before_counts'::jsonb AS preserved \\gset\n"
            + r"""
\if :preserved
SELECT 'ready';
\else
DO $$BEGIN RAISE EXCEPTION 'V2.1 已有业务数据数量变化'; END$$;
\endif
"""
        )
    else:
        sql += "SELECT 'pending';\n"
    return sql + r'\endif' + ('\nCOMMIT;\n' if apply else '\nROLLBACK;\n')


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('--check', '--apply'):
        raise SystemExit('用法 prepare-v21.py --check|--apply 固定发布目录')
    print(render(Path(sys.argv[2]), sys.argv[1] == '--apply'), end='')
