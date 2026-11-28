"""Check or apply the fixed purchase routines on the managed production database."""

import json
from pathlib import Path
import re
import runpy
import sys

retirement = runpy.run_path(str(Path(__file__).with_name('prepare-021.py')))
baseline = retirement['previous']
MIGRATIONS = [
    ('022_owner_purchase_status.sql', '46e30049d32246456dce864fdc72174e19b08fd9b908691506ed9ee411b6fc23'),
    ('023_owner_purchase_transitions.sql', 'f3cdecaf6e5c7e9cc7bb731c815610118556eaf7a7a8483ac9f41dbe208bbf9d'),
]
FEEDBACK = 'owner_portal.owner_purchase_feedback(text,text,text,uuid,text,text,jsonb)'
TRANSITION = 'owner_portal.purchase_transition(text,boolean,boolean,text,text)'
START = r'''\set ON_ERROR_STOP on
\set staff_role cm_stg_app
'''


def body(source, name):
    found = re.search(r'FUNCTION owner_portal\.' + name + r'\([^;]+? AS \$\$(.*?)\$\$;', source, re.S)
    if not found or '$release_body$' in found[1]:
        raise ValueError('无法确认生产函数定义 ' + name)
    return '$release_body$' + found[1] + '$release_body$'


def readiness(feedback_source, transition_source=None):
    helper = f"to_regprocedure('{TRANSITION}') IS NOT NULL"
    if transition_source:
        helper = f"""
      NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('{TRANSITION}')
        AND NOT prosecdef AND proowner='cm_stg_migrator'::regrole
        AND proconfig @> ARRAY['search_path=pg_catalog']
        AND prosrc={body(transition_source, 'purchase_transition')}
        AND NOT EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0))
      OR NOT has_function_privilege('cm_stg_app','{TRANSITION}','EXECUTE')
      OR has_function_privilege('cm_stg_owner_portal','{TRANSITION}','EXECUTE')
      OR has_function_privilege('cm_stg_owner_runtime','{TRANSITION}','EXECUTE')"""
    return f"""
DO $purchase_release$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('{FEEDBACK}')
     AND prosecdef AND proowner='cm_stg_migrator'::regrole
     AND proconfig @> ARRAY['search_path=pg_catalog']
     AND prosrc={body(feedback_source, 'owner_purchase_feedback')}
     AND NOT EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0))
     OR NOT has_function_privilege('cm_stg_owner_runtime','{FEEDBACK}','EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('owner_portal.purchase_staff')
       AND relowner='cm_stg_migrator'::regrole AND reloptions @> ARRAY['security_barrier=true'])
     OR NOT has_table_privilege('cm_stg_app','owner_portal.purchase_staff','SELECT')
     OR NOT has_table_privilege('cm_stg_app','public.purchase_action','SELECT')
     OR EXISTS (
       SELECT 1 FROM unnest(ARRAY['public.purchase','public.workspace_state','public.purchase_record',
         'owner_portal.purchase_staff','owner_portal.purchase_collaboration','owner_portal.purchase_event']) AS scope(rel)
       WHERE has_any_column_privilege('cm_stg_owner_runtime',rel,'SELECT,INSERT,UPDATE,REFERENCES')
          OR has_table_privilege('cm_stg_owner_runtime',rel,'DELETE,TRUNCATE'))
     OR {helper}
  THEN RAISE EXCEPTION '采购函数、账本或角色隔离与现场预期不符'; END IF;
END
$purchase_release$;
"""


def render(source, apply):
    check = baseline['checked']
    migrations = [check(source / 'server/proposed' / name, digest) for name, digest in MIGRATIONS]
    original_name = '018_owner_purchase_evidence.sql'
    original = check(source / 'server/proposed' / original_name, baseline['OWNER_BASE'][original_name])
    base = json.loads(check(source / 'deploy/native/approved-migrations.json', baseline['BASE']))
    guards = baseline['GUARDS'].replace('BASE_LEDGER', json.dumps(base)).replace(
        'OWNER_LEDGER', json.dumps(baseline['OWNER_BASE'])
    )
    ledger = {**baseline['V21'], retirement['NAME']: retirement['DIGEST']}
    prefix = START + 'BEGIN ISOLATION LEVEL REPEATABLE READ'
    prefix += ';\n' if apply else ' READ ONLY;\n'
    if apply:
        prefix += "SET LOCAL lock_timeout='3s'; SELECT pg_advisory_xact_lock(62109684);\n"
    sql = prefix + guards + retirement['READY'] + r"""
SELECT EXISTS(SELECT 1 FROM owner_portal.v21_migration WHERE name='022_owner_purchase_status.sql') AS status_installed,
       EXISTS(SELECT 1 FROM owner_portal.v21_migration WHERE name='023_owner_purchase_transitions.sql') AS transitions_installed
\gset
\if :transitions_installed
""" + retirement['v21_ready']({**ledger, **dict(MIGRATIONS)}) + readiness(migrations[1], migrations[1]) + r"""
\else
\if :status_installed
""" + retirement['v21_ready']({**ledger, **dict(MIGRATIONS[:1])}) + readiness(migrations[0]) + r"""
\else
""" + retirement['v21_ready'](ledger) + readiness(original) + '\\endif\n\\endif\n'
    if not apply:
        return sql + r'''\if :transitions_installed
SELECT 'ready';
\else
SELECT 'pending';
\endif
ROLLBACK;
'''
    counts = retirement['COUNTS']
    sql += counts + ' AS before_counts \\gset\n'
    for index, ((name, digest), migration) in enumerate(zip(MIGRATIONS, migrations)):
        installed = ('status_installed', 'transitions_installed')[index]
        sql += (
            '\\if :' + installed + '\n\\else\n'
            + 'SET LOCAL ROLE cm_stg_migrator;\n' + migration + '\n'
            + "INSERT INTO owner_portal.v21_migration(name,checksum) VALUES ('{}','{}');\n".format(name, digest)
            + 'RESET ROLE;\n\\endif\n'
        )
    return (
        sql + retirement['v21_ready']({**ledger, **dict(MIGRATIONS)})
        + readiness(migrations[1], migrations[1])
        + 'SELECT (' + counts + ") = :'before_counts'::jsonb AS preserved \\gset\n"
        + r'''\if :preserved
SELECT 'ready';
\else
DO $$BEGIN RAISE EXCEPTION '022/023 改变了存量业务行数'; END$$;
\endif
COMMIT;
'''
    )


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('--check', '--apply'):
        raise SystemExit('用法 prepare-023.py --check|--apply 固定候选目录')
    print(render(Path(sys.argv[2]), sys.argv[1] == '--apply'), end='')
