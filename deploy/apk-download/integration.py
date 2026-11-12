#!/usr/bin/env python3
"""Isolated REAL nginx HTTPS/static-download test; never contacts production.

Requires local Docker and openssl/curl. Image must already be available locally.
Uses only loopback ports 18443/18080; the APK itself is never rebuilt.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location("publish", Path(__file__).with_name("publish.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
docker_env = {k: v for k, v in os.environ.items() if k not in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")}


def docker(*args):
    return subprocess.check_output(["docker", "--host=unix:///var/run/docker.sock", *args], env=docker_env, stderr=subprocess.STDOUT, text=True).strip()


def main():
    repo = Path(__file__).resolve().parents[2]
    apk = repo / "native/android/app/build/outputs/apk/debug/app-debug.apk"
    p.verify_apk(apk)
    with tempfile.TemporaryDirectory(prefix="chunmo-nginx-apk-") as folder:
        lab = Path(folder)
        lab.chmod(0o755)
        site = lab / "site"
        site.mkdir(mode=0o755)
        site.chmod(0o755)
        snippets = lab / "snippets"
        snippets.mkdir(mode=0o755)
        snippets.chmod(0o755)
        for filename in ("index.html", "download.css"):
            shutil.copyfile(Path(__file__).parent / filename, site / filename)
        shutil.copyfile(repo / "public/brand/source/chunmo-original-circle.png", site / "logo.png")
        shutil.copyfile(apk, site / "chunmo-photo-test.apk")
        (site / "SHA256SUMS").write_text(p.SHA + "  chunmo-photo-test.apk\n")
        for file in site.iterdir():
            file.chmod(0o644)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=chmsj.cn", "-addext", "subjectAltName=DNS:chmsj.cn", "-keyout", str(lab / "key.pem"), "-out", str(lab / "cert.pem")], check=True, capture_output=True)
        original = '''events { }
http { access_log off; server {
  listen 443 ssl; listen 80;
  server_name chmsj.cn;
  ssl_certificate /lab/cert.pem;
  ssl_certificate_key /lab/key.pem;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;
  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header Content-Security-Policy "default-src 'self'; style-src 'self'" always;
  location = /api/health { default_type application/json; return 200 '{"ok":true}'; }
  location / { default_type text/html; return 200 '<html>existing-site-fixture</html>'; }
} }
'''
        (lab / "nginx.conf").write_text(original)
        name = "chunmo-apk-delivery-test-" + str(os.getpid())
        docker("run", "-d", "--name", name, "-p", "127.0.0.1:18443:443", "-p", "127.0.0.1:18080:80", "-v", folder + ":/lab:ro", "-v", str(snippets) + ":/etc/chunmo-staging/downloads:ro", "nginx:1.28-alpine", "nginx", "-c", "/lab/nginx.conf", "-g", "daemon off;")

        def get(route, *extra):
            body, headers = lab / "body", lab / "headers"
            subprocess.run(["curl", "--silent", "--show-error", "--fail", "--max-time", "10", "--noproxy", "chmsj.cn", "--cacert", str(lab / "cert.pem"), "--resolve", "chmsj.cn:18443:127.0.0.1", "-D", str(headers), "-o", str(body), *extra, "https://chmsj.cn:18443" + route], check=True, capture_output=True)
            return headers.read_text().lower(), body.read_bytes()

        try:
            for attempt in range(20):
                try:
                    before = get("/")[1]
                    break
                except subprocess.CalledProcessError:
                    if attempt == 19:
                        raise
                    time.sleep(0.1)
            new, headers, _ = p.configure(original, "chmsj.cn")
            (snippets / "apk.conf").write_text(p.snippet(headers, "/lab/site"))
            (snippets / "apk.conf").chmod(0o644)
            (lab / "nginx.conf").write_text(new)
            print(docker("exec", name, "nginx", "-t", "-c", "/lab/nginx.conf"))
            docker("kill", "--signal=HUP", name)
            original_get = p.get
            try:
                p.get = lambda origin, route, local=False, extra=(): get(route, *extra)
                p.wait_for_downloads("https://chmsj.cn")
            finally:
                p.get = original_get
            h, body = get("/download/chunmo-photo-test.apk")
            assert "application/vnd.android.package-archive" in h
            assert "content-disposition: attachment" in h
            assert f"content-length: {p.SIZE}" in h
            for header in ("x-content-type-options: nosniff", "strict-transport-security:", "content-security-policy:", "x-frame-options: deny"):
                assert header in h
            head, _ = get("/download/chunmo-photo-test.apk", "--head")
            assert f"content-length: {p.SIZE}" in head
            h, partial = get("/download/chunmo-photo-test.apk", "--range", "0-31")
            assert "206 partial content" in h and len(partial) == 32
            assert partial == body[:32]
            page_headers, page_body = get("/download/")
            assert "春茉工地拍照".encode() in page_body, (page_headers, page_body[:160])
            assert "text/css" in get("/download/download.css")[0]
            assert get("/")[1] == before
            assert get("/api/health")[1] == b'{"ok":true}'
            # Real browser mobile layout + actual APK download, no UI app build.
            browser_script = r'''
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
const browser = await chromium.launch({executablePath:'/usr/bin/chromium', headless:true, args:['--no-sandbox']});
try {
  const context = await browser.newContext({acceptDownloads:true});
  const page = await context.newPage();
  for (const width of [320,390,768]) {
    await page.setViewportSize({width,height:844});
    await page.goto('http://127.0.0.1:18080/download/');
    await page.locator('details').click();
    if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw Error('Horizontal overflow '+width);
  }
  await page.setViewportSize({width:390,height:844});
  mkdirSync('/workspace/artifacts/chunmo-native-v1',{recursive:true});
  await page.screenshot({path:'/workspace/artifacts/chunmo-native-v1/download-mobile-preview.png',fullPage:true});
  const [download] = await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'下载 Android 测试安装包'}).click()]);
  if (await download.failure()) throw Error(await download.failure());
  if (download.suggestedFilename() !== 'chunmo-photo-test.apk') throw Error('Wrong filename');
  const hash = createHash('sha256').update(readFileSync(await download.path())).digest('hex');
  if (hash !== process.env.EXPECTED_APK_SHA) throw Error('Browser downloaded wrong APK');
  console.log('PASS mobile Chromium 320/390/768 layout and actual downloaded APK hash');
} finally { await browser.close(); }
'''
            result = subprocess.run(["node", "--input-type=module", "-e", browser_script], cwd=repo, env={**os.environ, "EXPECTED_APK_SHA": p.SHA}, check=True, capture_output=True, text=True)
            print(result.stdout.strip())
            print("PASS isolated nginx: CA-verified HTTPS, GET/HEAD, APK MIME/attachment/size/SHA, 206 resume, security headers, unchanged original routes")
        except BaseException:
            print(docker("logs", "--tail", "20", name))
            raise
        finally:
            docker("rm", "-f", name)


if __name__ == "__main__":
    main()
