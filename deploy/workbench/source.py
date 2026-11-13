#!/usr/bin/env python3
"""Independent source ZIP route. Keeps the reviewed 1.2.2 source.conf untouched."""
import io
import tarfile
import zipfile
import types
from pathlib import Path
SOURCE='8cd3efee8c25cc2c69a5558d40b23b3c4b05da65'
RELEASE='wechat-workbench-source-8cd3efe'
FILENAME='chunmo-workbench-v2-8cd3efe.zip'
EXPECTED_SHA='a7a73e15aebf880ce409fbadd76d3f54dfcc2e4bbd8be389c9a8505c5c2ee559'
PATHS=['miniprogram/chunmo-photo','docs/workbench','deploy/workbench/README.md']

def profile(p):
    p.SOURCE=SOURCE;p.RELEASE=RELEASE;p.FILENAME=FILENAME;p.EXPECTED_SHA=EXPECTED_SHA
    p.SOURCE_SNIPPET=p.STATE/'routes/workbench-source.conf'
    p.ROUTE='/download/releases/'+RELEASE+'/'+FILENAME
    p.PATHS=PATHS
    def source_zip(repo):
        raw=p.run('git','-C',str(repo),'archive','--format=tar',SOURCE,*PATHS)
        out=io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(raw),mode='r:') as tar:
            with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED) as target:
                for member in sorted([m for m in tar.getmembers() if m.isfile()],key=lambda m:m.name):
                    if member.name.startswith('/') or '..' in member.name.split('/'):raise ValueError('Invalid source path')
                    entry=zipfile.ZipInfo('chunmo-workbench/'+member.name,(2026,11,13,0,0,0));entry.create_system=3;entry.external_attr=0o100644<<16
                    target.writestr(entry,tar.extractfile(member).read())
                entry=zipfile.ZipInfo('chunmo-workbench/打开说明.txt',(2026,11,13,0,0,0));entry.create_system=3;entry.external_attr=0o100644<<16
                target.writestr(entry,('\ufeff春茉工作台候选2.0.0\r\n导入miniprogram/chunmo-photo，AppID不变。\r\n使用/api/mini-photo-candidate/，先部署独立候选服务并真机验证。\r\n不要撤回/覆盖审核中的1.2.2，不清除手机草稿与照片。\r\n本包不是整站更新，不含AppSecret，网站及手机版继续使用。\r\n源码提交：'+SOURCE+'\r\n').encode('utf8'))
        return out.getvalue()
    p.source_zip=source_zip
    return p
