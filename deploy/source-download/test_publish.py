import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("source_publish", Path(__file__).with_name("publish.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
REPO = Path(__file__).resolve().parents[2]


class SourceDeliveryTests(unittest.TestCase):
    def test_deterministic_bytes_and_reviewed_hash(self):
        a, b = p.source_zip(REPO), p.source_zip(REPO)
        self.assertEqual(a, b)
        self.assertEqual(hashlib.sha256(a).hexdigest(), p.EXPECTED_SHA)
        self.assertEqual(len(a), 663752)

    def test_registered_appid_and_original_logo_without_private_config_or_secrets(self):
        with zipfile.ZipFile(io.BytesIO(p.source_zip(REPO))) as source:
            prefix = "chunmo-wechat-photo/miniprogram/chunmo-photo/"
            config = json.loads(source.read(prefix + "project.config.json"))
            self.assertEqual(config["appid"], "wxb48a7abb3858a252")
            self.assertEqual(hashlib.sha256(source.read(prefix + "assets/chunmo-original.jpg")).hexdigest(),
                             "611a63cc6e1e5f8e4271f94e55b449e1f48f074648c7996fa5d1878afcffb831")
            for name in source.namelist():
                self.assertNotIn("..", name.split("/"))
                self.assertFalse(name.startswith("/"))
                self.assertNotIn("project.private.config.json", name)
                self.assertFalse(name.endswith((".keystore", ".p12", ".env", ".apk")))
            self.assertIsNone(source.testzip())

    def test_download_get_head_range_byte_checks(self):
        data = p.source_zip(REPO)
        def get(origin, route, local=False, extra=()):
            self.assertEqual(origin, "https://chmsj.cn")
            self.assertIn(p.FILENAME, route)
            base = "content-type: application/octet-stream\ncontent-disposition: attachment\n"
            if "--range" in extra:
                return "http/1.1 206 partial content\n" + base, data[:32]
            return "http/1.1 200 ok\n" + base + "content-length: " + str(len(data)) + "\n", b"" if "--head" in extra else data
        with patch.object(p, "fetch", side_effect=get) as calls:
            self.assertTrue(p.verify("https://chmsj.cn", data).endswith(p.FILENAME))
            self.assertEqual(calls.call_count, 6)
        with patch.object(p, "fetch", return_value=("http/1.1 200 ok", b"wrong data")):
            with self.assertRaises(ValueError): p.verify("https://chmsj.cn", data)

    def test_invalid_package_rejected_before_any_server_access(self):
        with patch.object(p.os, "geteuid", return_value=0), patch.object(p.Path, "read_text") as read:
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                p.publish(b"incorrect ZIP")
            read.assert_not_called()


if __name__ == "__main__":
    unittest.main()
