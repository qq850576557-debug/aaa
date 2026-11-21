"""Build the dedicated owner handset preview package using only checked-in assets."""
import io
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/source-download"))
import owner_preview as demo

APP_ID = "wxb48a7abb3858a252"
ORIGIN = "https://owner-test.chmsj.cn"
PREFIX = "chunmo-owner-preview/"


def build(repo, source_root):
    # Reuse the checked standalone application shell, with the live owner's pages
    # from the same fixed source tree as the isolated test website.
    with zipfile.ZipFile(io.BytesIO(demo.build_zip(repo))) as source:
        files = {name: source.read(name) for name in source.namelist()
                 if not name.startswith(PREFIX + "owner-login/")}
    owner = source_root / "miniprogram/chunmo-photo/owner-login"
    for file in owner.rglob("*"):
        if file.is_symlink():
            raise ValueError("Unexpected symlink in miniature project")
        if file.is_file():
            files[PREFIX + "owner-login/" + file.relative_to(owner).as_posix()] = file.read_bytes()
    project = json.loads(files[PREFIX + "project.config.json"].decode("utf-8"))
    project.update(appid=APP_ID, projectname="chunmo-owner-test", description="春茉业主独立测试")
    files[PREFIX + "project.config.json"] = demo.json_file(project)
    files[PREFIX + "owner-login/owner-live-config.js"] = (
        "module.exports = " + json.dumps({"origin": ORIGIN, "appId": APP_ID}) + ";\n"
    ).encode("ascii")
    guard = PREFIX + "owner-login/preview.js"
    old = b"'/pages/login/index'"
    if files[guard].count(old) != 1:
        raise ValueError("Unknown standalone release guard")
    files[guard] = files[guard].replace(old, b"'/preview-only/index'")
    files[PREFIX + "README-导入说明.txt"] = (
        "春茉业主手机号联调\r\n导入本目录，保留项目 AppID。\r\n"
        "使用独立测试网址 owner-test.chmsj.cn 与测试项目。\r\n"
        "按负责人提供的邀请路径添加自定义编译，选用该模式预览后真机扫码。\r\n"
        "正式版阻止启动。\r\n"
    ).encode("utf-8-sig")
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for name in sorted(files):
            target.writestr(zipfile.ZipInfo(name, (2026, 11, 21, 0, 0, 0)), files[name], zipfile.ZIP_DEFLATED)
    return result.getvalue()


if __name__ == "__main__":
    Path(sys.argv[3]).write_bytes(build(Path(sys.argv[1]), Path(sys.argv[2])))
