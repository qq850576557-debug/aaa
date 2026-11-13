#!/usr/bin/env python3
"""Python 3.6+ opt-in mini-photo sidecar installer. No DB or main-release writes.

--check is read-only apart from transient curl/probe sockets. --install requires
the current check fingerprint; credentials are read from /dev/tty, never argv.
"""
import argparse
import base64
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import warnings

APP_ID = 'wxb48a7abb3858a252'
ORIGIN = 'https://chmsj.cn'
SERVICE = 'chunmo-mini-photo'
ROOT = Path('/opt/chunmo-mini-photo')
STATE = Path('/var/lib/chunmo-mini-photo')
ENV = Path('/etc/chunmo-mini-photo.env')
UNIT = Path('/etc/systemd/system/chunmo-mini-photo.service')
ROUTE = ROOT / 'routes/api.conf'
CONFIG = Path('/opt/chunmo-staging/nginx.conf')
CURRENT = Path('/opt/chunmo-staging/current')
OLD_ENV = Path('/etc/chunmo-staging/runtime.env')
PUBLIC = Path('/etc/chunmo-staging/public-https.json')
HOOK = 'include /opt/chunmo-mini-photo/routes/*.conf;'
BUNDLE_SHA = '6ce608ae9d9e1071c33b51f21c0f47f9efe3e9166c01f749bb5ed9c53ec38a7c'
MARKER = '# Managed Chunmo mini-photo v1\n'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run(*args):
    # Captured output is private. Never print arbitrary commands, stderr or env.
    try:
        return subprocess.check_output(args, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as error:
        raise ValueError('{}命令失败（exit={}）；未输出可能含凭据的命令参数'.format(Path(str(args[0])).name, error.returncode))


def active(name):
    return subprocess.call(['systemctl', 'is-active', '--quiet', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0


def unit_fragment(name):
    child = subprocess.Popen(['systemctl', 'show', '--property=LoadState', '--property=FragmentPath', name],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output, _ = child.communicate()
    values = dict(line.split('=', 1) for line in output.decode().splitlines() if '=' in line)
    if values.get('LoadState') == 'not-found': return ''
    if child.returncode != 0 or values.get('LoadState') != 'loaded':
        raise ValueError('无法确认systemd单元状态：' + name)
    return values.get('FragmentPath', '')


def env_values(path):
    values = {}
    for line in path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('\"\'')
    return values


def curl(url, headers=(), local=False, body=None):
    args = ['curl', '--silent', '--show-error', '--connect-timeout', '5', '--max-time', '25']
    if url.startswith('https://'):
        args += ['--proto', '=https']
        if local:
            args += ['--noproxy', 'chmsj.cn', '--resolve', 'chmsj.cn:443:127.0.0.1']
    elif not re.match(r'^http://127\.0\.0\.1:[0-9]+/', url):
        raise ValueError('仅允许可信HTTPS或本机HTTP检查')
    else:
        args += ['--noproxy', '127.0.0.1']
    for header in headers:
        args += ['-H', header]
    if body is not None:
        args += ['-H', 'Content-Type: application/json', '--data-binary', body]
    result = run(*(args + ['--write-out', '\n%{http_code}', url]))
    data, code = result.rsplit(b'\n', 1)
    return int(code), data


def old_health(api_port):
    for name in ('chunmo-staging-api', 'chunmo-staging-web'):
        if not active(name):
            raise ValueError('原服务未正常运行：' + name)
    code, data = curl('http://127.0.0.1:{}/api/health'.format(api_port))
    if code != 200 or json.loads(data).get('ok') is not True:
        raise ValueError('原API本机健康检查未通过')
    for local in (True, False):
        code, data = curl(ORIGIN + '/', local=local)
        if code != 200 or b'<html' not in data.lower():
            raise ValueError('原网站HTTPS检查未通过')
        code, data = curl(ORIGIN + '/api/health', local=local)
        if code != 200 or json.loads(data).get('ok') is not True:
            raise ValueError('原API的HTTPS检查未通过')


def bundle(repo, commit):
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('必须指定已审核的完整Git提交SHA')
    files = {}
    for name in ('runtime.cjs', 'runtime.cjs.LEGAL.txt'):
        files[name] = run('git', '-C', str(repo), 'show', commit + ':deploy/miniprogram/' + name)
    if sha(files['runtime.cjs']) != BUNDLE_SHA:
        raise ValueError('独立服务运行包SHA与已验证版本不一致')
    return files


def nginx_plan(repo, commit, original, api_port=None):
    namespace = {'__name__': 'mini_nginx_plan', '__file__': 'reviewed-nginx-parser.py'}
    code = run('git', '-C', str(repo), 'show', commit + ':deploy/apk-download/publish.py')
    exec(compile(code, 'reviewed-nginx-parser.py', 'exec'), namespace)
    namespace['HOOK'] = HOOK
    updated, _, _ = namespace['configure'](original.decode('utf-8'), 'chmsj.cn')
    if api_port is not None:
        tree = namespace['statements'](original.decode('utf-8'))
        servers = [server for http in tree['children'] if http['words'] == ['http'] for server in http['children']
                   if server['words'] == ['server'] and any(w[:1] == ['server_name'] and 'chmsj.cn' in w[1:] for w,_,_ in server['directives'])
                   and any(w[:1] == ['listen'] and len(w)>1 and w[1] in ('443','0.0.0.0:443','[::]:443') and 'ssl' in w for w,_,_ in server['directives'])]
        routes = [r for r in servers[0]['children'] if r['words'][:1] == ['location'] and '/api/' in r['words']]
        if len(routes) != 1 or not any(w == ['proxy_pass','http://127.0.0.1:'+str(api_port)] for w,_,_ in routes[0]['directives']):
            raise ValueError('公网HTTPS服务器的原API上游与实际API端口不一致，未修改')
    return updated.encode('utf-8')


def state_data():
    file = STATE / 'state.json'
    if file.is_symlink():
        raise ValueError('未知的安装记录软链接')
    return json.loads(file.read_text()) if file.exists() else None


def free_port(api_port):
    for port in range(4011, 4021):
        if port == api_port:
            continue
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
                return port
            except OSError:
                pass
    raise ValueError('4011–4020没有可用本机端口；未停止任何现有服务')


def check(repo, commit):
    if os.geteuid() != 0:
        raise ValueError('请在Workbench的root终端执行；不要发送任何密钥')
    for path in (ROOT, STATE, ENV, UNIT, ROUTE, ROUTE.parent, CONFIG):
        if path.is_symlink():
            raise ValueError('未知软链接，停止：' + str(path))
    files = bundle(repo, commit)
    current_state = state_data()
    for directory in (ROOT/'releases', STATE/'backups'):
        if directory.is_symlink(): raise ValueError('未知的运行包或备份目录软链接')
    if ROOT.exists() and not current_state and any(ROOT.iterdir()):
        raise ValueError('同名应用目录已有内容但无本工具记录，未覆盖')
    if ENV.exists() and not current_state:
        raise ValueError('同名私有配置已存在但没有本工具记录，未覆盖')
    if ENV.exists() and (ENV.stat().st_uid != 0 or ENV.stat().st_mode & 0o077):
        raise ValueError('小程序私有配置不是root专用权限，停止核验')
    if UNIT.exists() and (not current_state or not UNIT.read_text().startswith(MARKER)):
        raise ValueError('同名systemd配置已存在且不属于本工具，未覆盖')
    fragment = unit_fragment(SERVICE)
    if fragment and fragment != str(UNIT):
        raise ValueError('同名服务由其他位置管理，未覆盖')
    if current_state and current_state['phase'] not in ('installed', 'rolled-back'):
        raise ValueError('前次安装未完成，请先回滚备份：' + current_state['backup'])
    systemd = run('systemctl', '--version').decode().splitlines()[0]
    systemd_version = re.search(r'systemd\s+(\d+)', systemd)
    if not systemd_version or int(systemd_version.group(1)) < 231:
        raise ValueError('systemd版本需单独兼容，未安装或升级系统组件')
    if shutil.which('getenforce') and run('getenforce').strip() == b'Enforcing':
        raise ValueError('SELinux为Enforcing，需要先审查独立服务策略；未放宽或关闭SELinux')
    values = env_values(OLD_ENV)
    api_port = int(values.get('API_PORT', '4000'))
    if not 1024 <= api_port <= 65535 or values.get('APP_ORIGIN') != ORIGIN:
        raise ValueError('原API端口或可信Origin需要人工核对，未修改')
    if json.loads(PUBLIC.read_text()).get('origin') != ORIGIN:
        raise ValueError('实际公网HTTPS域名不匹配')
    if values.get('CHUNMO_AMAP_ENABLED') != '1' or not values.get('CHUNMO_AMAP_KEY'):
        raise ValueError('原高德配置未启用；本工具不填写或替换原Key')
    pid = int(run('systemctl', 'show', '--property=MainPID', '--value', 'chunmo-staging-api'))
    if pid <= 0:
        raise ValueError('原API进程未运行')
    node = str(Path('/proc/{}/exe'.format(pid)).resolve())
    if not re.fullmatch(r'/[a-zA-Z0-9_./-]+', node): raise ValueError('Node实际路径不适合安全systemd配置，需人工核对')
    version = run(node, '--version').decode().strip()
    match = re.fullmatch(r'v([0-9]+)\.([0-9]+)\.[0-9]+', version)
    if not match or int(match.group(1)) < 22 or (int(match.group(1)) == 22 and int(match.group(2)) < 12):
        raise ValueError('原Node版本不满足22.12+；未安装或替换Node')
    api = CURRENT / 'dist-api/server.mjs'
    original = CONFIG.read_bytes()
    if not re.search(rb'proxy_pass\s+http://127\.0\.0\.1:' + str(api_port).encode() + rb'\s*;', original):
        raise ValueError('Nginx原API端口与运行配置不同，需人工核对')
    if b'/api/mini-photo/' in original and not current_state:
        raise ValueError('Nginx已有小程序路由，未覆盖未知配置')
    if b'CHUNMO_MINI_PHOTO_ENABLED' in api.read_bytes():
        raise ValueError('原API已包含小程序模块，请先核对是否无需独立服务')
    nginx_plan(repo, commit, original, api_port)  # read-only exact public upstream validation
    old_health(api_port)
    installed = current_state and current_state['phase'] == 'installed'
    if installed:
        for key, path in (('unit', UNIT), ('env', ENV), ('route', ROUTE)):
            if not path.exists() or sha(path.read_bytes()) != current_state['after'][key]:
                raise ValueError('检测到已安装服务配置变化，未覆盖：' + str(path))
        runtime = ROOT/'releases'/BUNDLE_SHA[:16]/'runtime.cjs'
        if runtime.is_symlink() or not runtime.exists() or sha(runtime.read_bytes()) != BUNDLE_SHA:
            raise ValueError('已安装运行包不同，需要另行审查升级')
        verify_installed(current_state['plan'])
    port = current_state['plan']['listenPort'] if installed else free_port(api_port)
    result = {'commit': commit, 'appId': APP_ID, 'origin': ORIGIN, 'currentRelease': str(CURRENT.resolve()),
              'apiPort': api_port, 'apiPid': pid, 'apiSha256': sha(api.read_bytes()), 'node': node, 'nodeVersion': version,
              'nginxSha256': sha(original), 'listenAddress': '127.0.0.1', 'listenPort': port,
              'bundleSha256': BUNDLE_SHA, 'installed': bool(installed), 'amapReused': True}
    result['systemdVersion'] = int(systemd_version.group(1))
    result['approvalToken'] = sha(json.dumps(result, sort_keys=True).encode())
    return result, files


def render_unit(plan):
    release = ROOT / 'releases' / BUNDLE_SHA[:16]
    return (MARKER + '''[Unit]
Description=Chunmo mini-photo loopback adapter
After=network.target chunmo-staging-api.service
[Service]
Type=simple
User=chunmo-mini-photo
Group=chunmo-mini-photo
EnvironmentFile=/etc/chunmo-mini-photo.env
Environment=NODE_ENV=production
WorkingDirectory={release}
ExecStart={node} {release}/runtime.cjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
InaccessiblePaths=/etc/chunmo-staging
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077
MemoryLimit=256M
LimitNOFILE=4096
[Install]
WantedBy=multi-user.target
'''.format(release=release, node=plan['node'])).encode()


def render_route(port):
    if not isinstance(port, int) or port < 1024 or port > 65535:
        raise ValueError('无效端口')
    return (MARKER + '''location ^~ /api/mini-photo/ {
  proxy_pass http://127.0.0.1:{port};
  proxy_http_version 1.1;
  proxy_set_header Host $http_host;
  proxy_set_header Connection "";
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto https;
  client_max_body_size 8k;
  proxy_connect_timeout 3s;
  proxy_read_timeout 25s;
  proxy_send_timeout 25s;
  proxy_buffering off;
  proxy_cache off;
}
'''.replace('{port}', str(port))).encode()


def atomic(path, data, mode=0o644):
    fd, temp = tempfile.mkstemp(prefix='.mini-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data); out.flush(); os.fsync(out.fileno())
        os.chmod(temp, mode)
        if path.exists():
            info = path.stat(); os.chown(temp, info.st_uid, info.st_gid); os.chmod(temp, info.st_mode & 0o777)
        os.replace(temp, str(path))
    finally:
        if os.path.exists(temp): os.unlink(temp)


def snapshot(path):
    if path.is_symlink(): raise ValueError('拒绝覆盖软链接')
    if not path.exists(): return {'data': None}
    info = path.stat()
    return {'data': base64.b64encode(path.read_bytes()).decode(), 'mode': info.st_mode & 0o777, 'uid': info.st_uid, 'gid': info.st_gid}


def restore(path, item):
    if item['data'] is None:
        if path.exists(): path.unlink()
    else:
        atomic(path, base64.b64decode(item['data']), item['mode'])
        os.chmod(str(path), item['mode']); os.chown(str(path), item['uid'], item['gid'])


def nginx_check():
    nginx = shutil.which('nginx')
    if not nginx: raise ValueError('找不到现有Nginx')
    run('setpriv', '--reuid=chunmo-staging-web', '--regid=chunmo-staging-web', '--init-groups',
        '--bounding-set=-all,+net_bind_service', '--inh-caps=-all,+net_bind_service',
        '--ambient-caps=-all,+net_bind_service', '--no-new-privs', '--', nginx,
        '-t', '-p', '/var/lib/chunmo-staging-web/', '-c', str(CONFIG))


def reload_web():
    run('systemctl', 'kill', '--kill-who=main', '--signal=HUP', 'chunmo-staging-web')


def save_record(record):
    data = json.dumps(record, sort_keys=True).encode()
    atomic(STATE / 'state.json', data, 0o600)
    atomic(STATE / 'backups' / record['backup'] / 'record.json', data, 0o600)


def verify_installed(plan):
    if not active(SERVICE): raise ValueError('小程序独立服务未运行')
    code, data = curl('http://127.0.0.1:{}/internal/ready'.format(plan['listenPort']))
    if code != 200 or json.loads(data).get('protocol') != 1: raise ValueError('独立服务本机检查失败')
    for local in (True, False):
        code, data = curl(ORIGIN + '/api/mini-photo/health', local=local)
        if code != 200 or json.loads(data).get('mode') != 'sidecar': raise ValueError('HTTPS小程序路由返回错误或网站HTML')
        code, denied = curl(ORIGIN + '/api/mini-photo/identity',
                       headers=('Referer: https://servicewechat.com/' + APP_ID + '/0/page-frame.html',), local=local)
        if code != 401 or json.loads(denied).get('code') != 'MINI_PROOF_EXPIRED':
            raise ValueError('无微信凭据的请求未被正确拒绝，或被错误转给原网站')
    old_health(plan['apiPort'])
    if str(CURRENT.resolve()) != plan['currentRelease'] or sha((CURRENT/'dist-api/server.mjs').read_bytes()) != plan['apiSha256']:
        raise ValueError('原运行版本在操作期间发生变化，需要人工核对')


def rollback(name):
    if not re.fullmatch(r'install-[a-f0-9]{24}', name): raise ValueError('备份编号无效')
    file = STATE / 'backups' / name / 'record.json'
    if file.is_symlink(): raise ValueError('未知备份软链接')
    record = json.loads(file.read_text())
    if record.get('managed') != SERVICE: raise ValueError('不是本工具备份')
    for key, path in (('config', CONFIG), ('route', ROUTE), ('unit', UNIT), ('env', ENV)):
        if path.is_symlink(): raise ValueError('回滚遇到未知软链接')
        current = sha(path.read_bytes()) if path.exists() else None
        old = record['before'][key]['data']
        old_sha = sha(base64.b64decode(old)) if old is not None else None
        if current not in (old_sha, record['after'][key]):
            raise ValueError('检测到其他人修改，未覆盖：' + str(path))
    # Keep the adapter alive until the original routing is restored and verified.
    # Even when disk files were restored by a previous failed rollback, workers
    # may still use the new routing until a successful HUP is confirmed.
    changed = (record.get('routingTouched', False) or snapshot(ROUTE)['data'] != record['before']['route']['data'] or snapshot(CONFIG)['data'] != record['before']['config']['data'])
    if changed:
        restore(ROUTE, record['before']['route']); restore(CONFIG, record['before']['config'])
        nginx_check(); reload_web()
    old_health(record['plan']['apiPort'])
    if UNIT.exists():
        run('systemctl', 'stop', SERVICE)
        run('systemctl', 'disable', SERVICE)
    restore(UNIT, record['before']['unit']); restore(ENV, record['before']['env'])
    run('systemctl', 'daemon-reload')
    record['phase'] = 'rolled-back'; record['routingTouched'] = False; save_record(record)
    print('PASS 回滚完成；原网站/API保持运行，未操作数据库；备份与派生运行包保留。')


def read_secret():
    try:
        with open('/dev/tty', 'r+') as tty:
            if not tty.isatty(): raise ValueError('需要交互终端')
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                secret = getpass.getpass('请粘贴小程序AppSecret（隐藏输入，不写命令历史）：', stream=tty).strip()
    except (OSError, EOFError, getpass.GetPassWarning):
        raise ValueError('没有安全交互终端，未读取AppSecret')
    if not re.fullmatch(r'[a-fA-F0-9]{32}', secret): raise ValueError('AppSecret格式不正确；未显示输入值')
    return secret


def install(repo, commit, approved):
    plan, files = check(repo, commit)
    if plan['installed']:
        verify_installed(state_data()['plan'])
        print('PASS 已安装且健康；重复执行未修改配置或重启服务。'); return
    if approved != plan['approvalToken']: raise ValueError('请先执行只读检查并确认同一核验指纹；未安装')
    for path in (ROOT, STATE): path.mkdir(mode=0o755 if path == ROOT else 0o700, parents=True, exist_ok=True)
    STATE.chmod(0o700)
    backups = STATE/'backups'; backups.mkdir(mode=0o700, exist_ok=True); backups.chmod(0o700)
    name = 'install-' + secrets.token_hex(12)
    folder = backups/name; folder.mkdir(mode=0o700)
    before = {key: snapshot(path) for key,path in (('config',CONFIG),('route',ROUTE),('unit',UNIT),('env',ENV))}
    if UNIT.exists() or ROUTE.exists(): raise ValueError('存在未启用的旧安装文件，请先检查或回滚，未覆盖')
    config = nginx_plan(repo, commit, CONFIG.read_bytes())
    unit, route = render_unit(plan), render_route(plan['listenPort'])
    record = {'managed':SERVICE, 'phase':'prepared', 'backup':name, 'plan':plan, 'before':before, 'routingTouched':False,
              'after':{'config':sha(config),'unit':sha(unit),'route':sha(route),'env':None}}
    # First preserve the original files before credentials or service mutations.
    save_record(record)
    print('备份编号：' + name, flush=True)
    try:
        secret = read_secret()
        env = ('CHUNMO_MINI_APP_ID=' + APP_ID + '\nCHUNMO_MINI_APP_SECRET=' + secret +
               '\nCHUNMO_MINI_SIGNING_KEY=' + secrets.token_hex(32) + '\nCHUNMO_MINI_ORIGIN=' + ORIGIN +
               '\nCHUNMO_MINI_PORT=' + str(plan['listenPort']) + '\nCHUNMO_MINI_API_PORT=' + str(plan['apiPort']) + '\n').encode()
        record['after']['env'] = sha(env); record['phase'] = 'installing'; save_record(record)
        # Detect concurrent site updates even outside the standard deployment lock.
        if sha(CONFIG.read_bytes()) != plan['nginxSha256']: raise ValueError('Nginx已被其他操作修改，停止安装')
        try:
            account = run('getent', 'passwd', SERVICE).decode().strip().split(':')
        except ValueError:
            run('useradd', '--system', '--user-group', '--no-create-home', '--home-dir', str(STATE), '--shell', '/sbin/nologin', SERVICE)
            account = run('getent', 'passwd', SERVICE).decode().strip().split(':')
        if len(account) != 7 or account[2] == '0' or account[5] != str(STATE) or account[6] != '/sbin/nologin':
            raise ValueError('同名服务用户不是受控的非登录账户')
        if len(run('id', '-G', SERVICE).split()) != 1: raise ValueError('服务用户包含额外组权限，未启用')
        release = ROOT/'releases'/BUNDLE_SHA[:16]; release.mkdir(mode=0o755, parents=True, exist_ok=True)
        for parent in (ROOT, ROOT/'releases', release, ROUTE.parent):
            parent.mkdir(mode=0o755, exist_ok=True); parent.chmod(0o755)
        for filename, data in files.items():
            target = release/filename
            if target.exists() and target.read_bytes() != data: raise ValueError('同名运行包内容不同，未覆盖')
            atomic(target,data)
        run('runuser','-u',SERVICE,'--',plan['node'],'--version')
        nginx_check()
        atomic(ENV,env,0o600); del secret, env
        atomic(UNIT,unit)
        run('systemctl','daemon-reload'); run('systemctl','start',SERVICE)
        for attempt in range(20):
            try:
                code,data=curl('http://127.0.0.1:{}/internal/ready'.format(plan['listenPort']))
                if code == 200 and json.loads(data).get('protocol') == 1: break
            except ValueError: pass
            if attempt == 19: raise ValueError('新服务未就绪')
            time.sleep(0.3)
        if sha(CONFIG.read_bytes()) != plan['nginxSha256'] or str(CURRENT.resolve()) != plan['currentRelease']:
            raise ValueError('原站点配置或发行版本在安装期间发生变化，停止接入')
        record['routingTouched'] = True; save_record(record)
        atomic(ROUTE,route); atomic(CONFIG,config)
        nginx_check(); reload_web()
        for attempt in range(10):
            try: verify_installed(plan); break
            except ValueError:
                if attempt == 9: raise
                time.sleep(0.5)
        run('systemctl','enable',SERVICE)
        record['phase']='installed'; save_record(record)
        print('PASS 独立服务安装与HTTPS路由验证完成；原API版本未变。微信真实登录/拍照仍须手机验收。')
        print('健康地址：' + ORIGIN + '/api/mini-photo/health')
    except (Exception, KeyboardInterrupt) as error:
        print('安装未完成，尝试回滚；不会把失败当作成功。', flush=True)
        try: rollback(name)
        except Exception as failure:
            raise ValueError('安装失败；回滚未完全确认：{}；备份编号 {}。原错误类型 {}。禁止视为安装成功'.format(failure,name,type(error).__name__))
        raise ValueError('安装失败，已回滚：' + (str(error) if isinstance(error,ValueError) else type(error).__name__))


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--repo',type=Path,default=Path('/opt/chunmo-source'))
    parser.add_argument('--commit',required=True)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check',action='store_true'); mode.add_argument('--install',action='store_true'); mode.add_argument('--rollback')
    parser.add_argument('--approve',default='')
    args=parser.parse_args()
    try:
        if args.check:
            plan,_=check(args.repo,args.commit); print(json.dumps(plan,ensure_ascii=False,indent=2))
            print('只读核验完成，未安装/改配置/读取AppSecret。安装必须另行确认。')
        else:
            if os.geteuid()!=0: raise ValueError('必须在Workbench root终端执行')
            with open('/run/lock/chunmo-staging-deploy.lock','a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                if args.install: install(args.repo,args.commit,args.approve)
                else: rollback(args.rollback)
    except (Exception,KeyboardInterrupt) as error:
        print('未完成：' + (str(error) if isinstance(error,ValueError) else type(error).__name__) + '。不要发送私有环境文件或密钥。')
        raise SystemExit(1)
