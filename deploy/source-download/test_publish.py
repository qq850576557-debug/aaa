import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("source_publish", Path(__file__).with_name("publish.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
REPO = Path(__file__).resolve().parents[2]


class SourceDeliveryTests(unittest.TestCase):
    def fixture_routes(self, directory):
        root = Path(directory)
        config, sw, snippet, apk = root / "nginx.conf", root / "sw.js", root / "downloads/source.conf", root / "downloads/apk.conf"
        original = '''events {} http {
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Content-Security-Policy "default-src 'self'" always;
server { listen 0.0.0.0:443 ssl; server_name chmsj.cn;
ssl_certificate /existing/certificate.crt;
location / { return 200 '<html>original site</html>'; }
} }
'''.encode()
        config.write_bytes(original)
        sw.write_text("if (url.pathname.startsWith('/api/')) return; // original worker")
        return config, sw, snippet, apk

    def test_deterministic_bytes_and_reviewed_hash(self):
        a, b = p.source_zip(REPO), p.source_zip(REPO)
        self.assertEqual(a, b)
        self.assertEqual(hashlib.sha256(a).hexdigest(), p.EXPECTED_SHA)
        self.assertEqual(len(a), 665931)

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

    def test_missing_apk_mapping_plans_one_exact_source_route_and_inherits_security(self):
        with tempfile.TemporaryDirectory() as folder:
            config, sw, snippet, apk = self.fixture_routes(folder)
            original = config.read_bytes()
            with patch.multiple(p, CONFIG=config, SW=sw, SOURCE_SNIPPET=snippet, APK_SNIPPET=apk):
                plan = p.route_plan(REPO)
            self.assertEqual(config.read_bytes(), original)  # plan is read-only
            self.assertIn(p.HOOK.encode(), plan["config"])
            self.assertIsNone(plan["old_snippet"])
            self.assertIn(("location = " + p.ROUTE).encode(), plan["snippet"])
            self.assertIn(b"application/zip", plan["snippet"])
            self.assertIn(b"Strict-Transport-Security", plan["snippet"])
            self.assertIn(b"Content-Security-Policy", plan["snippet"])
            self.assertIn(b"url.pathname.startsWith('/download/')", plan["sw"])
            self.assertNotIn(b"location /api", plan["snippet"])

    def test_existing_apk_config_is_preserved_and_source_gets_its_own_exact_route(self):
        with tempfile.TemporaryDirectory() as folder:
            config, sw, snippet, apk = self.fixture_routes(folder)
            apk.parent.mkdir()
            apk.write_text("location ^~ /download/releases/ { alias /var/lib/chunmo-downloads/releases/; }")
            original_apk = apk.read_bytes()
            with patch.multiple(p, CONFIG=config, SW=sw, SOURCE_SNIPPET=snippet, APK_SNIPPET=apk):
                plan = p.route_plan(REPO)
            self.assertIn(("location = " + p.ROUTE).encode(), plan["snippet"])
            self.assertEqual(apk.read_bytes(), original_apk)

    def test_invalid_nginx_update_rolls_back_original_bytes_and_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            config, sw, snippet, apk = self.fixture_routes(folder)
            original, original_sw = config.read_bytes(), sw.read_bytes()
            with patch.multiple(p, CONFIG=config, SW=sw, SOURCE_SNIPPET=snippet, APK_SNIPPET=apk, STATE=Path(folder)/"state"):
                plan = p.route_plan(REPO)
                with patch.object(p, "nginx_check", side_effect=[None, ValueError("injected nginx -t failure"), None]), patch.object(p, "reload_web") as reload, patch.object(p, "health"):
                    with self.assertRaisesRegex(ValueError, "injected"):
                        p.activate_route(plan, "https://chmsj.cn", b"test")
                    self.assertEqual(reload.call_count, 1)  # only restored original gets HUP
                self.assertEqual(config.read_bytes(), original)
                self.assertEqual(sw.read_bytes(), original_sw)
                self.assertFalse(snippet.exists())

    def test_reload_targets_systemd_main_process(self):
        with patch.object(p, "run") as run:
            p.reload_web()
            run.assert_called_once_with("systemctl", "kill", "--kill-who=main", "--signal=HUP", "chunmo-staging-web")

    def test_reload_and_rollback_reload_failures_preserve_files_and_report_both(self):
        with tempfile.TemporaryDirectory() as folder:
            config, sw, snippet, apk = self.fixture_routes(folder)
            original = config.read_bytes()
            with patch.multiple(p, CONFIG=config, SW=sw, SOURCE_SNIPPET=snippet, APK_SNIPPET=apk, STATE=Path(folder)/"state"):
                plan = p.route_plan(REPO)
                with patch.object(p, "nginx_check"), patch.object(p, "reload_web", side_effect=[ValueError("publish HUP failed"), ValueError("rollback HUP failed")]), patch.object(p, "health") as health:
                    with self.assertRaisesRegex(ValueError, "回滚未完全确认") as error:
                        p.activate_route(plan, "https://chmsj.cn", b"test")
                    self.assertIn("publish HUP failed", str(error.exception))
                    self.assertIn("rollback HUP failed", str(error.exception))
                    health.assert_called_once()
                self.assertEqual(config.read_bytes(), original)
                self.assertFalse(snippet.exists())

    def test_unchanged_reexecution_does_not_reload(self):
        plan = {"config": b"same", "old_config": b"same", "snippet": b"s", "old_snippet": b"s", "sw": b"w", "old_sw": b"w"}
        with patch.object(p, "reload_web") as reload, patch.object(p, "verify", return_value="verified"):
            self.assertEqual(p.activate_route(plan, "https://chmsj.cn", b"test"), "verified")
            reload.assert_not_called()


if __name__ == "__main__":
    unittest.main()
