import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import warnings
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mini_install', Path(__file__).with_name('install.py'))
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.lab = Path(self.temp.name)
        paths = {'ROOT':self.lab/'mini', 'STATE':self.lab/'state', 'ENV':self.lab/'mini.env',
                 'UNIT':self.lab/'mini.service', 'ROUTE':self.lab/'mini/routes/api.conf',
                 'CONFIG':self.lab/'nginx.conf', 'CURRENT':self.lab/'original'}
        self.mapping = patch.multiple(p, **paths); self.mapping.start(); self.addCleanup(self.mapping.stop)
        (p.CURRENT/'dist-api').mkdir(parents=True); (p.CURRENT/'dist-api/server.mjs').write_bytes(b'original API bytes')
        p.CONFIG.write_bytes(b'original nginx bytes')
        self.plan = {'commit':'a'*40, 'node':'/usr/bin/node', 'apiPort':4000, 'listenPort':4011,
                     'currentRelease':str(p.CURRENT.resolve()), 'apiSha256':p.sha(b'original API bytes'),
                     'nginxSha256':p.sha(b'original nginx bytes'), 'approvalToken':'approved', 'installed':False}
        self.commands = []
        self.records = []

    def run_command(self, *args):
        self.commands.append(args)
        if args[:2] == ('getent','passwd'):
            return ('chunmo-mini-photo:x:1001:1001::'+str(p.STATE)+':/sbin/nologin').encode()
        if args[:2] == ('id','-G'): return b'1001\n'
        return b''

    @contextlib.contextmanager
    def platform(self, verify=None, reload=None):
        files = {'runtime.cjs':b'reviewed standalone runtime','runtime.cjs.LEGAL.txt':b'license'}
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(p,'check',return_value=(self.plan, files)))
            stack.enter_context(patch.object(p,'nginx_plan',return_value=b'original nginx bytes\nmini include'))
            stack.enter_context(patch.object(p,'run',side_effect=self.run_command))
            stack.enter_context(patch.object(p,'read_secret',return_value='a'*32))
            stack.enter_context(patch.object(p,'curl',return_value=(200,b'{"ok":true,"protocol":1}')))
            stack.enter_context(patch.object(p,'nginx_check'))
            stack.enter_context(patch.object(p,'old_health'))
            stack.enter_context(patch.object(p.time,'sleep'))
            stack.enter_context(patch.object(p,'reload_web',side_effect=reload))
            stack.enter_context(patch.object(p,'verify_installed',side_effect=verify))
            yield

    def test_success_preserves_original_api_and_uses_private_minimal_env(self):
        output = io.StringIO()
        with self.platform(), contextlib.redirect_stdout(output): p.install(Path('.'),'a'*40,'approved')
        self.assertEqual((p.CURRENT/'dist-api/server.mjs').read_bytes(),b'original API bytes')
        env = p.ENV.read_text()
        self.assertIn('CHUNMO_MINI_APP_SECRET='+'a'*32,env)
        self.assertNotIn('DATABASE_URL',env); self.assertNotIn('PRIVATE_DATA_KEY',env); self.assertNotIn('AMAP_KEY',env)
        self.assertEqual(p.ENV.stat().st_mode & 0o777,0o600)
        self.assertEqual(p.STATE.stat().st_mode & 0o777,0o700)
        self.assertNotIn('a'*32,output.getvalue())
        self.assertEqual(p.state_data()['phase'],'installed')
        self.assertFalse(any(c[:2] in (('systemctl','restart'),('systemctl','stop')) and 'chunmo-staging-api' in c for c in self.commands))

    def test_missing_approval_causes_no_installation_or_secret_prompt(self):
        with self.platform(), patch.object(p,'read_secret') as secret:
            with self.assertRaisesRegex(ValueError,'核验指纹'): p.install(Path('.'),'a'*40,'not-approved')
            secret.assert_not_called()
        self.assertFalse(p.ROOT.exists()); self.assertFalse(p.STATE.exists())

    def test_route_failure_restores_original_then_stops_only_new_service(self):
        with self.platform(verify=ValueError('injected health failure')):
            with self.assertRaisesRegex(ValueError,'已回滚'): p.install(Path('.'),'a'*40,'approved')
        self.assertEqual(p.CONFIG.read_bytes(),b'original nginx bytes')
        self.assertFalse(p.ROUTE.exists()); self.assertFalse(p.UNIT.exists()); self.assertFalse(p.ENV.exists())
        self.assertEqual(p.state_data()['phase'],'rolled-back')
        stops=[c for c in self.commands if c[:2]==('systemctl','stop')]
        self.assertEqual(stops,[('systemctl','stop',p.SERVICE)])

    def test_rollback_hup_failure_preserves_backup_and_keeps_adapter_alive(self):
        with self.platform(verify=ValueError('health failed'),reload=[None,ValueError('rollback HUP failed')]):
            with self.assertRaisesRegex(ValueError,'回滚未完全确认'): p.install(Path('.'),'a'*40,'approved')
        record=p.state_data(); self.assertTrue(record['routingTouched'])
        self.assertEqual(p.CONFIG.read_bytes(),b'original nginx bytes')
        self.assertTrue(p.UNIT.exists()); self.assertTrue((p.STATE/'backups'/record['backup']/'record.json').exists())
        self.assertFalse(any(c[:2]==('systemctl','stop') for c in self.commands))
        # Retry must send HUP even though the previous attempt restored disk bytes.
        with self.platform(), patch.object(p,'reload_web') as hup: p.rollback(record['backup'])
        hup.assert_called_once()
        self.assertEqual(p.state_data()['phase'],'rolled-back')

    def test_external_nginx_edit_is_not_overwritten_by_rollback(self):
        with self.platform(): p.install(Path('.'),'a'*40,'approved')
        name=p.state_data()['backup']; p.CONFIG.write_bytes(b'another admin valid configuration')
        with self.platform():
            with self.assertRaisesRegex(ValueError,'其他人修改'): p.rollback(name)
        self.assertEqual(p.CONFIG.read_bytes(),b'another admin valid configuration')

    def test_reexecution_healthy_service_does_not_write_or_prompt(self):
        with self.platform(): p.install(Path('.'),'a'*40,'approved')
        before=p.ENV.read_bytes(); self.plan['installed']=True
        with self.platform(), patch.object(p,'read_secret') as secret, patch.object(p,'atomic') as write:
            p.install(Path('.'),'a'*40,'original-token')
        secret.assert_not_called(); write.assert_not_called(); self.assertEqual(p.ENV.read_bytes(),before)

    def test_abort_before_secret_has_no_nginx_reload(self):
        with self.platform(), patch.object(p,'read_secret',side_effect=ValueError('cancelled')), patch.object(p,'reload_web') as reload:
            with self.assertRaisesRegex(ValueError,'已回滚'): p.install(Path('.'),'a'*40,'approved')
        reload.assert_not_called(); self.assertEqual(p.CONFIG.read_bytes(),b'original nginx bytes')

    def test_no_tty_never_falls_back_to_visible_stdin(self):
        with patch('builtins.open',side_effect=OSError('no tty')), patch.object(p.getpass,'getpass') as read:
            with self.assertRaisesRegex(ValueError,'安全交互终端'): p.read_secret()
        read.assert_not_called()

    def test_unit_and_route_are_scoped_without_database_or_public_bind(self):
        unit=p.render_unit(self.plan).decode(); route=p.render_route(4011).decode()
        self.assertIn('User=chunmo-mini-photo',unit); self.assertIn('NoNewPrivileges=yes',unit)
        self.assertIn('InaccessiblePaths=/etc/chunmo-staging',unit); self.assertNotIn('DATABASE_URL',unit)
        self.assertIn('location ^~ /api/mini-photo/',route); self.assertNotIn('location /api/ {',route)
        self.assertIn('proxy_pass http://127.0.0.1:4011;',route); self.assertNotIn('0.0.0.0',route)

    def test_tty_echo_failure_aborts_before_fallback_input(self):
        class Tty(io.StringIO):
            def isatty(self): return True
        entered=[]
        def unsafe_fallback(*args,**kwargs):
            warnings.warn('cannot disable echo',p.getpass.GetPassWarning)
            entered.append(True)
            return 'a'*32
        with patch('builtins.open',return_value=Tty()), patch.object(p.getpass,'getpass',side_effect=unsafe_fallback):
            with self.assertRaisesRegex(ValueError,'安全交互终端'):p.read_secret()
        self.assertFalse(entered)

    def test_port_probe_skips_conflicts_and_binds_loopback_only(self):
        seen=[]
        class Probe:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def bind(self,address):
                seen.append(address)
                if address[1] in (4011,4012):raise OSError('occupied')
        with patch.object(p.socket,'socket',return_value=Probe()):self.assertEqual(p.free_port(4013),4014)
        self.assertTrue(all(host=='127.0.0.1' for host,_ in seen))

    def test_hup_uses_correct_systemctl_main_process_option(self):
        with patch.object(p,'run') as run:p.reload_web()
        run.assert_called_once_with('systemctl','kill','--kill-who=main','--signal=HUP','chunmo-staging-web')

    def test_public_nginx_upstream_is_validated_not_just_private_server_port(self):
        code=(Path(__file__).resolve().parents[2]/'deploy/apk-download/publish.py').read_bytes()
        conf=b'''events {} http {
server { listen 8443 ssl; server_name localhost; ssl_certificate /private/cert;
location /api/ { proxy_pass http://127.0.0.1:4000; } }
server { listen 443 ssl; server_name chmsj.cn; ssl_certificate /public/cert;
location /api/ { proxy_pass http://127.0.0.1:4001; } }
}'''
        with patch.object(p,'run',return_value=code):
            with self.assertRaisesRegex(ValueError,'上游'):p.nginx_plan(Path('.'),'a'*40,conf,4000)
            self.assertIn(p.HOOK.encode(),p.nginx_plan(Path('.'),'a'*40,conf,4001))


if __name__=='__main__': unittest.main()
