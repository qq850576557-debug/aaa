import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import owner_preview as preview
import test_publish


class OwnerPreviewDeliveryTests(unittest.TestCase):
    def test_reviewed_zip_imports_directly_into_guest_devtools(self):
        data = preview.build_zip(test_publish.REPO)
        self.assertEqual(hashlib.sha256(data).hexdigest(), preview.SHA256)
        self.assertEqual(len(data), 261774)
        self.assertEqual(data, preview.build_zip(test_publish.REPO))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertIsNone(archive.testzip())
            prefix = preview.PROJECT + "/"
            self.assertTrue(all(path.startswith(prefix) for path in archive.namelist()))
            self.assertTrue(all(".." not in path.split("/") for path in archive.namelist()))
            project = json.loads(archive.read(prefix + "project.config.json"))
            app = json.loads(archive.read(prefix + "app.json"))
            self.assertEqual(project["appid"], "touristappid")
            self.assertEqual(project["miniprogramRoot"], "./")
            self.assertEqual(app["pages"][0], "owner-login/pages/welcome/index")
            self.assertNotIn("permission", app)
            for page in app["pages"]:
                for extension in (".wxml", ".js", ".json"):
                    self.assertIn(prefix + page + extension, archive.namelist())
            self.assertFalse(any(path.startswith(prefix + "lib/") for path in archive.namelist()))
            self.assertNotIn(prefix + "config.js", archive.namelist())
            self.assertIn(prefix + "owner-login/ui-dev-tokens.js", archive.namelist())
            privacy_button = b"chunmo-privacy-agree"
            self.assertIn(privacy_button, archive.read(prefix + "app.js"))
            self.assertIn(privacy_button, archive.read(prefix + "owner-login/pages/profile/index.wxml"))

    def test_additive_route_keeps_existing_source_and_apk(self):
        p = preview.source_delivery
        with tempfile.TemporaryDirectory() as temporary:
            config, sw, original_source, apk = test_publish.SourceDeliveryTests().fixture_routes(temporary)
            original_source.parent.mkdir()
            original_source.write_bytes(p.source_snippet("").encode("utf-8"))
            apk.write_text("location ^~ /download/releases/ { alias /var/lib/chunmo-downloads/releases/; }")
            originals = {path: path.read_bytes() for path in (config, sw, original_source, apk)}
            with patch.multiple(p, CONFIG=config, SW=sw, STATE=Path(temporary), APK_SNIPPET=apk,
                                SOURCE_SNIPPET=original_source, RELEASE=p.RELEASE, ROUTE=p.ROUTE,
                                FILENAME=p.FILENAME, EXPECTED_SHA=p.EXPECTED_SHA):
                preview.configure_delivery()
                plan = p.route_plan(test_publish.REPO)
                self.assertEqual(p.SOURCE_SNIPPET, Path(temporary) / "routes" / (preview.RELEASE + ".conf"))
                self.assertIn(("location = " + p.ROUTE).encode("utf-8"), plan["snippet"])
                self.assertIn(b"application/zip", plan["snippet"])
                self.assertIn(b"Content-Disposition 'attachment;", plan["snippet"])
                self.assertIsNone(plan["old_snippet"])
                for path, saved in originals.items():
                    self.assertEqual(path.read_bytes(), saved)


if __name__ == "__main__":
    unittest.main()
