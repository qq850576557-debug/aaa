import importlib.util
import unittest
from pathlib import Path

root=Path(__file__).resolve().parents[2]
def module(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
old=module('base_transaction_tests',root/'deploy/miniprogram/test_install.py')
candidate=module('candidate_profile',Path(__file__).with_name('install.py'))
class CandidateTests(old.InstallTests):
    def setUp(self):
        old.p=module('fresh_base',root/'deploy/miniprogram/install.py')
        candidate.profile(old.p)
        super().setUp()
    def test_unit_and_route_are_scoped_without_database_or_public_bind(self):
        p=old.p
        unit=p.render_unit(self.plan).decode();route=p.render_route(4012).decode()
        self.assertIn('User=chunmo-mini-workbench',unit)
        self.assertIn('EnvironmentFile='+str(p.ENV),unit)
        self.assertNotIn('DATABASE_URL',unit)
        self.assertIn('location ^~ /api/mini-photo-candidate/',route)
        self.assertIn('http://127.0.0.1:4012/api/mini-photo/',route)
        env=p.render_environment(self.plan,'a'*32).decode()
        self.assertIn('CHUNMO_MINI_WORKBENCH_ENABLED=1',env)
        self.assertNotIn('DATABASE_URL',env)
    def test_hup_uses_correct_systemctl_main_process_option(self):
        super().test_hup_uses_correct_systemctl_main_process_option()
if __name__=='__main__':unittest.main()
