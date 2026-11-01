-- Run BEFORE upgrading an existing database. No new API or 012/013/014 is required.
-- Read-only consistent snapshot; no migrations, repairs, deletions or normalization.
\set ON_ERROR_STOP on
\pset pager off
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_database() AS database, current_setting('transaction_read_only') AS read_only;
SELECT name AS applied_migration FROM schema_migration ORDER BY name;
SELECT id AS workspace_id,name AS workspace_name FROM cloud_workspace ORDER BY id;
SELECT workspace_id,revision,
 CASE WHEN jsonb_typeof(data->'projects')='array' THEN jsonb_array_length(data->'projects') END AS projects,
 CASE WHEN jsonb_typeof(data->'trades')='array' THEN jsonb_array_length(data->'trades') END AS trades,
 CASE WHEN jsonb_typeof(data->'tasks')='array' THEN jsonb_array_length(data->'tasks') END AS tasks,
 CASE WHEN jsonb_typeof(data->'notes')='array' THEN jsonb_array_length(data->'notes') END AS legacy_notes,
 CASE WHEN jsonb_typeof(data->'purchases')='array' THEN jsonb_array_length(data->'purchases') END AS purchases,
 CASE WHEN jsonb_typeof(data->'people')='array' THEN jsonb_array_length(data->'people') END AS people,
 CASE WHEN jsonb_typeof(data->'dictionaries')='array' THEN jsonb_array_length(data->'dictionaries') END AS dictionaries,
 CASE WHEN jsonb_typeof(history->'records')='array' THEN jsonb_array_length(history->'records') END AS raw_history_nodes
 FROM workspace_state ORDER BY workspace_id;
SELECT ws.workspace_id,p->>'id' AS project_id,p->>'name' AS project_name,p->>'status' AS status,
 p->>'start' AS start_date,p->>'end' AS end_date,p->>'updatedAt' AS updated_at,
 CASE WHEN jsonb_typeof(ws.data->'trades')='array' AND jsonb_typeof(p->'id')='string' THEN (SELECT count(*) FROM jsonb_array_elements(ws.data->'trades') t WHERE t->>'projectId'=p->>'id') END AS trades,
 CASE WHEN jsonb_typeof(ws.data->'tasks')='array' AND jsonb_typeof(p->'id')='string' THEN (SELECT count(*) FROM jsonb_array_elements(ws.data->'tasks') t WHERE t->>'projectId'=p->>'id') END AS tasks,
 CASE WHEN jsonb_typeof(ws.data->'notes')='array' AND jsonb_typeof(p->'id')='string' THEN (SELECT count(*) FROM jsonb_array_elements(ws.data->'notes') n WHERE n->>'projectId'=p->>'id') END AS legacy_notes,
 CASE WHEN jsonb_typeof(ws.data->'purchases')='array' AND jsonb_typeof(p->'id')='string' THEN (SELECT count(*) FROM jsonb_array_elements(ws.data->'purchases') n WHERE n->>'projectId'=p->>'id') END AS purchases
 FROM workspace_state ws CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.data->'projects')='array' THEN ws.data->'projects' ELSE '[]'::jsonb END) p
 ORDER BY ws.workspace_id,project_id;
-- Only generate SELECTs for tables that actually exist in the old database.
SELECT format('SELECT %L AS source,workspace_id,count(*) AS raw_rows FROM public.%I GROUP BY workspace_id ORDER BY workspace_id;',tablename,tablename) AS sql
 FROM pg_tables WHERE schemaname='public' AND tablename IN
 ('project','trade','task','memo','purchase','person','assignment','account','work_record','record_history','record_version','purchase_record','purchase_action','material_item','material_context','material_event','material_history','material_project_meta','material_alert','material_transfer','department','member_card','daily_assessment','assessment_history','audit_event','legacy_record_link','cloud_restore_backup','mention_notification')
 ORDER BY tablename
\gexec
SELECT 'SELECT workspace_id,id,project_id,node_date,status,deleted,created_by,created_name,created_at,updated_at FROM public.work_record ORDER BY workspace_id,project_id,id;' AS sql
 WHERE to_regclass('public.work_record') IS NOT NULL
\gexec
COMMIT;
