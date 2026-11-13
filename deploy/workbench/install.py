#!/usr/bin/env python3
"""Candidate-only installer. Loads reviewed base transaction from pinned Git.
Never replaces existing mini-photo service, website, API or database.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import types

PREFIX = '/api/mini-photo-candidate/'
RUNTIME_SHA = 'f8239017b153720290242ad442d67674a4504292750b905dea138eb52c379c8a'
OLD_API_SHA = '603d2549d43de460cfd09acf7a5d3e488dcd7fe25dd4e2fe69adb53484ce93d2'


def profile(p):
    p.SERVICE = 'chunmo-mini-workbench'
    p.HEALTH_PATH = PREFIX+'health'
    p.ROOT = Path('/opt/chunmo-mini-workbench')
    p.STATE = Path('/var/lib/chunmo-mini-workbench')
    p.ENV = Path('/etc/chunmo-mini-workbench.env')
    p.UNIT = Path('/etc/systemd/system/chunmo-mini-workbench.service')
    p.ROUTE = p.ROOT / 'routes/api.conf'
    p.HOOK = 'include /opt/chunmo-mini-workbench/routes/*.conf;'
    p.BUNDLE_SHA = RUNTIME_SHA
    p.MARKER = '# Managed Chunmo mini-workbench candidate v1\n'
    original_health = p.old_health
    original_environment = p.render_environment
    original_secret = p.read_secret
    original_check = p.check

    def files(repo, commit):
        result = {name:p.run('git','-C',str(repo),'show',commit+':deploy/workbench/'+name)
                  for name in ('runtime.cjs','runtime.cjs.LEGAL.txt')}
        if p.sha(result['runtime.cjs']) != RUNTIME_SHA:
            raise ValueError('候选运行包SHA不匹配，未安装')
        return result

    def old_health(port):
        original_health(port)
        if not p.active('chunmo-mini-photo'):
            raise ValueError('原1.2.2拍照服务未正常运行，停止候选接入')
        for local in (True,False):
            code,data = p.curl(p.ORIGIN+'/api/mini-photo/health',local=local)
            if code != 200 or json.loads(data).get('mode') != 'sidecar':
                raise ValueError('原1.2.2拍照HTTPS入口检查失败')

    def route(port):
        text = p.MARKER + '''location ^~ /api/mini-photo-candidate/ {
  proxy_pass http://127.0.0.1:PORT/api/mini-photo/;
  proxy_http_version 1.1;
  proxy_set_header Host $http_host;
  proxy_set_header Connection "";
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto https;
  client_max_body_size 256k;
  proxy_connect_timeout 3s;
  proxy_read_timeout 25s;
  proxy_send_timeout 25s;
  proxy_buffering off;
  proxy_cache off;
}
'''
        if not isinstance(port,int) or not 1024 <= port <= 65535:raise ValueError('无效候选端口')
        return text.replace('PORT',str(port)).encode()

    def environment(plan,secret):
        return original_environment(plan,secret)+b'CHUNMO_MINI_WORKBENCH_ENABLED=1\n'

    def secret():
        # Only root-private existing config, no copying DB or old signing key.
        old = Path('/etc/chunmo-mini-photo.env')
        if old.exists():
            if old.is_symlink() or old.stat().st_uid != 0 or old.stat().st_mode & 0o077:
                raise ValueError('原小程序私有配置权限异常，未读取密钥')
            values = p.env_values(old)
            if values.get('CHUNMO_MINI_APP_ID') != p.APP_ID:
                raise ValueError('原小程序AppID不同，未复用密钥')
            value = values.get('CHUNMO_MINI_APP_SECRET','')
            if not re.fullmatch(r'[a-fA-F0-9]{32}',value):raise ValueError('原AppSecret格式异常')
            return value
        return original_secret()

    def verify(plan):
        if not p.active(p.SERVICE):raise ValueError('候选服务未运行')
        code,data=p.curl('http://127.0.0.1:{}/internal/ready'.format(plan['listenPort']))
        if code!=200 or json.loads(data).get('protocol')!=1:raise ValueError('候选本机检查失败')
        for local in (True,False):
            code,data=p.curl(p.ORIGIN+PREFIX+'health',local=local)
            if code!=200 or 'workbench-v1' not in json.loads(data).get('features',[]):
                raise ValueError('候选HTTPS路由未返回工作台能力，不能当作成功')
            for path in ('identity','workbench/workspace'):
                code,data=p.curl(p.ORIGIN+PREFIX+path,headers=('Referer: https://servicewechat.com/'+p.APP_ID+'/0/page-frame.html',),local=local)
                if code!=401 or json.loads(data).get('code')!='MINI_PROOF_EXPIRED':
                    raise ValueError('候选鉴权边界未通过')
        old_health(plan['apiPort'])
        if str(p.CURRENT.resolve())!=plan['currentRelease'] or p.sha((p.CURRENT/'dist-api/server.mjs').read_bytes())!=plan['apiSha256']:
            raise ValueError('原API版本发生变化，停止并回滚候选接入')

    def check(repo,commit):
        result,blob=original_check(repo,commit)
        if result['apiSha256'] != OLD_API_SHA:
            raise ValueError('原API不是已验证的2756068字节版本，需要先核对兼容性；未更新整站')
        result.pop('approvalToken',None)
        result.update({'candidatePrefix':PREFIX,'originalPhotoPreserved':True})
        result['approvalToken']=p.sha(json.dumps(result,sort_keys=True).encode())
        return result,blob

    p.bundle=files
    p.old_health=old_health
    p.render_route=route
    p.render_environment=environment
    p.read_secret=secret
    p.verify_installed=verify
    p.check=check
    return p


def load(repo,commit):
    if not re.fullmatch('[a-f0-9]{40}',commit):raise ValueError('必须固定完整提交SHA')
    data=subprocess.check_output(['git','-C',str(repo),'show',commit+':deploy/miniprogram/install.py'])
    p=types.ModuleType('workbench_base');p.__file__='reviewed-mini-install.py'
    exec(compile(data,p.__file__,'exec'),p.__dict__)
    return profile(p)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--repo',type=Path,default=Path('/opt/chunmo-source'));parser.add_argument('--commit',required=True)
    mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--check',action='store_true');mode.add_argument('--install',action='store_true');mode.add_argument('--rollback')
    args=parser.parse_args()
    try:
        p=load(args.repo,args.commit)
        if not args.rollback:
            plan,_=p.check(args.repo,args.commit)
            print(json.dumps(plan,ensure_ascii=False,indent=2))
        if args.check:print('候选只读检查完成，未安装，原手机版/1.2.2保持不动。')
        else:
            if os.geteuid()!=0:raise ValueError('请在Workbench root终端执行')
            with open('/run/lock/chunmo-staging-deploy.lock','a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                if args.install:
                    # Explicit interactive acceptance of the concrete live plan.
                    with open('/dev/tty','r') as tty:
                        print('仅安装候选服务/独立路由；不更新整站。请输入上方approvalToken确认：',flush=True)
                        approved=tty.readline().strip()
                    p.install(args.repo,args.commit,approved)
                    print('PASS 候选入口：'+p.ORIGIN+PREFIX+'health；原手机版及1.2.2保留。')
                else:p.rollback(args.rollback)
    except (Exception,KeyboardInterrupt) as error:
        print('未完成：'+(str(error) if isinstance(error,ValueError) else type(error).__name__)+'。不要发送私有配置或密钥。')
        raise SystemExit(1)
