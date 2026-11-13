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
    current = lab / "current"
    destination = current / "releases" / p.RELEASE
    destination.mkdir(parents=True)
    for folder in (current, current / "releases", destination):
        folder.chmod(0o755)
    data = p.source_zip(repo)
    (destination / p.FILENAME).write_bytes(data)
    (destination / p.FILENAME).chmod(0o644)
    (current / "chunmo-photo-test.apk").write_bytes(b"existing-APK-fixture-unchanged")
    (current / "chunmo-photo-test.apk").chmod(0o644)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=chmsj.cn", "-addext", "subjectAltName=DNS:chmsj.cn", "-keyout", str(lab / "key.pem"), "-out", str(lab / "cert.pem")], check=True, capture_output=True)
    (lab / "nginx.conf").write_text('''events {} http { access_log off; server {
listen 443 ssl; server_name chmsj.cn;
ssl_certificate /lab/cert.pem; ssl_certificate_key /lab/key.pem;
location = /api/health { default_type application/json; return 200 '{"ok":true}'; }
location / { default_type text/html; return 200 '<html>original-site-fixture</html>'; }
''' + apk.snippet("add_header X-Content-Type-Options nosniff always;", "/lab/current") + "} }")
    name = "chunmo-source-check-" + str(os.getpid())
    docker("run", "-d", "--name", name, "-p", "127.0.0.1:18444:443", "-v", work + ":/lab:ro",
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
        p.fetch = get
        url = p.verify("https://chmsj.cn", data)
        assert get("", "/")[1] == before
        assert get("", "/api/health")[1] == b'{"ok":true}'
        assert get("", "/download/chunmo-photo-test.apk")[1] == b"existing-APK-fixture-unchanged"
        print("PASS isolated Nginx HTTPS: source ZIP GET/HEAD/Range, MIME, attachment, exact bytes; existing site/API/APK fixture unchanged.")
        print("Production deployment NOT performed; actual website URL remains pending Workbench execution.")
    finally:
        docker("rm", "-f", name)
