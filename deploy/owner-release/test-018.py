#!/usr/bin/env python3
"""Run the OWNER-007 schema, permissions and encrypted recovery rehearsal locally."""

import json
import os
from pathlib import Path
from secrets import token_hex
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
os.chdir(ROOT)
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']
NAME = 'chunmo-owner-018-test-' + token_hex(5)


def docker(*args, **kwargs):
    return subprocess.run(DOCKER + list(args), check=True, **kwargs)


def sql(text, ok=True):
    result = subprocess.run(DOCKER + [
        'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'chunmo_staging',
        '-XqAt', '-v', 'ON_ERROR_STOP=1',
    ], input=text, text=True, capture_output=True)
    if ok and result.returncode != 0:
        raise AssertionError(result.stderr)
    if not ok and result.returncode == 0:
        raise AssertionError('Test SQL unexpectedly passed')
    return result.stdout.strip() if ok else result.stderr


def source(path):
    return Path(path).read_text(encoding='utf-8')


def generate(name, *args):
    return subprocess.check_output([
        'python3', '-B', 'deploy/owner-release/' + name, *args,
    ], text=True)


def baseline(roles):
    bindings = []
    for role in roles.values():
        bindings.append("CREATE ROLE {} LOGIN PASSWORD '{}';".format(role['name'], role['password']))
    sql(''.join(bindings) + """
      ALTER DATABASE chunmo_staging OWNER TO cm_stg_migrator;
      REVOKE ALL ON DATABASE chunmo_staging FROM PUBLIC;
      GRANT CONNECT ON DATABASE chunmo_staging TO cm_stg_app,cm_stg_private,cm_stg_backup;
    """)
    migrations = json.loads(source('deploy/native/approved-migrations.json'))
    schema = '\n'.join(source('server/migrations/' + name) for name in sorted(migrations))
    entries = ','.join("('{}','{}')".format(k, v) for k, v in migrations.items())
    sql("""
      BEGIN; SET LOCAL ROLE cm_stg_migrator;
      CREATE TABLE public.schema_migration(name text PRIMARY KEY,checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now());
    """ + schema + 'INSERT INTO public.schema_migration(name,checksum) VALUES ' + entries + """;
      GRANT USAGE ON SCHEMA public TO cm_stg_app, cm_stg_backup;
      GRANT SELECT ON project,purchase,work_record,workspace_state,account,studio_daily TO cm_stg_app;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO cm_stg_backup;
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO cm_stg_backup;
      COMMIT;
    """)
    sql(generate('prepare-migration.py'))
    sql("""
      BEGIN;
      INSERT INTO public.cloud_workspace(id,name,owner_account_id) VALUES ('w','Sandbox','founder');
      INSERT INTO public.account(id,workspace_id,login,password_hash,role) VALUES
        ('founder','w','releasefounder','synthetic','owner'),('employee','w','releaseemployee','synthetic','employee');
      INSERT INTO public.workspace_state VALUES ('w',1,
        '{"projects":[{"id":"p","name":"Home"}],"purchases":[{"id":"item","projectId":"p"}]}','{"records":[]}');
      INSERT INTO public.project VALUES ('w','p','{"name":"Home","status":"施工中"}');
      INSERT INTO public.purchase VALUES ('w','item','p',NULL,'{"name":"Lamp","status":"待采购","due":"2026-12-09"}');
      INSERT INTO public.work_record(workspace_id,id,project_id,project_name,title,status,version,
        created_by,created_name,updated_by,updated_name) VALUES
        ('w','record','p','Home','Retain me','进行中',1,'founder','Test','founder','Test');
      INSERT INTO public.studio_daily VALUES('w',4,
        '{"rules":[],"weekly":[[],[],[],[],[],[],[]],"exceptions":[],"cleaning":"","rotation":{"interval":7,"people":["employee"],"start":"2026-11-15","currentDate":"2026-11-22","position":0,"history":[],"corrections":[]}}',
        'founder',now());
      INSERT INTO owner_portal.purchase_collaboration(workspace_id,project_id,purchase_id,responsibility,
        title,description,specification,quantity,reference,brand,note) VALUES
        ('w','p','item','owner','Lamp','','','','','old brand','old note');
      COMMIT;
    """)


