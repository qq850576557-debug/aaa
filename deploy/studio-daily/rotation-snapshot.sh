#!/usr/bin/env bash
# Read-only production snapshot. Prints no names, account IDs, or business records.
set -Eeuo pipefail
export PATH="/usr/pgsql-17/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
[[ $EUID == 0 ]] || { echo '请在 Workbench root 终端运行。' >&2; exit 1; }
socket=
for dir in /run/postgresql /var/run/postgresql /tmp; do
  if [[ -S $dir/.s.PGSQL.5432 ]]; then socket=$dir; break; fi
done
[[ -n $socket ]] || { echo '正式 PostgreSQL 5432 本机套接字不可用。' >&2; exit 1; }
printf 'release=%s\n' "$(basename "$(readlink -e /opt/chunmo-staging/current)")"
timeout 35 runuser -u postgres -- env -i PATH="$PATH" \
  PGCLIENTENCODING=UTF8 PGOPTIONS='-c default_transaction_read_only=on' \
  psql -X -qAt -w -v ON_ERROR_STOP=1 -U postgres -h "$socket" -p 5432 -d chunmo_staging <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SELECT json_build_object(
  'database',current_database(),
  'readOnly',current_setting('transaction_read_only'),
  'studioRows',count(*),
  'configuredRotations',count(*) FILTER (WHERE jsonb_typeof(value->'rotation')='object')
)
FROM public.studio_daily;
SELECT json_build_object(
  'row',row_number() OVER (ORDER BY workspace_id),
  'version',version,
  'interval',r->'interval',
  'start',r->'start',
  'currentDate',r->'currentDate',
  'position',r->'position',
  'people',jsonb_array_length(r->'people'),
  'completed',jsonb_array_length(r->'history'),
  'corrections',jsonb_array_length(r->'corrections'),
  'rotationSha256',encode(sha256(convert_to(r::text,'UTF8')),'hex'),
  'historySha256',encode(sha256(convert_to((r->'history')::text,'UTF8')),'hex'),
  'correctionsSha256',encode(sha256(convert_to((r->'corrections')::text,'UTF8')),'hex')
)
FROM public.studio_daily
CROSS JOIN LATERAL (SELECT value->'rotation' AS r) rotation
WHERE jsonb_typeof(r)='object'
ORDER BY workspace_id;
ROLLBACK;
SQL
