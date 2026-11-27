"""Exercise the production 021 SQL on an isolated PostgreSQL 17 deployment."""
import os
from pathlib import Path
import runpy
from secrets import token_hex
import subprocess
import time


ROOT = Path(__file__).resolve().parents[2]
lab = runpy.run_path(str(Path(__file__).with_name('test-018.py')))
docker, sql, generate = (lab[name] for name in ('docker', 'sql', 'generate'))
container = 'chunmo-021-test-' + token_hex(5)
sql.__globals__['NAME'] = container


BUSINESS = """
SELECT jsonb_build_array(
  (SELECT jsonb_agg(to_jsonb(a)-'deleted_at' ORDER BY id) FROM public.account a),
  (SELECT jsonb_agg(to_jsonb(b) ORDER BY account_id) FROM public.employee_wechat_binding b),
  (SELECT jsonb_agg(to_jsonb(m)-'deleted_at' ORDER BY id) FROM owner_portal.member m),
  (SELECT jsonb_agg(to_jsonb(g) ORDER BY member_id) FROM owner_portal.project_grant g),
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY purchase_id) FROM owner_portal.purchase_collaboration c),
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.work_record r),
  (SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM owner_portal.available_project v));
"""


def main():
    docker('run', '--rm', '--pull=never', '-d', '--name', container, '-p', '127.0.0.1::5432',
           '-e', 'POSTGRES_DB=chunmo_staging', '-e', 'POSTGRES_PASSWORD', 'postgres:17-alpine',
           env={**os.environ, 'POSTGRES_PASSWORD': token_hex(32)}, stdout=subprocess.DEVNULL)
    try:
        for _ in range(40):
            ready = subprocess.run(lab['DOCKER'] + ['exec', container, 'pg_isready', '-h', '127.0.0.1',
                                                   '-U', 'postgres'], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError('Isolated PostgreSQL did not become ready')
        roles = {key: {'name': 'cm_stg_' + key, 'password': token_hex(32)}
                 for key in ('app', 'backup', 'private', 'migrator')}
        lab['baseline'](roles)
        sql(generate('prepare-018.py', '--apply'))
        check = generate('prepare-021.py', '--check', str(ROOT))
        apply = generate('prepare-021.py', '--apply', str(ROOT))
        assert 'v21_migration' in sql(apply, ok=False)
        sql(generate('prepare-v21.py', '--apply', str(ROOT)))
        sql("""
          INSERT INTO public.employee_wechat_binding(account_id,phone_digest,phone_suffix,app_id,identity_digest)
            VALUES ('employee',repeat('a',64),'0000','app','employee-wechat');
          INSERT INTO owner_portal.member(id,workspace_id,label,phone_digest,phone_sealed,phone_suffix,app_id,identity_digest,bound_at)
            VALUES ('23a952c7-bd56-4f9c-a322-4043dfad15b0','w','Sandbox owner','sandbox-phone','{}','0001','app','owner-wechat',now());
          INSERT INTO owner_portal.project_service VALUES ('w','p',true);
          INSERT INTO owner_portal.project_grant(workspace_id,project_id,member_id)
            VALUES ('w','p','23a952c7-bd56-4f9c-a322-4043dfad15b0');
        """)
        assert sql(check) == 'pending'
        baseline = sql(BUSINESS)
        sql("ALTER TABLE public.account ADD COLUMN deleted_at timestamptz;")
        assert '没有正式账本记录' in sql(apply, ok=False)
        sql("ALTER TABLE public.account DROP COLUMN deleted_at;")
        assert 'division by zero' in sql(apply.replace('COMMIT;', 'SELECT 1/0;\nCOMMIT;'), ok=False)
        assert sql(check) == 'pending'
        port = int(docker('port', container, '5432/tcp', capture_output=True, text=True).stdout.strip().rsplit(':', 1)[1])
        lab['recovery'](roles, port)
        assert sql(apply).endswith('ready') and sql(check) == 'ready'
        assert sql(apply).endswith('ready') and sql(BUSINESS) == baseline
        assert sql("SELECT count(*) FROM owner_portal.v21_migration") == '5'
        assert sql("SET ROLE cm_stg_owner_portal; SELECT count(*) FROM owner_portal.available_project") == '1'
        sql("UPDATE owner_portal.member SET deleted_at=now(),app_id=NULL,identity_digest=NULL,bound_at=NULL")
        assert sql("SET ROLE cm_stg_owner_portal; SELECT count(*) FROM owner_portal.available_project") == '0'
        assert 'retired_owner_unbound' in sql("UPDATE owner_portal.member SET identity_digest='new',app_id='app',bound_at=now()", ok=False)
        sql("UPDATE public.account SET deleted_at=now(),active=false WHERE id='employee'")
        assert 'retired_employee_inactive' in sql("UPDATE public.account SET active=true WHERE id='employee'", ok=False)
        assert sql(check) == 'ready'
        print('PASS 021 only, transactional failure, repeat-safe ledger, business snapshots, encrypted recovery and retirement constraints')
    finally:
        docker('stop', container, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