def recovery(roles, port):
    with tempfile.TemporaryDirectory(prefix='chunmo-018-recovery-') as tmp:
        p = Path(tmp)
        cfg = {'id': token_hex(16), 'db': 'chunmo_staging', 'host': '127.0.0.1', 'port': port, 'roles': roles}
        (p / 'control.json').write_text(json.dumps(cfg))
        (p / 'backup.key').write_text(token_hex(32))
        (p / 'runtime.env').write_text('PRIVATE_DATA_KEY=' + token_hex(32))
        for binary in ('pg_dump', 'pg_restore'):
            file = p / binary
            file.write_text('#!/bin/bash\nexec docker --host=unix:///var/run/docker.sock exec -i '
                            '-e PGPASSWORD -e PGUSER -e PGDATABASE -e PGHOST=127.0.0.1 '
                            '-e PGPORT=5432 ' + NAME + ' ' + binary + ' "$@"\n')
            file.chmod(0o700)
        driver = """
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {backup,restoreCheck} from './deploy/native/ops.ts';
const [dir,name]=process.argv.slice(2);
function psql(db,s) {
  return execFileSync('docker',['--host=unix:///var/run/docker.sock','exec','-i',name,
    'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1','-d',db],{input:s,encoding:'utf8'});
}
const archive=await backup(dir,dir,dir+'/pg_dump');
if (!readFileSync(archive).subarray(0,16).toString().startsWith('CHUNMO-BACKUP-1')) throw Error('Encryption header mismatch');
const restored=await restoreCheck(dir,archive,dir+'/pg_restore',(name,c)=>{
  if (!/^chunmo_restorecheck_[0-9]{14}_[a-f0-9]{8}$/.test(name)) throw Error('Unexpected isolated restore identifier');
  psql('postgres','CREATE DATABASE "'+name+'" OWNER '+c.roles.migrator.name+' TEMPLATE template0;');
  psql('postgres','REVOKE ALL ON DATABASE "'+name+'" FROM PUBLIC;');
});
const evidence="SELECT jsonb_build_array((SELECT jsonb_object_agg(filename,sha256) FROM owner_portal.purchase_migration), "+
  "(SELECT to_jsonb(s) FROM public.studio_daily s WHERE workspace_id='w'), "+
  "(SELECT jsonb_agg(to_jsonb(c) ORDER BY purchase_id) FROM owner_portal.purchase_collaboration c));";
if (psql(restored,evidence)!==psql('chunmo_staging',evidence)) throw Error('Owner or studio data differs after real recovery');
const report=JSON.parse(readFileSync(archive+'.restore-verified.json','utf8'));
if (report.database!==restored||!report.countsVerified||!report.privateKeyVerified) throw Error('Recovery report incomplete');
"""
        subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-', str(p), NAME],
                       input=driver, text=True, check=True)


def main():
    docker('run','--rm','--pull=never','-d','--name',NAME,'-p','127.0.0.1::5432',
           '-e','POSTGRES_DB=chunmo_staging','-e','POSTGRES_PASSWORD',
           'postgres:17-alpine', env={**os.environ,'POSTGRES_PASSWORD':token_hex(32)},
           stdout=subprocess.DEVNULL)
    try:
        for _ in range(40):
            ready = subprocess.run(DOCKER+['exec',NAME,'pg_isready','-h','127.0.0.1','-U','postgres'],
                                   capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError('Local PostgreSQL did not become ready')
        roles = {key:{'name':'cm_stg_'+key,'password':token_hex(32)}
                 for key in ('app','backup','private','migrator')}
        baseline(roles)
        check = generate('prepare-018.py','--check')
        apply = generate('prepare-018.py','--apply')
        first = sql(check)
        assert first.endswith('\npending')
        before = sql("SELECT jsonb_agg(to_jsonb(s)) FROM public.studio_daily s")
        sql("ALTER ROLE cm_stg_owner_portal LOGIN;")
        assert 'role membership' in sql(check, ok=False)
        sql("ALTER ROLE cm_stg_owner_portal NOLOGIN;")
        sql("ALTER TABLE owner_portal.purchase_collaboration ADD COLUMN feedback_link text;")
        assert 'without matching ledger' in sql(check, ok=False)
        sql("ALTER TABLE owner_portal.purchase_collaboration DROP COLUMN feedback_link;")
        sql("UPDATE owner_portal.purchase_migration SET sha256=repeat('f',64) WHERE filename='017_owner_purchase.sql';")
        assert 'ledger' in sql(check, ok=False)
        sql("UPDATE owner_portal.purchase_migration SET sha256='82f113be318eab52b218518fb5dfa8377bfc30d69114819b582244df2ac3b403' WHERE filename='017_owner_purchase.sql';")
        assert 'division by zero' in sql(apply.replace('COMMIT;', 'SELECT 1/0;\nCOMMIT;'), ok=False)
        assert sql(check) == first
        port = int(docker('port',NAME,'5432/tcp',capture_output=True,text=True).stdout.strip().rsplit(':',1)[1])
        recovery(roles, port)
        assert 'PASS 018' in sql(apply)
        assert sql(check).replace('\nready','\npending') == first
        assert sql("SELECT jsonb_agg(to_jsonb(s)) FROM public.studio_daily s") == before
        assert sql("SELECT brand||':'||note||':'||published FROM owner_portal.purchase_collaboration") == 'old brand:old note:false'
        assert 'only apply once' in sql(apply, ok=False)
        recovery(roles, port)
        print('PASS 018 SHA guards, partial/role rejection, transactional rollback, repeat protection, unchanged rows, and encrypted pre/post recovery')
    finally:
        docker('stop',NAME,stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
