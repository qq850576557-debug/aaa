#!/usr/bin/env python3
"""Read-only live inventory; no DB credentials, migrations, deploy or restart."""
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request
current=Path('/opt/chunmo-staging/current')
result={'currentRelease':str(current.resolve()),'productionSchemaInspected':False,'migrationRequired':'015_studio_daily.sql','changes':'Add studio_daily and immutable studio_daily_submission; no old business rewrite','services':{}}
for name in ['chunmo-staging-api','chunmo-staging-web','chunmo-mini-photo','chunmo-mini-workbench']:
 result['services'][name]=subprocess.call(['systemctl','is-active','--quiet',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)==0
file=current/'dist-api/server.mjs'
if file.exists():
 b=file.read_bytes();result['apiSha256']=hashlib.sha256(b).hexdigest();result['studioEndpointBundled']=b'/api/studio-daily' in b
print(json.dumps(result,ensure_ascii=False,indent=2))
print('只读核验完成；未连接数据库、未读取密钥、未迁移、未部署、未重启。新增迁移必须先取得创始人明确批准。')
