#!/usr/bin/env python3
"""Emit the fixed production 018 transaction or its read-only preflight."""

import json
from pathlib import Path
import runpy
import sys

legacy = runpy.run_path(str(Path(__file__).with_name('prepare-migration.py')))
checked = legacy['checked']
STEPS = {
    'server/proposed/018_owner_purchase_evidence.sql': 'd562e48c74ab8fd4ed41aeb87d49df8925757adfcc0cad29783ba929063c72b3',
    'server/proposed/018_owner_purchase_evidence_grants.sql': 'bc833575b26f3ea49c58c876be9fe9562e35460dd958e809af98da47c46947de',
}

COUNTS = """SELECT jsonb_build_object(
    'workspaces',(SELECT count(*) FROM public.workspace_state),
    'projects',(SELECT count(*) FROM public.project),
    'purchases',(SELECT count(*) FROM public.purchase),
    'purchaseRecords',(SELECT count(*) FROM public.purchase_record),
    'purchaseHistory',(SELECT count(*) FROM public.purchase_action),
    'records',(SELECT count(*) FROM public.work_record),
    'recordHistory',(SELECT count(*) FROM public.record_history),
    'recordVersions',(SELECT count(*) FROM public.record_version),
    'workspaceHistory',(SELECT count(*) FROM public.workspace_history_revision),
    'employees',(SELECT count(*) FROM public.account WHERE role='employee'),
    'people',(SELECT count(*) FROM public.person),
    'audits',(SELECT count(*) FROM public.audit_event),
    'studioDaily',(SELECT count(*) FROM public.studio_daily),
    'studioReceipts',(SELECT count(*) FROM public.studio_daily_submission),
    'purchasePublications',(SELECT count(*) FROM owner_portal.purchase_collaboration WHERE published),
    'purchaseFeedback',(SELECT count(*) FROM owner_portal.purchase_collaboration),
    'ownerEvents',(SELECT count(*) FROM owner_portal.purchase_event),
    'ownerGrants',(SELECT count(*) FROM owner_portal.project_grant)
)"""

PERMISSIONS = """
DO $permissions$
BEGIN
  IF current_setting('port')<>'5432'
     OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
     OR (SELECT nspowner FROM pg_namespace WHERE nspname='owner_portal')
          IS DISTINCT FROM 'cm_stg_migrator'::regrole::oid
     OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN
       ('cm_stg_owner_portal'::regrole,'cm_stg_app'::regrole,'cm_stg_migrator'::regrole,'cm_stg_backup'::regrole)
       OR roleid='cm_stg_owner_portal'::regrole)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cm_stg_owner_portal'
       AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Unexpected owner schema, PostgreSQL or role membership';
  END IF;
  IF has_database_privilege('cm_stg_owner_portal',current_database(),'CONNECT')
     OR NOT has_function_privilege('cm_stg_owner_portal','owner_portal.owner_purchases(text,text)','EXECUTE')
     OR NOT has_function_privilege('cm_stg_owner_portal',
         'owner_portal.owner_purchase_feedback(text,text,text,uuid,text,text,jsonb)','EXECUTE')
     OR (SELECT bool_or(has_any_column_privilege('cm_stg_owner_portal',n,'SELECT'))
          FROM unnest(ARRAY['public.purchase','public.work_record','public.workspace_state','public.account',
                'owner_portal.purchase_collaboration','owner_portal.purchase_event']) AS t(n))
     OR NOT (SELECT bool_and(has_table_privilege('cm_stg_app',n,'SELECT'))
          FROM unnest(ARRAY['public.project','public.purchase','public.work_record','public.workspace_state',
                'public.account','public.studio_daily','owner_portal.purchase_staff']) AS t(n))
     OR NOT has_table_privilege('cm_stg_app','owner_portal.purchase_collaboration','UPDATE')
     OR NOT has_table_privilege('cm_stg_app','owner_portal.purchase_event','INSERT')
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='owner_portal' AND c.relkind='r'
          AND (NOT has_table_privilege('cm_stg_backup',c.oid,'SELECT')
               OR has_table_privilege('cm_stg_backup',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE'))) THEN
    RAISE EXCEPTION 'Unexpected staff, owner or backup privileges';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
       AND ((tgrelid='public.project'::regclass AND tgname='retire_owner_project')
         OR (tgrelid='public.purchase'::regclass AND tgname='retire_owner_purchase')
         OR (tgrelid='owner_portal.purchase_event'::regclass AND tgname='immutable_owner_purchase_event'))) <> 3 THEN
    RAISE EXCEPTION 'Existing owner authorization or audit triggers changed';
  END IF;
END
$permissions$;
"""

PROJECTION = """
DO $projection$
BEGIN
  IF EXISTS (
    WITH document AS (
      SELECT w.workspace_id, item->>'id' id, item->>'projectId' project_id
      FROM public.workspace_state w
      CROSS JOIN LATERAL jsonb_array_elements(w.data->'purchases') item
    ), index_rows AS (SELECT workspace_id,id,project_id FROM public.purchase)
    (SELECT * FROM document EXCEPT ALL SELECT * FROM index_rows)
    UNION ALL
    (SELECT * FROM index_rows EXCEPT ALL SELECT * FROM document)
  ) THEN
    RAISE EXCEPTION 'Existing purchase document and index differ';
  END IF;
END
$projection$;
"""

