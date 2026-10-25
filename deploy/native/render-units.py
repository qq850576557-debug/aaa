#!/usr/bin/env python3
"""Render only this deployment's private units. Never start global nginx or alter PG/firewall."""
import pathlib, re, sys
node, nginx, postgres = sys.argv[1:]
assert all(re.fullmatch(r'/[a-zA-Z0-9_./-]+', x) for x in (node, nginx))
assert postgres in ('postgresql-17.service', 'postgresql.service')
base = '/opt/chunmo-staging'
marker = '# Managed by chunmo native staging deploy\n'
units = {}
common = '''NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
InaccessiblePaths=-/run/postgresql -/var/run/postgresql
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
UMask=0077
StandardOutput=journal
StandardError=journal
'''
units['chunmo-staging-api.service'] = f'''[Unit]
Description=Chunmo internal staging API
Requires={postgres}
After={postgres} network.target
StartLimitIntervalSec=60
StartLimitBurst=5
[Service]
Type=simple
User=chunmo-staging-api
Group=chunmo-staging-api
WorkingDirectory={base}/current
EnvironmentFile=/etc/chunmo-staging/runtime.env
ExecStart={node} --max-old-space-size=384 dist-api/server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
MemoryMax=640M
{common}[Install]
WantedBy=multi-user.target
'''
units['chunmo-staging-web.service'] = f'''[Unit]
Description=Chunmo loopback HTTPS (SSH tunnel only)
After=chunmo-staging-api.service
Wants=chunmo-staging-api.service
[Service]
Type=simple
User=chunmo-staging-web
Group=chunmo-staging-web
ExecStart={nginx} -p /var/lib/chunmo-staging-web/ -c {base}/nginx.conf -g "daemon off;"
Restart=on-failure
RestartSec=5
MemoryMax=96M
ReadWritePaths=/var/lib/chunmo-staging-web
{common}[Install]
WantedBy=multi-user.target
'''
units['chunmo-staging-backup.service'] = f'''[Unit]
Description=Chunmo authenticated encrypted database backup
After={postgres}
[Service]
Type=oneshot
ExecStart=/bin/bash {base}/current/deploy/native/backup.sh
UMask=0077
Nice=10
MemoryMax=256M
'''
units['chunmo-staging-backup.timer'] = '''[Unit]
Description=Daily Chunmo staging backup
[Timer]
OnCalendar=*-*-* 03:10:00 Asia/Shanghai
Persistent=true
RandomizedDelaySec=600
[Install]
WantedBy=timers.target
'''
units['chunmo-staging-health.service'] = f'''[Unit]
Description=Chunmo private HTTPS and certificate health
[Service]
Type=oneshot
ExecStart=/bin/bash {base}/current/deploy/native/health.sh
'''
units['chunmo-staging-health.timer'] = '''[Unit]
Description=Chunmo health every minute
[Timer]
OnBootSec=90
OnUnitActiveSec=60
[Install]
WantedBy=timers.target
'''
# A lab may supply a temporary output directory; production always uses the default.
out = pathlib.Path('/etc/systemd/system')
import os
if os.environ.get('CHUNMO_UNIT_TEST_OUTPUT'):
    out = pathlib.Path(os.environ['CHUNMO_UNIT_TEST_OUTPUT'])
for name, text in units.items():
    path = out / name
    if path.exists() and not path.read_text().startswith(marker):
        raise SystemExit('Refusing to overwrite an unmanaged unit: ' + name)
    path.write_text(marker + text)
    path.chmod(0o644)
