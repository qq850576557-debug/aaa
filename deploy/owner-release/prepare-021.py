"""Render the production 021 transaction or its read-only verification."""
import json
from pathlib import Path
import runpy
import sys


previous = runpy.run_path(str(Path(__file__).with_name('prepare-v21.py')))
NAME = '021_account_retirement.sql'
DIGEST = '598a3af4f31670f55358755c441e4036273ca57f0bff1148b00a0fd45ac973ea'

ABSENT = """
DO $absent$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN
      ('public.account'::regclass,'owner_portal.member'::regclass)
      AND attname='deleted_at' AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE
         (conrelid='public.account'::regclass AND conname='retired_employee_inactive') OR
         (conrelid='owner_portal.member'::regclass AND conname='retired_owner_unbound'))
     OR COALESCE(strpos(pg_get_viewdef('owner_portal.available_project'::regclass,true),
                 'deleted_at'),0)>0
  THEN RAISE EXCEPTION '021 对象已存在但没有正式账本记录'; END IF;
END
$absent$;
"""

READY = """
DO $retirement$
BEGIN
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid IN
          ('public.account'::regclass,'owner_portal.member'::regclass) AND attname='deleted_at'
          AND NOT (attisdropped OR attnotnull OR atthasdef) AND atttypid='timestamptz'::regtype)<>2
     OR (SELECT count(*) FROM pg_constraint WHERE contype='c' AND convalidated AND (
          (conrelid='public.account'::regclass AND conname='retired_employee_inactive') OR
          (conrelid='owner_portal.member'::regclass AND conname='retired_owner_unbound')))<>2
     OR COALESCE(strpos(pg_get_viewdef('owner_portal.available_project'::regclass,true),
                'm.deleted_at IS NULL'),0)=0
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='owner_portal.available_project'::regclass
          AND relowner='cm_stg_migrator'::regrole AND reloptions @> ARRAY['security_barrier=true'])
     OR NOT has_table_privilege('cm_stg_owner_portal','owner_portal.available_project','SELECT')
     OR has_column_privilege('cm_stg_owner_portal','owner_portal.member','deleted_at','UPDATE')
  THEN RAISE EXCEPTION '021 结构或业主授权隔离检查失败'; END IF;
END
$retirement$;
"""

COUNTS = previous['COUNTS'] + """ || jsonb_build_object(
    'project_permissions',(SELECT count(*) FROM public.project_permission),
    'employee_sessions',(SELECT count(*) FROM public.auth_session),
    'employee_bindings',(SELECT count(*) FROM public.employee_wechat_binding),
    'employee_avatars',(SELECT count(*) FROM public.account_avatar),
    'owner_services',(SELECT count(*) FROM owner_portal.project_service),
    'owner_sessions',(SELECT count(*) FROM owner_portal.session),
    'owner_invites',(SELECT count(*) FROM owner_portal.invite),
    'owner_purchase_events',(SELECT count(*) FROM owner_portal.purchase_event),
    'owner_purchase_photos',(SELECT count(*) FROM owner_portal.purchase_feedback_photo),
    'owner_designs',(SELECT count(*) FROM owner_portal.project_design),
    'record_history',(SELECT count(*) FROM public.record_history),
    'purchase_actions',(SELECT count(*) FROM public.purchase_action),
    'audit',(SELECT count(*) FROM public.audit_event)
)"""

VIEW_IDENTITY = """SELECT jsonb_build_array(oid, relowner, relacl, reloptions)
FROM pg_class WHERE oid='owner_portal.available_project'::regclass"""


def v21_ready(ledger):
    return previous['READY'].replace('V21_LEDGER', json.dumps(ledger))


def render(source, apply):
    checked = previous['checked']
    migration = checked(source / 'server/proposed' / NAME, DIGEST)
    base = json.loads(checked(source / 'deploy/native/approved-migrations.json', previous['BASE']))
    ledger = previous['V21']
    with_021 = {**ledger, NAME: DIGEST}
    guards = previous['GUARDS'].replace('BASE_LEDGER', json.dumps(base)).replace(
        'OWNER_LEDGER', json.dumps(previous['OWNER_BASE'])
    )
    sql = '\\set ON_ERROR_STOP on\nBEGIN ISOLATION LEVEL REPEATABLE READ'
    sql += ';\nSET LOCAL lock_timeout=\'3s\'; SELECT pg_advisory_xact_lock(62109684);\n' if apply else ' READ ONLY;\n'
    sql += guards + r"""
SELECT EXISTS(SELECT 1 FROM owner_portal.v21_migration WHERE name='021_account_retirement.sql') AS applied \gset
\if :applied
""" + v21_ready(with_021) + READY + "SELECT 'ready';\n\\else\n"
    sql += v21_ready(ledger) + ABSENT
    if apply:
        sql += (
            COUNTS + ' AS before_counts \\gset\n'
            + 'SELECT (' + VIEW_IDENTITY + ') AS before_view \\gset\n'
            + 'SET LOCAL ROLE cm_stg_migrator;\n' + migration + '\n'
            + "INSERT INTO owner_portal.v21_migration(name,checksum) VALUES ('{}','{}');\n".format(NAME, DIGEST)
            + 'RESET ROLE;\n' + v21_ready(with_021) + READY
            + 'SELECT (' + COUNTS + ") = :'before_counts'::jsonb AND ("
            + VIEW_IDENTITY + ") = :'before_view'::jsonb AS preserved \\gset\n"
            + r"""
\if :preserved
SELECT 'ready';
\else
DO $$BEGIN RAISE EXCEPTION '021 改变了业务数据数量或现有授权视图身份'; END$$;
\endif
"""
        )
    else:
        sql += "SELECT 'pending';\n"
    return sql + '\\endif\n' + ('COMMIT;\n' if apply else 'ROLLBACK;\n')


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('--check', '--apply'):
        raise SystemExit('用法 prepare-021.py --check|--apply 固定候选目录')
    print(render(Path(sys.argv[2]), sys.argv[1] == '--apply'), end='')