READY = """
DO $ready$
BEGIN
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid='owner_portal.purchase_collaboration'::regclass AND NOT attisdropped
         AND attname IN ('feedback_link','feedback_photo')) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_proc
          WHERE oid='owner_portal.owner_purchase_photo(text,text,text,text)'::regprocedure
            AND prosecdef AND proowner='cm_stg_migrator'::regrole
            AND proconfig @> ARRAY['search_path=pg_catalog']
            AND NOT EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0))
     OR NOT has_function_privilege('cm_stg_owner_portal',
         'owner_portal.owner_purchase_photo(text,text,text,text)','EXECUTE')
     OR has_any_column_privilege('cm_stg_owner_portal','owner_portal.purchase_feedback_photo','SELECT')
     OR has_table_privilege('cm_stg_owner_portal','owner_portal.purchase_feedback_photo','INSERT,UPDATE,DELETE,TRUNCATE')
     OR NOT has_table_privilege('cm_stg_app','owner_portal.purchase_feedback_photo','SELECT')
     OR NOT has_table_privilege('cm_stg_backup','owner_portal.purchase_feedback_photo','SELECT')
     OR has_table_privilege('cm_stg_backup','owner_portal.purchase_feedback_photo','INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION '018 tables, function security or grants incomplete';
  END IF;
END
$ready$;
"""


def reject(reason):
    return "DO $$BEGIN RAISE EXCEPTION '{}'; END$$;\n".format(reason)


def bundle(apply=False):
    base = json.dumps(json.loads(checked('deploy/native/approved-migrations.json', legacy['BASELINE_SHA'])))
    for path, digest in legacy['STEPS'].items():
        checked(path, digest)
    assets = [checked(path, digest) for path, digest in STEPS.items()]
    before = {Path(path).name: value for path, value in legacy['STEPS'].items()}
    added = {Path(path).name: value for path, value in STEPS.items()}
    after = {**before, **added}
    ledger = """
SELECT ledger = $old$${OLD}$old$::jsonb AS prior,
       ledger = $new$${NEW}$new$::jsonb AS ready
FROM (SELECT coalesce(jsonb_object_agg(filename,sha256),'{}'::jsonb) ledger
      FROM owner_portal.purchase_migration) AS entries
\\gset
""".replace('${OLD}', json.dumps(before)).replace('${NEW}', json.dumps(after))
    absent = """
DO $absent$
BEGIN
  IF to_regclass('owner_portal.purchase_feedback_photo') IS NOT NULL
     OR to_regprocedure('owner_portal.owner_purchase_photo(text,text,text,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute
        WHERE attrelid='owner_portal.purchase_collaboration'::regclass AND NOT attisdropped
          AND attname IN ('feedback_link','feedback_photo')) THEN
    RAISE EXCEPTION '018 objects without matching ledger; inspect manually';
  END IF;
END
$absent$;
"""
    sql = r'''\set ON_ERROR_STOP on
\set staff_role cm_stg_app
\set owner_role cm_stg_owner_portal
\set backup_role cm_stg_backup
''' + ('BEGIN ISOLATION LEVEL REPEATABLE READ;\n' if apply else 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n')
    sql += legacy['guards'](base)
    if apply:
        sql += 'SELECT pg_advisory_xact_lock(62109684);\n'
    sql += PERMISSIONS + PROJECTION + ledger

    if not apply:
        return (sql + COUNTS + ';\n' + r'\if :prior' + '\n' + absent + "SELECT 'pending';\n"
                + r'\elif :ready' + '\n' + READY + "SELECT 'ready';\n" + r'\else' + '\n'
                + reject('Unexpected or incomplete 016/017/018 ledger') + r'\endif' + '\nROLLBACK;\n')

    entries = ', '.join("('{}','{}')".format(name, digest) for name, digest in added.items())
    return (sql + r'\if :prior' + '\n' + absent + COUNTS + ' AS before_counts \\gset\n'
            + 'SET LOCAL ROLE cm_stg_migrator;\n' + '\n'.join(assets)
            + '\nINSERT INTO owner_portal.purchase_migration(filename,sha256) VALUES ' + entries + ';\n'
            + READY
            + "SELECT (" + COUNTS + ") = :'before_counts'::jsonb AS same_counts \\gset\n"
            + r'\if :same_counts' + '\n' + "SELECT 'PASS 018 and existing row counts';\n"
            + r'\else' + '\n' + reject('018 changed existing row counts') + r'\endif' + '\n'
            + r'\else' + '\n' + reject('018 requires an exact 016/017 baseline and may only apply once')
            + r'\endif' + '\nCOMMIT;\n')


if __name__ == '__main__':
    if sys.argv[1:] not in (['--check'], ['--apply']):
        raise SystemExit('Usage: prepare-018.py --check|--apply')
    print(bundle(sys.argv[1] == '--apply'), end='')
