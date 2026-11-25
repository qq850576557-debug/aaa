"""Build an isolated or formal V2.1 WeChat candidate from a fixed Git SHA."""
import argparse
import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from package import APP, APP_ID, archive, encoded

TEST_ORIGIN = 'https://owner-test.chmsj.cn'
FORMAL_ORIGIN = 'https://chmsj.cn'


def build(repo, commit, app_id, output, contact=None):
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Provide the full V2.1 Git SHA')
    if not re.fullmatch(r'wx[a-fA-F0-9]{16}', app_id):
        raise ValueError('Provide a valid WeChat Mini Program AppID')
    if contact is not None and (
        app_id != APP_ID or not re.fullmatch(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', contact)
    ):
        raise ValueError('Formal candidate requires the approved AppID and privacy contact')
    formal = contact is not None
    origin = FORMAL_ORIGIN if formal else TEST_ORIGIN
    folder = 'chunmo-v21-formal' if formal else 'chunmo-v21-test'
    terms = {'version': 'V2.1-test', 'text': '本包仅限隔离测试。请使用已授权测试账号及演示数据。'}
    files = archive(repo, commit, [APP.rstrip('/')])
    app = json.loads(files['app.json'])
    if app['pages'][0] != 'owner-login/pages/welcome/index':
        raise ValueError('This SHA is missing the standalone unified entry')
    project = json.loads(files['project.config.json'])
    project['appid'] = app_id
    project['setting']['urlCheck'] = True
    files['project.config.json'] = encoded(project)
    files['config.js'] = b'module.exports = Object.freeze(' + encoded({
        'origin': origin,
        'apiPrefix': '/api/mini-photo-candidate/',
        'version': '2.1-formal' if formal else '2.1-isolated',
    }).rstrip() + b');\n'
    if formal:
        release = Path(__file__).resolve().parent
        text = (release / 'pilot-terms.txt').read_text(encoding='utf-8').strip().replace('@CONTACT@', contact)
        text += (
            '\n\n员工首次绑定微信时，使用原员工账号密码及微信授权手机号确认本人。'
            '员工主动选择的头像保存在本机对应账号下。经授权的业主可查看本住宅已发布的效果图和全景图，'
            '设计成果通过微信允许的业务域名页面展示。'
        )
        terms = {'version': 'V2.1', 'text': text}
    files['owner-login/owner-live-config.js'] = b'module.exports = ' + encoded({
        'deployment': 'production' if formal else 'isolated',
        'unified': True,
        'origin': origin,
        'appId': app_id,
        'terms': terms,
    }).rstrip() + b';\n'
    if formal:
        files['README-正式候选包.txt'] = (
            f'春茉 V2.1 正式候选包\nGit SHA {commit}\n服务端 {origin}\n'
            '正式 API 更新并完成体验版验收后，可上传微信公众平台审核。\n'
        ).encode()
    else:
        files['README-测试包.txt'] = (
            '春茉 V2.1 隔离测试包\n'
            f'Git SHA {commit}\n服务端 {origin}\n'
            '请使用隔离测试 AppID、允许访问该域名的体验成员及合成测试账号。\n'
            '导入本目录并预览。统一登录、员工工作台和业主采购需隔离环境的对应 API。\n'
        ).encode()
    with ZipFile(output, 'w', compression=ZIP_DEFLATED) as package:
        size = 0
        for name, data in sorted(files.items()):
            if name.startswith(('tests/', 'tools/')) or name in ('README.md', 'package.json'):
                continue
            size += len(data)
            item = ZipInfo(folder + '/' + name, (2026, 11, 25, 0, 0, 0))
            item.compress_type = ZIP_DEFLATED
            package.writestr(item, data)
        if size > 2_000_000:
            raise ValueError('The single Mini Program package exceeds 2 MB')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--sha', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--test-app-id')
    mode.add_argument('--formal-contact')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.repo, args.sha, args.test_app_id or APP_ID, args.output, args.formal_contact)
