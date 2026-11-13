#!/usr/bin/env python3
"""Python 3.6+ source delivery; reuses downloads or installs one exact ZIP route.

No website build/checkout, API restart, account changes or DB operations.
An absent route is backed up, syntax-tested, HUP-reloaded and rollback-protected.
"""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import zipfile

SOURCE = "b9a97ff0c996c616733affd7cd21030e4ff1f817"
RELEASE = "wechat-photo-source-b9a97ff"
FILENAME = "chunmo-wechat-photo-v1-b9a97ff.zip"
PATHS = ["miniprogram/chunmo-photo", "docs/wechat-photo-v1-delivery.md", "docs/wechat-photo-v1-render-results.json", "docs/screenshots/wechat-photo-v1"]
STATE = Path("/var/lib/chunmo-downloads")
EXPECTED_SHA = "70e69a53df9b30667b4bbdfd768db8383a94f1d2a3169d3bf250ad0ab3b37e0b"
CONFIG = Path("/opt/chunmo-staging/nginx.conf")
SOURCE_SNIPPET = STATE / "routes/source.conf"
APK_SNIPPET = Path("/etc/chunmo-staging/downloads/apk.conf")
SW = Path("/opt/chunmo-staging/current/dist/sw.js")
HOOK = "include /var/lib/chunmo-downloads/routes/*.conf;"
ROUTE = "/download/releases/" + RELEASE + "/" + FILENAME


