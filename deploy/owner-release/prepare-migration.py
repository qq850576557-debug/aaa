#!/usr/bin/env python3
"""Write the reviewed owner migration or its read-only checks to stdout."""

from hashlib import sha256
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
BASELINE_SHA = 'd77a295fa2fe7fddab16c2bebfd18f8c28dbbcaf11e3c979dbd710e96d46def0'
STEPS = {
    'server/proposed/016_owner_identity.sql': '8c110b96e681c0e5c22b53bc999313db8f6540ea683894a9154cd0721543bcea',
    'server/proposed/016_owner_identity_grants.sql': '04b52e53296e8398f05961afd5019dd8c8aa708107a512ca9268870908abcb8a',
    'server/proposed/017_owner_purchase.sql': '82f113be318eab52b218518fb5dfa8377bfc30d69114819b582244df2ac3b403',
    'server/proposed/017_owner_purchase_grants.sql': 'c127c862a46a673f3eb0f48dc3f96d15c28ab975826d14b4c151045321d084cb',
    'deploy/owner-release/backup-grants.sql': 'df74624064a748a956cbb85aabb3176a969878dcac8f19e8508d493e18d36610',
}


def checked(path, digest):
    data = (ROOT / path).read_bytes()
    if sha256(data).hexdigest() != digest:
        raise ValueError('Migration checksum mismatch: ' + path)
    return data.decode('utf-8')


def guards(base):
    return r'''
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $guard$
BEGIN
  IF current_database() <> 'chunmo_staging' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Unexpected database or maintenance identity';
  END IF;
  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database())
       IS DISTINCT FROM 'cm_stg_migrator' THEN
    RAISE EXCEPTION 'Unexpected database owner';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('cm_stg_migrator','cm_stg_app','cm_stg_backup')
       AND rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) <> 3 THEN
    RAISE EXCEPTION 'Unexpected existing database roles';
  END IF;
  IF (SELECT jsonb_object_agg(name, checksum) FROM public.schema_migration) IS DISTINCT FROM
       $base$''' + base + r'''$base$::jsonb THEN
    RAISE EXCEPTION 'Base migration ledger has changed';
  END IF;
END
$guard$;
'''


def verify(ledger):
    return r'''
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cm_stg_owner_portal'
       AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'cm_stg_owner_portal'::regrole) THEN
    RAISE EXCEPTION 'Unexpected owner runtime role';
  END IF;
  IF NOT has_function_privilege('cm_stg_owner_portal','owner_portal.owner_purchases(text,text)','EXECUTE')
     OR has_database_privilege('cm_stg_owner_portal', current_database(), 'CONNECT')
     OR has_table_privilege('cm_stg_owner_portal','public.purchase','SELECT')
     OR has_table_privilege('cm_stg_owner_portal','public.work_record','SELECT')
     OR has_table_privilege('cm_stg_owner_portal','public.workspace_state','SELECT')
     OR NOT has_table_privilege('cm_stg_backup','owner_portal.purchase_event','SELECT')
     OR has_table_privilege('cm_stg_backup','owner_portal.purchase_event','INSERT') THEN
    RAISE EXCEPTION 'Unexpected owner or backup permissions';
  END IF;
  IF (SELECT jsonb_object_agg(filename, sha256) FROM owner_portal.purchase_migration)
       IS DISTINCT FROM $checks$''' + json.dumps(ledger) + r'''$checks$::jsonb
     OR EXISTS (SELECT 1 FROM owner_portal.project_service)
     OR EXISTS (SELECT 1 FROM owner_portal.member)
     OR EXISTS (SELECT 1 FROM owner_portal.purchase_collaboration) THEN
    RAISE EXCEPTION 'Unexpected owner migration data';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
       AND ((tgrelid = 'public.project'::regclass AND tgname = 'retire_owner_project')
       OR (tgrelid = 'public.purchase'::regclass AND tgname = 'retire_owner_purchase'))) <> 2 THEN
    RAISE EXCEPTION 'Owner project and purchase triggers have changed';
  END IF;
END
$verify$;
'''


def bundle(check=False):
    base = json.dumps(json.loads(checked('deploy/native/approved-migrations.json', BASELINE_SHA)))
    migrations = [checked(path, digest) for path, digest in STEPS.items()]
    ledger = {Path(path).name: digest for path, digest in STEPS.items()}
    if check:
        return r'''\set ON_ERROR_STOP on
BEGIN READ ONLY;
''' + guards(base) + r'''
SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'owner_portal') OR
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cm_stg_owner_portal') AS installed \gset
\if :installed
''' + verify(ledger) + r'''
SELECT 'ready';
\else
SELECT 'absent';
\endif
ROLLBACK;
'''
    entries = ',\n'.join("    ('{}', '{}')".format(name, digest) for name, digest in ledger.items())
    return r'''\set ON_ERROR_STOP on
\set staff_role cm_stg_app
\set owner_role cm_stg_owner_portal
\set backup_role cm_stg_backup
BEGIN;
''' + guards(base) + r'''
SELECT pg_advisory_xact_lock(62109684);
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'owner_portal')
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cm_stg_owner_portal') THEN
    RAISE EXCEPTION 'Owner schema or role already exists, inspect before retrying';
  END IF;
END
$guard$;
CREATE ROLE cm_stg_owner_portal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SET LOCAL ROLE cm_stg_migrator;
''' + '\n'.join(migrations) + '''
INSERT INTO owner_portal.purchase_migration (filename, sha256) VALUES
''' + entries + ';\n' + verify(ledger) + '''
COMMIT;
'''


if __name__ == '__main__':
    if sys.argv[1:] not in ([], ['--check']):
        raise SystemExit('Usage: prepare-migration.py [--check]')
    print(bundle(sys.argv[1:] == ['--check']), end='')
