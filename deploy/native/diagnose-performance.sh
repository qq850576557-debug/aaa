#!/usr/bin/env bash
# Read-only host metrics. No credentials, SQL, business records or service changes.
set -u
printf 'UTC time: '; date -u '+%Y-%m-%dT%H:%M:%SZ'
uptime
free -m
df -h /opt /var
if command -v vmstat >/dev/null; then vmstat 1 3; fi
ps -C node -o pid,pcpu,pmem,rss,etime,comm
if command -v systemctl >/dev/null; then
  systemctl show chunmo-staging-api -p ActiveState -p MemoryCurrent -p CPUUsageNSec -p NRestarts --no-pager
fi
