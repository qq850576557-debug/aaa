#!/usr/bin/env python3
"""Prepare the isolated owner DevTools project and publish one exact ZIP route."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import zipfile

import publish as source_delivery


COMMIT = "4d903830932bc9624fef3200b2eba992c59a473f"
RELEASE = "wechat-owner-preview-4d90383"
FILENAME = "chunmo-owner-preview-wechat.zip"
SHA256 = "33eb27824913be9e0b2f424ae2db34e043e70aae3b4415aab9d34be2a1da413f"
PROJECT = "chunmo-owner-preview"
SOURCE_DIR = "miniprogram/chunmo-photo/"
SOURCE_PATHS = ("owner-login", "app.wxss", "sitemap.json", "project.config.json")
BLOCKED_PAGE = "preview-only/index"
OWNER_PAGES = [
    "owner-login/pages/{}/index".format(name)
    for name in ("welcome", "employee", "home", "purchases", "purchase", "profile")
]


def json_file(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def build_zip(repo):
    archive = source_delivery.run(
        "git", "-C", str(repo), "archive", "--format=tar", COMMIT,
        *(SOURCE_DIR + name for name in SOURCE_PATHS)
    )
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tree:
        for member in tree.getmembers():
            if member.isdir():
                continue
            if not member.isfile() or not member.name.startswith(SOURCE_DIR):
                raise ValueError("源码包出现非预期文件")
            name = member.name[len(SOURCE_DIR):]
            if ".." in name.split("/") or not any(
                name == path or name.startswith(path + "/") for path in SOURCE_PATHS
            ):
                raise ValueError("源码包路径超出业主预览范围")
            files[name] = tree.extractfile(member).read()

    project = json.loads(files["project.config.json"].decode("utf-8"))
    project.update(description="春茉业主小程序 · 测试包", appid="touristappid", projectname=PROJECT)
    project["packOptions"]["ignore"] = [{"type": "file", "value": "README-导入说明.txt"}]
    files["project.config.json"] = json_file(project)
    files["app.js"] = b"""App({
  privacyResolvers: [],
  onLaunch() {
    wx.onNeedPrivacyAuthorization?.((resolve) => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page?.route !== 'owner-login/pages/profile/index') {
        resolve({ event: 'disagree' });
        return;
      }
      this.privacyResolvers.push(resolve);
      page.setData({ privacyVisible: true });
    });
  },
  resolvePrivacy(agree) {
    this.privacyResolvers.splice(0).forEach((resolve) => resolve(
      agree ? { event: 'agree', buttonId: 'chunmo-privacy-agree' } : { event: 'disagree' },
    ));
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    if (page?.route === 'owner-login/pages/profile/index') page.setData({ privacyVisible: false });
  },
});
"""
    files["app.json"] = json_file({
        "pages": OWNER_PAGES + [BLOCKED_PAGE],
        "window": {
            "navigationBarTitleText": "春茉业主端预览",
            "navigationBarBackgroundColor": "#f5f7f3",
            "navigationBarTextStyle": "black",
            "backgroundColor": "#f5f7f3",
        },
        "sitemapLocation": "sitemap.json",
    })
    files[BLOCKED_PAGE + ".js"] = b"Page({});\n"
    files[BLOCKED_PAGE + ".json"] = json_file({"navigationBarTitleText": "春茉业主端预览"})
    files[BLOCKED_PAGE + ".wxml"] = (
        '<view class="page"><view class="panel">请在微信开发者工具中编译此测试包。</view></view>\n'
    ).encode("utf-8")

    guard = "owner-login/preview.js"
    original = b"""  const version = wx.getAccountInfoSync?.().miniProgram?.envVersion;
  if (version !== 'develop' && version !== 'trial') {
    wx.reLaunch({ url: '/pages/login/index' });"""
    # DevTools may report no account version when compiling with the guest AppID.
    standalone = b"""  const platform = wx.getDeviceInfo?.()?.platform;
  let version;
  try {
    version = wx.getAccountInfoSync?.()?.miniProgram?.envVersion;
  } catch (error) {
    if (platform !== 'devtools') throw error;
  }
  const simulatorGuest = platform === 'devtools' && !version;
  if (!simulatorGuest && version !== 'develop' && version !== 'trial') {
    wx.reLaunch({ url: '/preview-only/index' });"""
    if files[guard].count(original) != 1:
        raise ValueError("业主预览入口与已核对的源码不符")
    files[guard] = files[guard].replace(original, standalone)
    files["README-导入说明.txt"] = (
        "春茉业主小程序 · 微信开发者工具测试包\r\n\r\n"
        "解压 ZIP，导入含 project.config.json 的 chunmo-owner-preview 文件夹。\r\n"
        "保留包内游客 AppID。需要选择 AppID 时用测试号，后端服务选不使用云服务。\r\n"
        "点击编译，勾选协议后通过微信快捷登录进入业主演示。\r\n"
        "员工登录界面可用任意测试文字。此包使用演示数据，无需真实账号、手机号或 AppSecret。\r\n"
        "开发版点击右下角调整 UI，可预览并复制配置。\r\n"
        "真机测试请用获授权的 AppID，并先在微信公众平台配置相册用途。\r\n"
        "源码提交：" + COMMIT + "\r\n"
    ).encode("utf-8-sig")

    output = io.BytesIO()
    # Stable bytes across Python and zlib versions on Workbench.
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as target:
        for name, content in sorted(files.items()):
            entry = zipfile.ZipInfo(PROJECT + "/" + name, (2026, 11, 21, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            target.writestr(entry, content)
    return output.getvalue()


def configure_delivery():
    source_delivery.RELEASE = RELEASE
    source_delivery.FILENAME = FILENAME
    source_delivery.EXPECTED_SHA = SHA256
    source_delivery.SOURCE_SNIPPET = source_delivery.STATE / "routes" / (RELEASE + ".conf")
    source_delivery.ROUTE = "/download/releases/" + RELEASE + "/" + FILENAME


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path("/opt/chunmo-source"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if not (args.output or args.publish):
        parser.error("请选择 --output 或 --publish")
    try:
        data = build_zip(args.repo)
        if hashlib.sha256(data).hexdigest() != SHA256:
            raise ValueError("测试 ZIP 的 SHA-256 与已核对的发布值不一致")
        if args.output:
            args.output.write_bytes(data)
            print(str(args.output), len(data), SHA256)
        if args.publish:
            configure_delivery()
            source_delivery.publish(data, args.repo)
    except subprocess.CalledProcessError:
        raise SystemExit("发布未完成：无法读取固定提交，请检查 Git fetch 是否成功")
    except (OSError, ValueError) as error:
        raise SystemExit("发布未完成：" + str(error))


if __name__ == "__main__":
    main()
