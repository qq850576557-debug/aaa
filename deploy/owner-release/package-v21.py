"""Create the trial-only V2.1 WeChat package from a fixed Git SHA."""
import argparse
import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from package import APP, archive, encoded

ORIGIN = 'https://owner-test.chmsj.cn'


def build(repo, commit, app_id, output):
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Provide the full V2.1 Git SHA')
    if not re.fullmatch(r'wx[a-fA-F0-9]{16}', app_id):
        raise ValueError('Provide the isolated test application AppID')
    files = archive(repo, commit, [APP.rstrip('/')])
    app = json.loads(files['app.json'])
    if app['pages'][0] != 'owner-login/pages/welcome/index':
        raise ValueError('This SHA is missing the standalone unified entry')
    project = json.loads(files['project.config.json'])
    project['appid'] = app_id
    project['setting']['urlCheck'] = True
    files['project.config.json'] = encoded(project)
    files['config.js'] = b'module.exports = Object.freeze(' + encoded({
        'origin': ORIGIN,
        'apiPrefix': '/api/mini-photo-candidate/',
        'version': '2.1-isolated',
    }).rstrip() + b');\n'
    files['owner-login/owner-live-config.js'] = b'module.exports = ' + encoded({
        'deployment': 'isolated',
        'unified': True,
        'origin': ORIGIN,
        'appId': app_id,
        'terms': {'version': 'V2.1-test', 'text': '本包仅限隔离测试。请使用已授权测试账号及演示数据。'},
    }).rstrip() + b';\n'
    files['README-测试包.txt'] = (
        '春茉 V2.1 隔离测试包\n'
        f'Git SHA {commit}\n服务端 {ORIGIN}\n'
        '请使用隔离测试 AppID、允许访问该域名的体验成员及合成测试账号。\n'
        '导入本目录并预览。统一登录、员工工作台和业主采购需隔离环境的对应 API。\n'
    ).encode()
    with ZipFile(output, 'w', compression=ZIP_DEFLATED) as package:
        size = 0
        for name, data in sorted(files.items()):
            if name.startswith(('tests/', 'tools/')) or name in ('README.md', 'package.json'):
                continue
            size += len(data)
            item = ZipInfo('chunmo-v21-test/' + name, (2026, 11, 25, 0, 0, 0))
            item.compress_type = ZIP_DEFLATED
            package.writestr(item, data)
        if size > 2_000_000:
            raise ValueError('The single Mini Program package exceeds 2 MB')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--sha', required=True)
    parser.add_argument('--test-app-id', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.repo, args.sha, args.test_app_id, args.output)
