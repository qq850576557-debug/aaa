import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import zipfile

root=Path(__file__).resolve().parents[2]
def module(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
old=module('old_source_tests',root/'deploy/source-download/test_publish.py')
candidate=module('new_source_profile',Path(__file__).with_name('source.py'))
class WorkbenchSourceTests(old.SourceDeliveryTests):
    def setUp(self):
        old.p=module('fresh_source',root/'deploy/source-download/publish.py');candidate.profile(old.p)
    def test_deterministic_bytes_and_reviewed_hash(self):
        a,b=old.p.source_zip(root),old.p.source_zip(root)
        self.assertEqual(a,b);self.assertEqual(len(a),1183731)
        self.assertEqual(hashlib.sha256(a).hexdigest(),candidate.EXPECTED_SHA)
        self.assertEqual(old.p.SOURCE_SNIPPET.name,'workbench-source.conf')
        self.assertNotIn('v122',old.p.FILENAME)
    def test_registered_appid_and_original_logo_without_private_config_or_secrets(self):
        with zipfile.ZipFile(io.BytesIO(old.p.source_zip(root))) as source:
            prefix='chunmo-workbench/miniprogram/chunmo-photo/'
            self.assertEqual(json.loads(source.read(prefix+'project.config.json'))['appid'],'wxb48a7abb3858a252')
            self.assertIn(b'/api/mini-photo-candidate/',source.read(prefix+'config.js'))
            self.assertEqual(hashlib.sha256(source.read(prefix+'assets/chunmo-original.jpg')).hexdigest(),'611a63cc6e1e5f8e4271f94e55b449e1f48f074648c7996fa5d1878afcffb831')
            for name in source.namelist():
                self.assertNotIn('..',name.split('/'));self.assertNotIn('project.private.config.json',name)
                self.assertFalse(name.endswith(('.env','.p12','.apk','.keystore')))
            self.assertIsNone(source.testzip())
if __name__=='__main__':unittest.main()
