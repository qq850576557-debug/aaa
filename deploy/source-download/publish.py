#!/usr/bin/env python3
"""Publish a deterministic source ZIP through the EXISTING APK HTTPS route.

No checkout/pull/build, nginx reload/config edits, API restart or DB operations.
Only creates one immutable directory under /var/lib/chunmo-downloads/releases.
"""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import zipfile

SOURCE = "b9a97ff0c996c616733affd7cd21030e4ff1f817"
RELEASE = "wechat-photo-source-b9a97ff"
FILENAME = "chunmo-wechat-photo-v1-b9a97ff.zip"
PATHS = ["miniprogram/chunmo-photo", "docs/wechat-photo-v1-delivery.md", "docs/wechat-photo-v1-render-results.json", "docs/screenshots/wechat-photo-v1"]
STATE = Path("/var/lib/chunmo-downloads")
EXPECTED_SHA = "70e69a53df9b30667b4bbdfd768db8383a94f1d2a3169d3bf250ad0ab3b37e0b"


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.PIPE)


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
            host = origin.removeprefix("https://")
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


def publish(data):
    if os.geteuid() != 0:
        raise ValueError("请在阿里云Workbench中使用root执行")
    if hashlib.sha256(data).hexdigest() != EXPECTED_SHA:
        raise ValueError("源码ZIP与已核对的开发包SHA-256不同，未发布")
    public = json.loads(Path("/etc/chunmo-staging/public-https.json").read_text())
    origin = public["origin"]
    if origin != "https://chmsj.cn":
        raise ValueError("实际HTTPS域名与已核对的下载域名不同，请先核对")
    snippet = Path("/etc/chunmo-staging/downloads/apk.conf").read_text()
    if not re.search(r"location\s+\^~\s+/download/releases/\s*\{\s*alias\s+/var/lib/chunmo-downloads/releases/;", snippet):
        raise ValueError("现有APK下载映射不匹配；未修改Nginx配置")
    start = run("systemctl", "show", "--property=ExecStart", "--value", "chunmo-staging-web").decode()
    if "/opt/chunmo-staging/nginx.conf" not in start:
        raise ValueError("Nginx服务使用未知配置，未发布")
    main_config = Path("/opt/chunmo-staging/nginx.conf").read_text()
    if "include /etc/chunmo-staging/downloads/*.conf;" not in main_config:
        raise ValueError("现有Nginx未加载APK下载配置，未发布")
    for path in (STATE, STATE / "releases"):
        if not path.is_dir() or path.is_symlink():
            raise ValueError("缺少之前APK使用的持久下载目录：" + str(path))
    with open("/run/lock/chunmo-staging-deploy.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print("正在检查原网站、API及HTTPS证书……", flush=True)
        health(origin)
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
        url = verify(origin, data)
        health(origin)
        print("PASS：HTTPS GET/HEAD/断点续传、大小与SHA-256核对完成。原网站和API正常。")
        print("下载地址：" + url)
        print("字节数：" + str(len(data)))
        print("SHA-256：" + EXPECTED_SHA)
        print("未更新网站版本、未重启服务、未修改Nginx或数据库。")


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
            publish(data)
    except Exception as error:
        # Do not print subprocess argv or arbitrary stderr containing credentials.
        print("发布未完成：" + (str(error) if not isinstance(error, subprocess.CalledProcessError) else "Git/curl/systemctl命令失败，请核对网络或现有网站状态"))
        raise SystemExit(1)
