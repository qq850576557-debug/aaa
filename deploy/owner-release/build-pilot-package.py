"""Build a private WeChat review ZIP using the approved public contact."""

from pathlib import Path
import re
from runpy import run_path
import sys


def main(repo, output, contact):
    if not re.fullmatch(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', contact):
        raise SystemExit('FAIL 隐私邮箱格式不正确。')
    root = Path(__file__).resolve().parent
    build = run_path(str(root / 'package.py'))['build']
    terms = (root / 'pilot-terms.txt').read_text(encoding='utf-8').strip().replace('@CONTACT@', contact)
    privacy = (root / 'pilot-privacy.txt').read_text(encoding='utf-8').replace('@CONTACT@', contact)
    payload = build(Path(repo), '6aef816bd4a4e541dcf6425843050080d288aac4',
                    'workbench', {'version': '2026-11-25', 'text': terms})
    out = Path(output)
    (out / 'chunmo-wechat-formal-candidate.zip').write_bytes(payload)
    (out / 'wechat-privacy-text.txt').write_text(privacy, encoding='utf-8')


if __name__ == '__main__':
    main(*sys.argv[1:])
