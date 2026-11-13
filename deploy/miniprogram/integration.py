"""Isolated REAL Node22 child + Nginx HTTPS installation transaction test.

systemctl/user management are emulated; Node, loopback binding, the bundled
adapter, nginx -t/HUP, TLS and proxy requests are real. Never contacts production.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

spec=importlib.util.spec_from_file_location('mini_install',Path(__file__).with_name('install.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
REPO=Path(__file__).resolve().parents[2]
workbench = os.environ.get('CHUNMO_WORKBENCH_LAB') == '1'
if workbench:
    candidate_spec=importlib.util.spec_from_file_location('candidate',REPO/'deploy/workbench/install.py')
    candidate=importlib.util.module_from_spec(candidate_spec);candidate_spec.loader.exec_module(candidate)
    candidate.profile(p)
prefix='/api/mini-photo-candidate/' if workbench else '/api/mini-photo/'
route_mount='/opt/chunmo-mini-workbench/routes' if workbench else '/opt/chunmo-mini-photo/routes'
env={k:v for k,v in os.environ.items() if k not in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH')}
def docker(*args):
    return subprocess.check_output(['docker','--host=unix:///var/run/docker.sock',*args],env=env,stderr=subprocess.STDOUT)

with tempfile.TemporaryDirectory(prefix='chunmo-mini-install-lab-') as directory:
    lab=Path(directory);lab.chmod(0o755)
    for key,value in {'ROOT':lab/'mini','STATE':lab/'state','ENV':lab/'mini.env','UNIT':lab/'mini.service',
                     'ROUTE':lab/'mini/routes/api.conf','CONFIG':lab/'nginx.conf','CURRENT':lab/'original'}.items(): setattr(p,key,value)
    p.ROUTE.parent.mkdir(parents=True)
    for folder in (p.ROOT,p.ROUTE.parent): folder.chmod(0o755)
    (p.CURRENT/'dist-api').mkdir(parents=True);(p.CURRENT/'dist-api/server.mjs').write_bytes(b'old running API not replaced')
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=chmsj.cn',
                    '-addext','subjectAltName=DNS:chmsj.cn','-keyout',str(lab/'key.pem'),'-out',str(lab/'cert.pem')],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    original=b'''events {} http { access_log off; server {
listen 443 ssl; server_name chmsj.cn;
ssl_certificate /lab/cert.pem; ssl_certificate_key /lab/key.pem;
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options nosniff always;
location /api/ { proxy_pass http://127.0.0.1:4000; }
location / { default_type text/html; return 200 '<html>original site</html>'; }
} }
'''
    if workbench:
        original=original.replace(b'location /api/ {', b"""location = /api/mini-photo/health { default_type application/json; return 200 '{"ok":true,"mode":"sidecar"}'; }\nlocation /api/ {""")
    p.CONFIG.write_bytes(original)
    (lab/'fake-wechat.cjs').write_text("globalThis.fetch=async()=>Response.json({openid:'synthetic-wx-only'});\n")
    (lab/'supervisor.cjs').write_text(r'''
const http=require('node:http'),fs=require('node:fs'),cp=require('node:child_process');
let child=null,starts=0;const cookie='chunmo_session='+'a'.repeat(64);
http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/health')return res.end(JSON.stringify({ok:true,recordsRevision:7}));
  if(req.url==='/api/auth/login'){if(JSON.parse(body).login!=='fixture'){res.statusCode=401;return res.end('{}')};res.setHeader('Set-Cookie',cookie+'; HttpOnly; Secure; Path=/api');return res.end('{"ok":true}')}
  if(req.headers.cookie!==cookie){res.statusCode=401;return res.end('{}')}
  if(['POST','PUT'].includes(req.method)&&req.headers['x-csrf-token']!=='original-csrf'){res.statusCode=403;return res.end('{}')}
  if(req.url==='/api/workspace')return res.end('{"revision":7,"data":{"purchases":[]}}');
  if(req.url==='/api/auth/session')return res.end('{"user":{"id":"fixture","workspaceId":"fixture-workspace"},"csrf":"original-csrf"}');
  if(req.url==='/api/site-photos/config')return res.end('{"actorId":"fixture","actorName":"测试监理"}');
  if(req.url==='/api/site-photos/location')return res.end('{"places":[],"more":false}');
  res.statusCode=404;res.end('{}');
})}).listen(4000,'127.0.0.1');
http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');
 if(req.url==='/start'&&!child){
   const values=Object.fromEntries(fs.readFileSync('/lab/mini.env','utf8').trim().split('\n').map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)]}));
   child=cp.fork('/lab/mini/releases/RUNTIME/runtime.cjs',[],{uid:1000,gid:1000,env:{PATH:process.env.PATH,NODE_ENV:'production',...values,NODE_OPTIONS:'--require=/lab/fake-wechat.cjs'},stdio:'ignore'});
   starts++;child.once('exit',()=>child=null);
 }
 if(req.url==='/stop'&&child){const c=child;c.kill('SIGTERM');await new Promise(r=>{c.once('exit',r);setTimeout(()=>{c.kill('SIGKILL');r()},3000).unref()})}
 if(req.url==='/probe')return http.get('http://127.0.0.1:4011/internal/ready',r=>{let s='';r.on('data',b=>s+=b);r.on('end',()=>res.end(JSON.stringify({status:r.statusCode,body:s})))}).on('error',()=>res.end('{"status":503,"body":"{}"}'));
 res.end(JSON.stringify({alive:!!child,starts,childUid:1000}));
}).listen(4900,'127.0.0.1');
'''.replace('RUNTIME',p.BUNDLE_SHA[:16]))
    for name in ('fake-wechat.cjs','supervisor.cjs'): (lab/name).chmod(0o644)
    names=['chunmo-mini-node-'+str(os.getpid()),'chunmo-mini-nginx-'+str(os.getpid())]
    docker('run','-d','--name',names[0],'-p','127.0.0.1:18445:443','-v',directory+':/lab:ro','node:22-alpine','node','/lab/supervisor.cjs')
    try:
        docker('run','-d','--name',names[1],'--network','container:'+names[0],'-v',directory+':/lab:ro',
               '-v',str(p.ROUTE.parent)+':'+route_mount+':ro','nginx:1.28-alpine','nginx','-c','/lab/nginx.conf','-g','daemon off;')
        def control(action):
            code="fetch('http://127.0.0.1:4900/"+action+"').then(r=>r.text()).then(console.log)"
            return json.loads(docker('exec',names[0],'node','-e',code))
        def curl(url,headers=(),local=False,body=None):
            if url.startswith('http://127.0.0.1:4000/'):
                js="fetch("+json.dumps(url)+").then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()})))"
                value=json.loads(docker('exec',names[0],'node','-e',js));return value['status'],value['body'].encode()
            if url.startswith('http://127.0.0.1:4011/'):
                value=control('probe');return value['status'],value['body'].encode()
            args=['curl','--silent','--show-error','--max-time','10','--noproxy','chmsj.cn','--cacert',str(lab/'cert.pem'),
                  '--resolve','chmsj.cn:18445:127.0.0.1']
            for h in headers: args+=['-H',h]
            if body is not None: args+=['-H','Content-Type: application/json','--data-binary',body]
            output=subprocess.check_output(args+['--write-out','\n%{http_code}',url.replace('https://chmsj.cn','https://chmsj.cn:18445')],stderr=subprocess.PIPE)
            data,status=output.rsplit(b'\n',1);return int(status),data
        p.curl=curl
        def old_health(port):
            assert curl(p.ORIGIN+'/')[1]==b'<html>original site</html>'
            assert json.loads(curl(p.ORIGIN+'/api/health')[1])['recordsRevision']==7
            if workbench: assert json.loads(curl(p.ORIGIN+'/api/mini-photo/health')[1])['mode']=='sidecar'
        for i in range(30):
            try: old_health(4000);break
            except Exception:
                if i==29:raise
                time.sleep(.1)
        p.old_health=old_health
        assert curl(p.ORIGIN+prefix+'health')[0]!=200
        p.nginx_check=lambda:docker('exec',names[1],'nginx','-t','-c','/lab/nginx.conf')
        p.reload_web=lambda:docker('kill','--signal=HUP',names[1])
        p.read_secret=lambda:'a'*32
        p.active=lambda name:control('status')['alive'] if name==p.SERVICE else True
        original_run=p.run
        def run(*args):
            if args[0]=='systemctl':
                if args[1]=='start':control('start')
                if args[1]=='stop':control('stop')
                return b''
            if args[0]=='getent':return (p.SERVICE+':x:1000:1000::'+str(p.STATE)+':/sbin/nologin').encode()
            if args[0]=='id':return b'1000'
            if args[0]=='runuser':return docker('exec','--user','1000:1000',names[0],'node','--version')
            return original_run(*args)
        p.run=run
        commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO).decode().strip()
        plan={'commit':commit,'node':'/usr/local/bin/node','apiPort':4000,'listenPort':4011,'currentRelease':str(p.CURRENT.resolve()),
              'apiSha256':p.sha((p.CURRENT/'dist-api/server.mjs').read_bytes()),'nginxSha256':p.sha(original),'approvalToken':'fixture-approved','installed':False}
        files={n:(REPO/('deploy/workbench' if workbench else 'deploy/miniprogram')/n).read_bytes() for n in ('runtime.cjs','runtime.cjs.LEGAL.txt')}
        p.check=lambda repo,commit:(plan,files)
        print('ISOLATED LAB ONLY: Node/Nginx real; systemctl emulated; synthetic credentials and old API fixture.',flush=True)
        p.install(REPO,commit,'fixture-approved')
        assert control('status')['childUid']==1000
        ref='Referer: https://servicewechat.com/'+p.APP_ID+'/0/page-frame.html'
        status,data=curl(p.ORIGIN+prefix+'bootstrap',headers=(ref,),body='{"code":"fixture-code"}')
        assert status==200
        proof=json.loads(data)['proof']
        h=(ref,'X-Chunmo-Mini-Proof: '+proof)
        assert curl(p.ORIGIN+prefix+'login',headers=h,body='{"login":"fixture","password":"fixture-only"}')[0]==200
        cookie='Cookie: chunmo_session='+'a'*64
        assert json.loads(curl(p.ORIGIN+prefix+'session',headers=h+(cookie,))[1])['csrf']=='original-csrf'
        assert curl(p.ORIGIN+prefix+'nearby',headers=h+(cookie,),body='{}')[0]==403
        assert curl(p.ORIGIN+prefix+'nearby',headers=h+(cookie,'X-CSRF-Token: original-csrf'),body='{}')[0]==200
        if workbench: assert json.loads(curl(p.ORIGIN+prefix+'workbench/workspace',headers=h+(cookie,))[1])['revision']==7
        starts=control('status')['starts'];plan['installed']=True
        p.install(REPO,commit,'old-token')
        assert control('status')['starts']==starts
        p.rollback(p.state_data()['backup']);assert not control('status')['alive']
        assert p.CONFIG.read_bytes()==original
        # Real nginx -t rejects generated bad config; installer automatically restores
        # originals, HUPs them, checks old health, then stops only the new child.
        original_nginx_plan=p.nginx_plan
        p.nginx_plan=lambda *args:original_nginx_plan(*args)+b'\ninjected_invalid_directive;\n'
        plan['installed']=False
        try:p.install(REPO,commit,'fixture-approved');raise AssertionError('fault was not rejected')
        except ValueError as error:assert '已回滚' in str(error)
        assert p.CONFIG.read_bytes()==original and not p.ROUTE.exists()
        assert not control('status')['alive'];old_health(4000)
        print('PASS: actual bundle Node22/nonroot/loopback, HTTPS proxy, cookie/CSRF, unchanged old API/site, repeated install, actual nginx syntax fault + automatic rollback. No production operation.')
    finally:
        for name in reversed(names):
            try:docker('rm','-f',name)
            except subprocess.CalledProcessError:pass
