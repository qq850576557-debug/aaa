"""Assemble the owner subpackage with a pinned employee application."""

import argparse
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import zipfile


ROOT = Path(__file__).resolve().parents[2]
APP = "miniprogram/chunmo-photo/"
APP_ID = "wxb48a7abb3858a252"
BASELINES = {
    "photo": "76737c345ec4abc4d0445e69b660162609003eec",
    "workbench": "01797e7a1b3467035b6a5d404fef9a526a9f3a5e",
}
REMEMBER_MODULE = "lib/employee-remember.js"


def archive(repo, commit, paths):
    data = subprocess.check_output(["git", "-C", str(repo), "archive", commit, *paths])
    with tarfile.open(fileobj=io.BytesIO(data)) as source:
        return {
            member.name.removeprefix(APP): source.extractfile(member).read()
            for member in source.getmembers()
            if member.isfile()
        }


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def add_employee_resume(files, helper, workbench):
    api_path = "lib/api.js"
    export = b"module.exports = { Api };"
    if files[api_path].count(export) != 1:
        raise ValueError("Unexpected employee API export")
    files[api_path] = files[api_path].replace(
        export, b"module.exports = { Api: require('./employee-remember').withEmployeeRemember(Api) };"
    )
    files[REMEMBER_MODULE] = helper
    page_path = "pages/login/index.js"
    src = files[page_path]
    start = re.search(rb"(?m)^  (?:async )?onLoad\(\) \{\n", src)
    if workbench and not start:
        raise ValueError("Unexpected employee login initialization")
    end = src.index(b"  accountInput(e)", start.end() if start else 0)
    is_workbench = b"true" if workbench else b"false"
    files[page_path] = (
        b"const { resumeEntry } = require('../../lib/employee-remember');\n"
        + src[:start.start() if start else end]
        + b"  onLoad(options) {\n"
        + b"    this.setData({ login: getApp().pendingLogin || '' });\n"
        + b"    return resumeEntry(this, options, " + is_workbench + b");\n  },\n"
        + src[end:]
    )
    password = "pages/password/index.js"
    if password in files:
        anchor = b"await call('redirectTo', { url: '/pages/login/index' })"
        if files[password].count(anchor) != 1:
            raise ValueError("Unexpected employee switch-account route")
        files[password] = files[password].replace(
            anchor, b"await call('redirectTo', { url: '/pages/login/index?manual=1' })"
        )


def build(repo, owner_sha, employee, terms=None):
    if not re.fullmatch(r"[a-f0-9]{40}", owner_sha):
        raise ValueError("Provide the full owner Git SHA")
    if terms is not None and (
        not isinstance(terms, dict)
        or set(terms) != {"version", "text"}
        or not isinstance(terms["version"], str)
        or not 1 <= len(terms["version"].strip()) <= 80
        or not isinstance(terms["text"], str)
        or not 1 <= len(terms["text"].strip()) <= 6000
    ):
        raise ValueError("Provide approved terms with version and text")

    files = archive(repo, BASELINES[employee], [APP.rstrip("/")])
    owner = archive(repo, owner_sha, [APP + "owner-login", APP + "app.json", APP + REMEMBER_MODULE])
    add_employee_resume(files, owner.pop(REMEMBER_MODULE), employee == "workbench")
    app = json.loads(files["app.json"])
    subpackage, = [p for p in json.loads(owner.pop("app.json"))["subPackages"] if p["root"] == "owner-login"]
    subpackage["pages"].remove("pages/employee/index")
    if any(p["root"] == "owner-login" for p in app.get("subPackages", [])):
        raise ValueError("The employee baseline already contains an owner subpackage")
    app.setdefault("subPackages", []).append(subpackage)
    files["app.json"] = encoded(app)
    files.update({key: value for key, value in owner.items() if not key.startswith("owner-login/pages/employee/")})

    project = json.loads(files["project.config.json"])
    if project["appid"] != APP_ID or not project["setting"]["urlCheck"]:
        raise ValueError("The employee AppID or domain validation does not match the baseline")
    login = "pages/login/index.wxml"
    anchor = b'<button class="quiet" bindtap="privacyContract">'
    if files[login].count(anchor) != 1:
        raise ValueError("Unexpected employee login template")
    entry = '<navigator class="quiet" style="text-align:center; padding:12px" url="/owner-login/pages/welcome/index">业主微信登录</navigator>\n'
    files[login] = files[login].replace(anchor, entry.encode("utf-8") + anchor)
    files["owner-login/owner-live-config.js"] = b"module.exports = " + encoded({
        "deployment": "production", "origin": "https://chmsj.cn", "appId": APP_ID, "terms": terms,
    }).rstrip() + b";\n"

    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for name, content in sorted(files.items()):
            if name.startswith(("tests/", "tools/")) or name in ("README.md", "package.json"):
                continue
            item = zipfile.ZipInfo("chunmo-release-candidate/" + name, (2026, 11, 23, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(item, content)
    return result.getvalue()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-sha", required=True)
    parser.add_argument("--employee", required=True, choices=BASELINES)
    parser.add_argument("--terms", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    terms = json.loads(options.terms.read_text(encoding="utf-8")) if options.terms else None
    if options.terms and terms is None:
        parser.error("The approved terms file cannot be null")
    options.output.write_bytes(build(ROOT, options.owner_sha, options.employee, terms))
