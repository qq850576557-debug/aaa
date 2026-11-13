#!/usr/bin/env python3
"""One reviewed entry: check, candidate installation/source publication, rollback."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import types


def git_module(repo,commit,path,name):
    data=subprocess.check_output(['git','-C',str(repo),'show',commit+':'+path],stderr=subprocess.PIPE)
    m=types.ModuleType(name);m.__file__=path
    exec(compile(data,path,'exec'),m.__dict__)
    return m

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--repo',type=Path,default=Path('/opt/chunmo-source'));parser.add_argument('--commit',required=True);parser.add_argument('--stage',choices=['check','install','source','rollback'],default='check');parser.add_argument('--backup')
    args=parser.parse_args()
    try:
        if os.geteuid()!=0 or not re.fullmatch('[a-f0-9]{40}',args.commit):raise ValueError('需root和固定完整SHA')
        adapter=git_module(args.repo,args.commit,'deploy/workbench/install.py','candidate')
        p=adapter.load(args.repo,args.commit)
        if args.stage=='rollback':
            if not args.backup:raise ValueError('请提供--backup install-...编号')
            import fcntl
            with open('/run/lock/chunmo-staging-deploy.lock','a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);p.rollback(args.backup)
        else:
            plan,_=p.check(args.repo,args.commit);print(json.dumps(plan,ensure_ascii=False,indent=2),flush=True)
            if args.stage=='check':print('只读检查完成；未安装。手机版和1.2.2保持不动。')
            else:
                if args.stage=='install':
                    import fcntl
                    with open('/dev/tty','r') as tty:
                        print('仅新增候选工作台服务/路由。粘贴上方approvalToken确认：',flush=True);approved=tty.readline().strip()
                    with open('/run/lock/chunmo-staging-deploy.lock','a') as lock:
                        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);p.install(args.repo,args.commit,approved)
                elif not plan['installed']:raise ValueError('候选服务未安装，不发布不可用的前端入口')
                source=git_module(args.repo,args.commit,'deploy/workbench/source.py','candidate_source')
                publisher=git_module(args.repo,args.commit,'deploy/source-download/publish.py','source_base')
                source.profile(publisher)
                try:publisher.publish(publisher.source_zip(args.repo),args.repo)
                except Exception:
                    print('候选服务已接入；源码下载发布未完成，可用--stage source单独重试，不需要重复安装。',flush=True)
                    raise
                p.verify_installed(plan)
                print('PASS 工作台候选服务与源码下载已就绪；原网站、手机版及1.2.2保留。微信审核/发布仍需管理员完成。')
    except (Exception,KeyboardInterrupt) as error:
        print('未完成：'+(str(error) if isinstance(error,ValueError) else type(error).__name__)+'。保留报错和备份编号，不要发送密钥或私有文件。')
        raise SystemExit(1)
