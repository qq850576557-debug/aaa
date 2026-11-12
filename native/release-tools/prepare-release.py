#!/usr/bin/env python3
"""Prepare a signed internal update bundle. Does not connect to or deploy any server."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

CERT = "011aa52c0ad4ee183a42fc34542d312ff924f6ef2ed22ec6bb340451f8ba6501"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--apk", type=Path, required=True)
    p.add_argument("--build-tools", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--notes", required=True)
    a = p.parse_args()
    repo = Path(__file__).resolve().parents[2]
    if a.out.resolve().is_relative_to(repo):
        raise SystemExit("Use an artifact output directory outside the Git checkout")
    certs = subprocess.check_output([str(a.build_tools / "apksigner"), "verify", "--print-certs", str(a.apk)], text=True)
    if re.findall(r"certificate SHA-256 digest: ([a-f0-9]+)", certs) != [CERT]:
        raise SystemExit("STOP: incompatible signing key; do NOT uninstall any existing app")
    badging = subprocess.check_output([str(a.build_tools / "aapt2"), "dump", "badging", str(a.apk)], text=True)
    package = re.search(r"package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'", badging)
    if not package or package[1] != "cn.chmsj.photo" or int(package[2]) < 2 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+-internal", package[3]):
        raise SystemExit("STOP: unexpected package/version")
    sha = hashlib.sha256(a.apk.read_bytes()).hexdigest()
    previous_file = repo / "native/releases/current.json"
    if previous_file.exists():
        previous = json.loads(previous_file.read_text())
        if int(package[2]) < previous["versionCode"] or (int(package[2]) == previous["versionCode"] and sha != previous["sha256"]):
            raise SystemExit("STOP: increment versionCode for changed APK bytes")
    manifest = {"package": package[1], "versionCode": int(package[2]), "versionName": package[3], "bytes": a.apk.stat().st_size,
                "sha256": sha, "certificateSha256": CERT, "internalTest": True,
                "apkUrl": f"https://chmsj.cn/download/releases/{package[2]}-{sha[:12]}/chunmo-photo-{package[3]}.apk", "notes": a.notes}
    a.out.mkdir(parents=True, exist_ok=True)
    bundle = a.out / "publish"
    if bundle.exists():
        raise SystemExit("STOP: output already exists; choose a new output directory")
    shutil.copytree(repo / "deploy/apk-download", bundle / "deploy/apk-download", ignore=shutil.ignore_patterns("__pycache__"))
    logo = bundle / "public/brand/source"
    logo.mkdir(parents=True)
    shutil.copyfile(repo / "public/brand/source/chunmo-original-circle.png", logo / "chunmo-original-circle.png")
    shutil.copyfile(a.apk, bundle / "app.apk")
    (bundle / "update.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (a.out / "update.json").write_bytes((bundle / "update.json").read_bytes())
    shutil.copyfile(a.apk, a.out / f"chunmo-photo-{package[3]}.apk")
    (bundle / "install.sh").write_text('''#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
python3 deploy/apk-download/publish.py --apk app.apk --release update.json --logo public/brand/source/chunmo-original-circle.png "$@"
''')
    # Binary artifacts stay OUTSIDE the source repository and are never committed.
    with tarfile.open(a.out / "chunmo-photo-update.tar.gz", "w:gz") as tar:
        tar.add(bundle, arcname="chunmo-photo-update")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    print("Prepared only; NOT deployed:", a.out / "chunmo-photo-update.tar.gz")


if __name__ == "__main__":
    main()
