#!/usr/bin/env python3
"""Publish the already tested APK only. No builds, DB access or API restarts.

Run as root in Aliyun Workbench. Unknown server layouts fail closed.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

SIZE = 11030504
SHA = "f6a1046dbd7b66125971573b16b435d31b34bc1f45e1d12543d0d8b7859a4d8d"
CERT = "011aa52c0ad4ee183a42fc34542d312ff924f6ef2ed22ec6bb340451f8ba6501"
HOOK = "include /etc/chunmo-staging/downloads/*.conf;"
BASE = Path("/opt/chunmo-staging")
STATE = Path("/var/lib/chunmo-downloads")
CONFIG = BASE / "nginx.conf"
SNIPPET = Path("/etc/chunmo-staging/downloads/apk.conf")
SW = BASE / "current/dist/sw.js"
UNIT = "chunmo-staging-web"
SW_OLD = "url.pathname.startsWith('/api/')"
SW_NEW = SW_OLD + " ||\n    url.pathname === '/download' ||\n    url.pathname.startsWith('/download/')"


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_apk(path):
    if not path.is_file() or path.stat().st_size != SIZE or digest(path) != SHA:
        raise ValueError("APK size/SHA-256 differs from the tested package; nothing published")


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def statements(text):
    """Small conservative nginx lexer: retain directive bytes, ignore quoted braces/comments."""
    tokens = list(re.finditer(r'''"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\#[^\n]*|[{};]|[^\s{};\#]+''', text))
    root = {"words": [], "directives": [], "children": [], "start": 0}
    stack, words, start = [root], [], 0
    for token in tokens:
        word = token.group()
        if word.startswith("#"):
            continue
        if not words:
            start = token.start()
        if word == "{":
            node = {"words": words, "directives": [], "children": [], "start": start}
            stack[-1]["children"].append(node)
            stack.append(node)
            words = []
        elif word == "}":
            if words or len(stack) == 1:
                raise ValueError("Unexpected nginx braces; review config manually")
            stack.pop()["end"] = token.end()
        elif word == ";":
            stack[-1]["directives"].append((words, start, token.end()))
            words = []
        else:
            words.append(word.strip("\"'"))
    if words or len(stack) != 1:
        raise ValueError("Incomplete nginx config")
    return root


def configure(text, host):
    tree = statements(text)
    http = [n for n in tree["children"] if n["words"] == ["http"]]
    if len(http) != 1:
        raise ValueError("Expected one explicit http block")
    servers = []
    for node in http[0]["children"]:
        ds = node["directives"]
        if node["words"] == ["server"] and any(w[0] == "server_name" and host in w[1:] for w, _, _ in ds) and any(w[0] == "listen" and w[1] in ("443", "0.0.0.0:443", "[::]:443") and "ssl" in w for w, _, _ in ds):
            servers.append(node)
    if len(servers) != 1:
        raise ValueError("Expected exactly one existing HTTPS :443 server for configured domain")
    server = servers[0]
    ds = server["directives"]
    if any(n["words"][0:1] == ["location"] and any("/download" in w for w in n["words"]) for n in server["children"]):
        raise ValueError("Existing /download location found; review before replacing")
    certificates = [w[1] for w, _, _ in ds if w[0] == "ssl_certificate"]
    if len(certificates) != 1 or "$" in certificates[0]:
        raise ValueError("Expected an explicit existing public certificate")
    # Nginx add_header inheritance stops when a child adds any headers. Copy ALL
    # effective parent security headers, including site-specific HSTS/CSP.
    header_ds = [d for d in ds if d[0][0] == "add_header"] or [d for d in http[0]["directives"] if d[0][0] == "add_header"]
    headers = "\n".join(text[a:b] for w, a, b in header_ds if w[1].lower() not in ("cache-control", "content-disposition"))
    if not any(text[a:b].strip() == HOOK for _, a, b in ds):
        _, _, at = next(d for d in ds if d[0][0] == "server_name")
        text = text[:at] + "\n    " + HOOK + text[at:]
    return text, headers, certificates[0]


def snippet(headers, root=STATE / "current"):
    root = str(root)
    if not re.fullmatch(r"/[a-zA-Z0-9_./-]+", root):
        raise ValueError("Unsafe static path")
    return f'''# APK downloads only; original website/API routes remain unchanged.
location = /download {{ return 308 /download/; }}
location = /download/chunmo-photo-test.apk {{
  alias {root}/chunmo-photo-test.apk;
  types {{ }}
  default_type application/vnd.android.package-archive;
  {headers}
  add_header Cache-Control "no-cache" always;
  add_header Content-Disposition 'attachment; filename="chunmo-photo-test.apk"' always;
}}
location ^~ /download/ {{
  alias {root}/;
  index index.html;
  autoindex off;
  types {{ text/html html; text/css css; image/png png; text/plain txt; application/json json; }}
  default_type text/plain;
  {headers}
  add_header Cache-Control "no-cache" always;
}}
'''


def patch_sw(text):
    if "url.pathname.startsWith('/download/')" in text:
        return text
    if text.count(SW_OLD) != 1:
        raise ValueError("Unknown service worker; cannot safely exclude download pages from app-shell cache")
    return text.replace(SW_OLD, SW_NEW, 1)


def atomic(path, content, mode=0o644):
    fd, temp = tempfile.mkstemp(prefix=".apk-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp, mode)
        if path.exists():
            stat = path.stat()
            os.chown(temp, stat.st_uid, stat.st_gid)
            os.chmod(temp, stat.st_mode & 0o777)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def point(target):
    temp = STATE / (".current-" + str(os.getpid()))
    temp.symlink_to(target)
    os.replace(temp, STATE / "current")


def get(origin, route, local=False, extra=()):
    host = origin.removeprefix("https://")
    with tempfile.TemporaryDirectory(prefix="chunmo-apk-check-") as temp:
        args = ["curl", "--fail", "--silent", "--show-error", "--proto", "=https", "--connect-timeout", "8", "--max-time", "45", "--dump-header", temp + "/headers", "--output", temp + "/body"]
        if local:
            args += ["--noproxy", host, "--resolve", host + ":443:127.0.0.1"]
        run(*args, *extra, origin + route)
        headers = Path(temp + "/headers").read_text().lower()
        return headers, Path(temp + "/body").read_bytes()


def website(origin):
    for local in (True, False):
        _, body = get(origin, "/", local)
        if b"<html" not in body.lower():
            raise ValueError("Existing website did not return HTML")
        _, body = get(origin, "/api/health", local)
        if json.loads(body).get("ok") is not True:
            raise ValueError("Existing API health check failed")


def nginx_test(nginx):
    # Validate with the SAME unprivileged identity/capabilities as the service.
    run("setpriv", "--reuid=chunmo-staging-web", "--regid=chunmo-staging-web", "--init-groups", "--bounding-set=-all,+net_bind_service", "--inh-caps=-all,+net_bind_service", "--ambient-caps=-all,+net_bind_service", "--no-new-privs", "--", nginx, "-t", "-p", "/var/lib/chunmo-staging-web/", "-c", str(CONFIG))


def reload_web():
    run("systemctl", "kill", "--kill-whom=main", "--signal=HUP", UNIT)


def active_services():
    for unit in (UNIT, "chunmo-staging-api"):
        run("systemctl", "is-active", "--quiet", unit)


def verify_downloads(origin):
    for local in (True, False):
        h, body = get(origin, "/download/chunmo-photo-test.apk", local)
        if "application/vnd.android.package-archive" not in h or "content-disposition: attachment" not in h or f"content-length: {SIZE}" not in h or hashlib.sha256(body).hexdigest() != SHA:
            raise ValueError("Download response/size/SHA mismatch")
        h, _ = get(origin, "/download/chunmo-photo-test.apk", local, ("--head",))
        if "application/vnd.android.package-archive" not in h or f"content-length: {SIZE}" not in h:
            raise ValueError("APK HEAD/MIME/length check failed")
        h, body = get(origin, "/download/chunmo-photo-test.apk", local, ("--range", "0-31"))
        if "206 partial content" not in h or len(body) != 32:
            raise ValueError("Byte range/resume check failed")
        _, body = get(origin, "/download/", local)
        if "春茉工地拍照".encode() not in body:
            raise ValueError("Download page check failed")


def wait_for_downloads(origin):
    # HUP starts workers asynchronously. An initial successful APK request does
    # not prove every subsequent request has stopped reaching old workers.
    deadline = time.monotonic() + 15
    for attempt in range(6):
        try:
            verify_downloads(origin)
            time.sleep(0.2)
            verify_downloads(origin)
            return
        except (ValueError, subprocess.CalledProcessError):
            if attempt == 5 or time.monotonic() >= deadline:
                raise
            time.sleep(0.5)


def publish(apk, logo, check_only=False):
    verify_apk(apk)
    for path in (CONFIG, SW, SNIPPET):
        if path.is_symlink():
            raise ValueError("Unknown symlinked config/file; no changes made: " + str(path))
    if SNIPPET.exists() and not SNIPPET.read_text().startswith("# APK downloads only;"):
        raise ValueError("Existing unmanaged apk.conf; review before publication")
    nginx = shutil.which("nginx")
    if not nginx:
        raise ValueError("Existing nginx executable not found")
    active_services()
    start = run("systemctl", "show", "--property=ExecStart", "--value", UNIT)
    if str(CONFIG) not in start or "/var/lib/chunmo-staging-web/" not in start:
        raise ValueError("Web unit uses an unknown nginx config; no changes made")
    public = json.loads(Path("/etc/chunmo-staging/public-https.json").read_text())
    origin = public["origin"]
    if not re.fullmatch(r"https://[a-zA-Z0-9.-]+", origin) or public.get("mode"):
        raise ValueError("Need an existing publicly trusted domain on HTTPS port 443")
    host = origin.removeprefix("https://")
    print("Configured origin:", origin, flush=True)
    socket.getaddrinfo(host, 443)  # real DNS, no hardcoded public IP
    old_config = CONFIG.read_text()
    new_config, headers, certificate = configure(old_config, host)
    print(run("openssl", "x509", "-in", certificate, "-noout", "-subject", "-issuer", "-dates"))
    run("openssl", "x509", "-in", certificate, "-noout", "-checkend", "86400")
    nginx_test(nginx)
    website(origin)  # normal CA/hostname verification; never curl -k
    new_sw = patch_sw(SW.read_text())
    if not logo.is_file():
        raise ValueError("Original logo asset missing")
    if check_only:
        print("PASS preflight only; no configuration or files changed")
        return
    for directory in (STATE, STATE / "releases", STATE / "backups", SNIPPET.parent):
        if directory.is_symlink():
            raise ValueError("Managed directory must not be a symlink: " + str(directory))
        directory.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o755)
    os.chmod(STATE / "releases", 0o755)
    os.chmod(STATE / "backups", 0o700)
    os.chmod(SNIPPET.parent, 0o755)
    if shutil.disk_usage(STATE).free < 3 * SIZE:
        raise ValueError("Insufficient space for safe publication")
    release = STATE / "releases" / ("1.0.0-debug-" + SHA[:12])
    if release.exists():
        verify_apk(release / "chunmo-photo-test.apk")
    else:
        temp = Path(tempfile.mkdtemp(prefix=".incoming-", dir=STATE / "releases"))
        os.chmod(temp, 0o755)
        for filename in ("index.html", "download.css"):
            shutil.copyfile(Path(__file__).parent / filename, temp / filename)
        shutil.copyfile(logo, temp / "logo.png")
        shutil.copyfile(apk, temp / "chunmo-photo-test.apk")
        verify_apk(temp / "chunmo-photo-test.apk")
        (temp / "SHA256SUMS").write_text(SHA + "  chunmo-photo-test.apk\n")
        (temp / "release.json").write_text(json.dumps({"package": "cn.chmsj.photo", "version": "1.0.0-internal", "versionCode": 1, "debug": True, "bytes": SIZE, "sha256": SHA, "certificateSha256": CERT}, indent=2) + "\n")
        for file in temp.iterdir():
            file.chmod(0o644)
        os.rename(temp, release)
    current = STATE / "current"
    if current.exists() and not current.is_symlink():
        raise ValueError("Unmanaged current download directory; refusing to replace")
    previous = os.readlink(current) if current.is_symlink() else None
    backup = Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%d-%H%M%S-"), dir=STATE / "backups"))
    originals = {CONFIG: CONFIG.read_bytes(), SW: SW.read_bytes(), SNIPPET: SNIPPET.read_bytes() if SNIPPET.exists() else None}
    for path, content in originals.items():
        if content is not None:
            (backup / path.name).write_bytes(content)
    (backup / "previous-download-target.txt").write_text(previous or "(none)")
    print("Backup:", backup, flush=True)
    try:
        atomic(SNIPPET, snippet(headers).encode())
        atomic(CONFIG, new_config.encode())
        # A narrow cache exclusion only. Keep cache name, lifecycle, API and ALL
        # IndexedDB data intact; do not unregister the worker or clear site data.
        atomic(SW, new_sw.encode())
        point(str(release))
        nginx_test(nginx)
        reload_web()  # HUP only; API process and active requests are preserved
        wait_for_downloads(origin)
        website(origin)
        active_services()
    except BaseException:
        for path, content in originals.items():
            if content is None:
                path.unlink(missing_ok=True)
            else:
                atomic(path, content)
        if previous is None:
            current.unlink(missing_ok=True)
        else:
            point(previous)
        nginx_test(nginx)
        reload_web()
        print("Publication failed; previous configuration restored. APK retained. Backup: " + str(backup), file=sys.stderr)
        raise
    print("PASS download publication + original website/API health (local TLS and public DNS)")
    print("Page:", origin + "/download/")
    print("APK:", origin + "/download/chunmo-photo-test.apk")
    print("Bytes:", SIZE, "SHA-256:", SHA)
    print("No build, DB access, API restart, new ports or firewall changes.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--logo", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run as root in Aliyun Workbench")
    # Same deployment lock as the existing updater; never race a site update.
    with open("/run/lock/chunmo-staging-deploy.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        publish(args.apk, args.logo, args.check_only)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print("STOP:", error, file=sys.stderr)
        sys.exit(1)