def run(*args):
    try:
        return subprocess.check_output(args, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as error:
        name = Path(str(args[0])).name
        if name in ("curl", "nginx", "setpriv", "systemctl"):
            detail = (error.stderr or b"").decode("utf-8", "replace").strip()[-1600:]
            detail = re.sub(r"(?i)(https?://)[^\s/@]+:[^\s/@]+@", r"\1[redacted]@", detail)
            raise ValueError("{}失败（exit={}）：{}".format(name, error.returncode, detail or "请检查现有服务状态"))
        raise


def source_zip(repo):
    archive = run("git", "-C", str(repo), "archive", "--format=tar", SOURCE, *PATHS)
    output = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        files = [m for m in tar.getmembers() if m.isfile()]
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as target:
            for member in sorted(files, key=lambda m: m.name):
                if member.name.startswith("/") or ".." in member.name.split("/"):
                    raise ValueError("Unsafe Git archive path")
                if not any(member.name == p or member.name.startswith(p + "/") for p in PATHS):
                    raise ValueError("Unexpected source path")
                entry = zipfile.ZipInfo("chunmo-wechat-photo/" + member.name, (2026, 11, 13, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                target.writestr(entry, tar.extractfile(member).read())
            entry = zipfile.ZipInfo("chunmo-wechat-photo/打开说明.txt", (2026, 11, 13, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            target.writestr(entry, ("\ufeff春茉工地拍照 微信小程序 V1.0\r\n"
                "微信开发者工具导入：miniprogram/chunmo-photo\r\n"
                "已配置公开AppID：wxb48a7abb3858a252（认证中）\r\n"
                "接入和验收说明：docs/wechat-photo-v1-delivery.md\r\n"
                "此ZIP为小程序源码，不是服务器更新包。不要覆盖原网站；不含AppSecret。\r\n"
                "源码提交：" + SOURCE + "\r\n").encode("utf-8"))
    return output.getvalue()


def fetch(origin, route, local=False, extra=()):
    with tempfile.TemporaryDirectory(prefix="chunmo-source-check-") as directory:
        headers, body = Path(directory) / "headers", Path(directory) / "body"
        args = ["curl", "--fail", "--silent", "--show-error", "--proto", "=https",
                "--connect-timeout", "8", "--max-time", "35", "--dump-header", str(headers), "--output", str(body)]
        if local:
            host = origin[len("https://"):]
            args += ["--noproxy", host, "--resolve", host + ":443:127.0.0.1"]
        run(*args, *extra, origin + route)
        return headers.read_text().lower(), body.read_bytes()


def health(origin):
    for unit in ("chunmo-staging-web", "chunmo-staging-api"):
        run("systemctl", "is-active", "--quiet", unit)
    for local in (True, False):
        if b"<html" not in fetch(origin, "/", local)[1].lower():
            raise ValueError("Original website health check failed")
        if json.loads(fetch(origin, "/api/health", local)[1]).get("ok") is not True:
            raise ValueError("Original API health check failed")


def verify(origin, data):
    route = "/download/releases/" + RELEASE + "/" + FILENAME
    for local in (True, False):
        headers, downloaded = fetch(origin, route, local)
        if (downloaded != data or "content-disposition: attachment" not in headers or
            not any(m in headers for m in ("application/zip", "application/octet-stream")) or
            "content-length: " + str(len(data)) not in headers):
            raise ValueError("HTTPS download bytes/MIME/attachment/length check failed")
        head, _ = fetch(origin, route, local, ("--head",))
        if "content-length: " + str(len(data)) not in head:
            raise ValueError("ZIP HEAD check failed")
        partial_headers, partial = fetch(origin, route, local, ("--range", "0-31"))
        if re.findall(r"(?im)^http/\S+\s+(\d{3})", partial_headers)[-1:] != ["206"]:
            raise ValueError("ZIP range/resume response failed")
        if partial != data[:32]:
            raise ValueError("ZIP range bytes differ")
    return origin + route


def syntax_helpers(repo):
    # Reuse the reviewed conservative nginx lexer/serializer, not the old
    # publisher's Python-3.7+ subprocess wrapper or its APK release mutations.
    code = run("git", "-C", str(repo), "show", SOURCE + ":deploy/apk-download/publish.py")
    namespace = {"__name__": "chunmo_nginx_syntax", "__file__": "reviewed-nginx-syntax.py"}
    exec(compile(code, "reviewed-nginx-syntax.py", "exec"), namespace)
    # /etc/chunmo-staging is deliberately 0700 and stores database/key material.
    # Never relax that directory to make downloads visible to nginx's service UID.
    namespace["HOOK"] = HOOK
    return namespace


def source_snippet(headers):
    return ("# Managed Chunmo WeChat source ZIP only.\n"
            "location = " + ROUTE + " {\n"
            "  alias " + str(STATE / "releases" / RELEASE / FILENAME) + ";\n"
            "  types { }\n  default_type application/zip;\n"
            "  " + headers + "\n"
            "  add_header Content-Disposition 'attachment; filename=\"" + FILENAME + "\"' always;\n"
            "  add_header Cache-Control no-cache always;\n}\n")


def atomic(path, content, mode=0o644):
    fd, temporary = tempfile.mkstemp(prefix=".source-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, mode)
        if path.exists():
            previous = path.stat()
            os.chown(temporary, previous.st_uid, previous.st_gid)
            os.chmod(temporary, previous.st_mode & 0o777)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def nginx_check():
    binary = shutil.which("nginx")
    if not binary:
        raise ValueError("找不到现有nginx命令，未重载服务")
    run("setpriv", "--reuid=chunmo-staging-web", "--regid=chunmo-staging-web", "--init-groups",
        "--bounding-set=-all,+net_bind_service", "--inh-caps=-all,+net_bind_service",
        "--ambient-caps=-all,+net_bind_service", "--no-new-privs", "--", binary,
        "-t", "-p", "/var/lib/chunmo-staging-web/", "-c", str(CONFIG))


def reload_web():
    run("systemctl", "kill", "--kill-who=main", "--signal=HUP", "chunmo-staging-web")


def route_plan(repo):
    for path in (CONFIG, SOURCE_SNIPPET, SOURCE_SNIPPET.parent, APK_SNIPPET, SW):
        if path.is_symlink():
            raise ValueError("未知的软链接配置，未修改：" + str(path))
    original = CONFIG.read_bytes()
    old_snippet = SOURCE_SNIPPET.read_bytes() if SOURCE_SNIPPET.exists() else None
    old_sw = SW.read_bytes()
    helpers = syntax_helpers(repo)
    updated, headers, _ = helpers["configure"](original.decode("utf-8"), "chmsj.cn")
    # Always own one exact ZIP route. An old apk.conf can exist without being
    # readable/loaded by the running nginx, so its presence is not proof of routing.
    snippet = source_snippet(headers).encode("utf-8")
    if old_snippet is not None and not old_snippet.startswith(b"# Managed Chunmo WeChat source ZIP only.\n"):
        raise ValueError("source.conf已有非本工具管理的内容，未覆盖")
    new_sw = helpers["patch_sw"](old_sw.decode("utf-8")).encode("utf-8")
    return {"old_config": original, "config": updated.encode("utf-8"), "old_snippet": old_snippet,
            "snippet": snippet, "old_sw": old_sw, "sw": new_sw}


def restore_route(plan):
    atomic(CONFIG, plan["old_config"])
    atomic(SW, plan["old_sw"])
    if plan["old_snippet"] is None:
        if SOURCE_SNIPPET.exists():
            SOURCE_SNIPPET.unlink()
    else:
        atomic(SOURCE_SNIPPET, plan["old_snippet"])


def activate_route(plan, origin, data):
    changed = (plan["config"] != plan["old_config"] or plan["snippet"] != plan["old_snippet"] or plan["sw"] != plan["old_sw"])
    if not changed:
        return verify(origin, data)
    backups = STATE / "backups"
    if backups.is_symlink():
        raise ValueError("未知的备份目录软链接，未修改配置")
    backups.mkdir(mode=0o700, parents=True, exist_ok=True)
    backups.chmod(0o700)
    folder = Path(tempfile.mkdtemp(prefix="source-route-", dir=str(backups)))
    for key in ("old_config", "old_sw", "old_snippet"):
        if plan[key] is not None:
            file = folder / key
            file.write_bytes(plan[key])
            file.chmod(0o600)
    print("配置备份：" + str(folder), flush=True)
    nginx_check()  # existing configuration must already be valid
    if CONFIG.read_bytes() != plan["old_config"] or SW.read_bytes() != plan["old_sw"]:
        raise ValueError("配置在检查期间被其他操作修改，未覆盖")
    actual_snippet = SOURCE_SNIPPET.read_bytes() if SOURCE_SNIPPET.exists() else None
    if actual_snippet != plan["old_snippet"]:
        raise ValueError("下载配置在检查期间变化，未覆盖")
    try:
        SOURCE_SNIPPET.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        SOURCE_SNIPPET.parent.chmod(0o755)
        if plan["snippet"] is not None:
            atomic(SOURCE_SNIPPET, plan["snippet"])
        atomic(CONFIG, plan["config"])
        if plan["sw"] != plan["old_sw"]:
            atomic(SW, plan["sw"])
        nginx_check()
        reload_web()  # HUP, not restart; no API process is touched
        for attempt in range(8):
            try:
                result = verify(origin, data)
                health(origin)
                return result
            except (ValueError, subprocess.CalledProcessError):
                if attempt == 7:
                    raise
                time.sleep(0.5)
    except Exception as publication_error:
        print("验证未通过，正在恢复原下载配置……", flush=True)
        failures = []
        try:
            restore_route(plan)
        except Exception as error:
            failures.append("恢复文件失败：" + str(error))
        if not failures:
            try:
                nginx_check()
                reload_web()
            except Exception as error:
                failures.append("原配置重载失败：" + str(error))
        try:
            health(origin)
        except Exception as error:
            failures.append("服务健康检查失败：" + str(error))
        if failures:
            raise ValueError("发布失败：{}；回滚未完全确认：{}；备份保留在 {}，禁止视为发布成功".format(
                publication_error, "；".join(failures), folder))
        print("原配置已恢复并重载；此次发布失败，不输出PASS。", flush=True)
        raise


def publish(data, repo=None):
    if os.geteuid() != 0:
        raise ValueError("请在阿里云Workbench中使用root执行")
    if hashlib.sha256(data).hexdigest() != EXPECTED_SHA:
        raise ValueError("源码ZIP与已核对的开发包SHA-256不同，未发布")
    public = json.loads(Path("/etc/chunmo-staging/public-https.json").read_text())
    origin = public["origin"]
    if origin != "https://chmsj.cn":
        raise ValueError("实际HTTPS域名与已核对的下载域名不同，请先核对")
    start = run("systemctl", "show", "--property=ExecStart", "--value", "chunmo-staging-web").decode()
    if str(CONFIG) not in start or "/var/lib/chunmo-staging-web/" not in start:
        raise ValueError("Nginx服务使用未知配置，未发布")
    for path in (STATE, STATE / "releases"):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError("未知的持久下载目录：" + str(path))
    with open("/run/lock/chunmo-staging-deploy.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print("正在检查原网站、API及HTTPS证书……", flush=True)
        health(origin)
        plan = route_plan(repo or Path("/opt/chunmo-source"))
        for path in (STATE, STATE / "releases"):
            path.mkdir(mode=0o755, parents=True, exist_ok=True)
            path.chmod(0o755)
        destination = STATE / "releases" / RELEASE
        if destination.exists() or destination.is_symlink():
            if destination.is_symlink() or (destination / FILENAME).is_symlink() or (destination / FILENAME).read_bytes() != data:
                raise ValueError("同名发布目录已存在且不一致；未覆盖任何文件")
        else:
            with tempfile.TemporaryDirectory(prefix=".wechat-source-", dir=STATE / "releases") as staging:
                folder = Path(staging) / RELEASE
                folder.mkdir(mode=0o755)
                folder.chmod(0o755)
                archive = folder / FILENAME
                archive.write_bytes(data)
                archive.chmod(0o644)
                checksum = folder / "SHA256SUMS"
                checksum.write_text(EXPECTED_SHA + "  " + FILENAME + "\n")
                checksum.chmod(0o644)
                if hashlib.sha256(archive.read_bytes()).hexdigest() != EXPECTED_SHA:
                    raise ValueError("持久目录写入校验失败")
                os.rename(folder, destination)
        url = activate_route(plan, origin, data)
        health(origin)
        print("PASS：HTTPS GET/HEAD/断点续传、大小与SHA-256核对完成。原网站和API正常。")
        print("下载地址：" + url)
        print("字节数：" + str(len(data)))
        print("SHA-256：" + EXPECTED_SHA)
        print("未更新网站版本、未重启API、未修改数据库；下载入口按需补齐并平滑重载Nginx。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path("/opt/chunmo-source"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    try:
        data = source_zip(args.repo)
        if args.output:
            args.output.write_bytes(data)
            print(str(args.output), len(data), hashlib.sha256(data).hexdigest())
        if args.publish:
            publish(data, args.repo)
    except Exception as error:
        # Do not print subprocess argv or arbitrary stderr containing credentials.
        print("发布未完成：" + (str(error) if not isinstance(error, subprocess.CalledProcessError) else "Git/curl/systemctl命令失败，请核对网络或现有网站状态"))
        raise SystemExit(1)
