import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publish", Path(__file__).with_name("publish.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


CONFIG = '''events { }
http {
  add_header X-Content-Type-Options nosniff always;
  server { listen 127.0.0.1:8443 ssl; server_name localhost;
    ssl_certificate /private/test.crt; location / { return 200; }
  }
  server {
    listen 0.0.0.0:443 ssl;
    server_name chmsj.cn;
    # { a comment is not a block }
    ssl_certificate /etc/letsencrypt/live/chmsj.cn/fullchain.pem;
    ssl_certificate_key /private/key.pem;
    add_header X-Frame-Options DENY always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header Content-Security-Policy "default-src 'self'; style-src 'self'" always;
    if ($host != "chmsj.cn") { return 421; }
    location /api/ { proxy_pass http://127.0.0.1:4000; }
    location / { try_files $uri $uri/ /index.html; }
  }
}
'''


class PublicationTests(unittest.TestCase):
    def test_only_correct_https_server_changes_and_is_idempotent(self):
        rendered, headers, cert = p.configure(CONFIG, "chmsj.cn")
        self.assertEqual(rendered.replace("\n    " + p.HOOK, ""), CONFIG)
        self.assertEqual(p.configure(rendered, "chmsj.cn")[0], rendered)
        self.assertEqual(cert, "/etc/letsencrypt/live/chmsj.cn/fullchain.pem")
        self.assertIn("Strict-Transport-Security", headers)
        self.assertIn("Content-Security-Policy", headers)
        self.assertNotIn("X-Content-Type-Options", headers)  # nginx server overrides http
        self.assertNotIn("private/key", p.snippet(headers))

    def test_unknown_or_conflicting_config_stops(self):
        for source in (CONFIG.replace("chmsj.cn", "other.cn"), CONFIG.replace("0.0.0.0:443", "15001"), CONFIG + "}", CONFIG.replace("location /api/", "location /download/")):
            with self.assertRaises(ValueError):
                p.configure(source, "chmsj.cn")

    def test_preserves_all_security_headers_on_both_new_locations(self):
        _, headers, _ = p.configure(CONFIG, "chmsj.cn")
        text = p.snippet(headers)
        self.assertEqual(text.count("Strict-Transport-Security"), 2)
        self.assertEqual(text.count("Content-Security-Policy"), 2)
        self.assertIn("application/vnd.android.package-archive", text)
        self.assertIn('attachment; filename="chunmo-photo-test.apk"', text)
        self.assertNotIn("proxy_pass", text)

    def test_wrong_apk_fails_before_any_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "wrong.apk"
            file.write_bytes(b"not an apk")
            with self.assertRaises(ValueError):
                p.verify_apk(file)

    def test_original_artifact_still_verifies(self):
        file = Path(__file__).resolve().parents[2] / "native/android/app/build/outputs/apk/debug/app-debug.apk"
        if not file.exists():
            self.skipTest("No local APK; wrong-artifact boundary still tested")
        p.verify_apk(file)

    def test_cache_exclusion_is_narrow_idempotent_and_does_not_clear_data(self):
        old = "const CACHE = 'chunmo-assistant-shell-v14';\n" + p.SW_OLD + "\nindexedDB.open('photos')"
        new = p.patch_sw(old)
        self.assertEqual(new.replace(p.SW_NEW, p.SW_OLD), old)
        self.assertEqual(p.patch_sw(new), new)
        with self.assertRaises(ValueError):
            p.patch_sw("unknown worker")

    def test_atomic_replacement_preserves_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "config"
            file.write_bytes(b"original")
            file.chmod(0o640)
            p.atomic(file, b"replacement")
            self.assertEqual(file.read_bytes(), b"replacement")
            self.assertEqual(file.stat().st_mode & 0o777, 0o640)

    def test_reload_retries_entire_checks_then_requires_two_successes(self):
        with patch.object(p, "verify_downloads", side_effect=[ValueError("old worker"), None, None]) as verify, patch.object(p.time, "sleep"):
            p.wait_for_downloads("https://chmsj.cn")
            self.assertEqual(verify.call_count, 3)

    def test_server_preflight_is_read_only(self):
        with patch.object(p, "verify_apk", side_effect=ValueError("bad file")), patch.object(p, "run") as run:
            with self.assertRaises(ValueError):
                p.publish(Path("invalid.apk"), Path("logo.png"))
            run.assert_not_called()

    def test_failed_activation_restores_site_worker_snippet_and_download_pointer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config, sw, snippet, state = root / "nginx.conf", root / "sw.js", root / "conf/apk.conf", root / "state"
            config.write_text("original site config")
            sw.write_text("if (" + p.SW_OLD + ") return;")
            logo = root / "logo.png"
            logo.write_bytes(b"fixture logo")
            public_file = root / "public.json"
            public_file.write_text('{"origin":"https://chmsj.cn"}')
            original_read = Path.read_text

            def read(path, *args, **kwargs):
                if str(path) == "/etc/chunmo-staging/public-https.json":
                    return original_read(public_file, *args, **kwargs)
                return original_read(path, *args, **kwargs)

            def run(*args):
                if args[:2] == ("systemctl", "show"):
                    return str(config) + " -p /var/lib/chunmo-staging-web/"
                return "fixture: OK"

            # No commands, ports, production files or large APK are touched.
            with patch.multiple(p, CONFIG=config, SW=sw, SNIPPET=snippet, STATE=state), patch.object(p, "verify_apk"), patch.object(p, "run", side_effect=run), patch.object(p.shutil, "which", return_value="/usr/sbin/nginx"), patch.object(p.socket, "getaddrinfo"), patch.object(p, "configure", return_value=("new config", "", "/fixture/cert")), patch.object(p, "nginx_test"), patch.object(p, "website"), patch.object(p, "reload_web") as reload, patch.object(p, "get", side_effect=ValueError("injected download failure")), patch.object(p.time, "sleep"), patch.object(Path, "read_text", read):
                apk = root / "fixture.apk"
                apk.write_bytes(b"fixture APK")
                with self.assertRaisesRegex(ValueError, "injected download failure"):
                    p.publish(apk, logo)
                self.assertEqual(config.read_text(), "original site config")
                self.assertEqual(sw.read_text(), "if (" + p.SW_OLD + ") return;")
                self.assertFalse(snippet.exists())
                self.assertFalse((state / "current").is_symlink())
                self.assertTrue(apk.exists())
                self.assertEqual(reload.call_count, 2)


if __name__ == "__main__":
    unittest.main()
