"""Real isolated Nginx HTTPS GET/HEAD/Range test; never contacts production."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import time


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


repo = Path(__file__).resolve().parents[2]
p = load("source_publish", Path(__file__).with_name("publish.py"))
apk = load("apk_publish", repo / "deploy/apk-download/publish.py")
environment = {k: v for k, v in os.environ.items() if k not in
               ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")}


def docker(*args):
    return subprocess.check_output(["docker", "--host=unix:///var/run/docker.sock", *args], env=environment, stderr=subprocess.STDOUT)


with tempfile.TemporaryDirectory(prefix="chunmo-source-nginx-") as work:
    lab = Path(work)
    lab.chmod(0o755)
    current = lab / "state"
    destination = current / "releases" / p.RELEASE
    destination.mkdir(parents=True)
    for folder in (current, current / "releases", destination):
        folder.chmod(0o755)
    data = p.source_zip(repo)
    (destination / p.FILENAME).write_bytes(data)
    (destination / p.FILENAME).chmod(0o644)
    (current / "existing.apk").write_bytes(b"existing-APK-fixture-unchanged")
    (current / "existing.apk").chmod(0o644)
    snippets = current / "routes"
    snippets.mkdir(mode=0o755)
    snippets.chmod(0o755)
    (lab / "sw.js").write_text("if (url.pathname.startsWith('/api/')) return; // original worker")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=chmsj.cn", "-addext", "subjectAltName=DNS:chmsj.cn", "-keyout", str(lab / "key.pem"), "-out", str(lab / "cert.pem")], check=True, capture_output=True)
    (lab / "nginx.conf").write_text('''events {} http { access_log off; server {
listen 443 ssl; server_name chmsj.cn;
ssl_certificate /lab/cert.pem; ssl_certificate_key /lab/key.pem;
add_header X-Content-Type-Options nosniff always;
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Content-Security-Policy "default-src 'self'" always;
location = /api/health { default_type application/json; return 200 '{"ok":true}'; }
location = /existing-photo.apk { alias /var/lib/chunmo-downloads/existing.apk; }
location / { default_type text/html; return 200 '<html>original-site-fixture</html>'; }
} }''')
    name = "chunmo-source-check-" + str(os.getpid())
    docker("run", "-d", "--name", name, "-p", "127.0.0.1:18444:443", "-v", work + ":/lab:ro",
           "-v", str(current) + ":/var/lib/chunmo-downloads:ro",
           "nginx:1.28-alpine", "nginx", "-c", "/lab/nginx.conf", "-g", "daemon off;")

    def get(origin, route, local=False, extra=()):
        subprocess.run(["curl", "--fail", "--silent", "--show-error", "--max-time", "10", "--noproxy", "chmsj.cn",
                        "--cacert", str(lab / "cert.pem"), "--resolve", "chmsj.cn:18444:127.0.0.1",
                        "-D", str(lab / "headers"), "-o", str(lab / "body"), *extra, "https://chmsj.cn:18444" + route], check=True, capture_output=True)
        return (lab / "headers").read_text().lower(), (lab / "body").read_bytes()

    try:
        for i in range(30):
            try:
                before = get("", "/")[1]
                break
            except subprocess.CalledProcessError:
                if i == 29:
                    raise
                time.sleep(0.1)
        assert get("", p.ROUTE)[1] == before  # reproduce user: ZIP URL opens website
        assert not (snippets / "apk.conf").exists()
        p.CONFIG, p.SW = lab / "nginx.conf", lab / "sw.js"
        p.SOURCE_SNIPPET, p.APK_SNIPPET = snippets / "source.conf", snippets / "apk.conf"
        plan = p.route_plan(repo)
        p.CONFIG.write_bytes(plan["config"])
        p.SOURCE_SNIPPET.write_bytes(plan["snippet"])
        p.SOURCE_SNIPPET.chmod(0o644)
        p.SW.write_bytes(plan["sw"])
        docker("exec", name, "nginx", "-t", "-c", "/lab/nginx.conf")
        docker("kill", "--signal=HUP", name)
        p.fetch = get
        for attempt in range(10):
            try:
                url = p.verify("https://chmsj.cn", data)
                break
            except (ValueError, subprocess.CalledProcessError):
                if attempt == 9:
                    raise
                time.sleep(0.2)
        assert get("", "/")[1] == before
        assert get("", "/api/health")[1] == b'{"ok":true}'
        assert get("", "/existing-photo.apk")[1] == b"existing-APK-fixture-unchanged"
        headers = get("", p.ROUTE)[0]
        for header in ("strict-transport-security:", "content-security-policy:", "x-content-type-options: nosniff"):
            assert header in headers
        print("PASS isolated Nginx HTTPS: reproduced missing apk.conf/ZIP opening HTML; exact source route installed, nginx -t/HUP, GET/HEAD/Range/bytes/security headers correct; original site/API/APK fixture unchanged.")
        print("Production deployment NOT performed; actual website URL remains pending Workbench execution.")
    finally:
        docker("rm", "-f", name)
