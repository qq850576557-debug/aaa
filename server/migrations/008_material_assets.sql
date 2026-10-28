-- Material records refer to stable business IDs without cascading from replaceable
-- workspace projections. All new links are validated against the shared workspace.
CREATE TABLE material_operator(workspace_id text NOT NULL,account_id text NOT NULL,PRIMARY KEY(workspace_id,account_id),FOREIGN KEY(workspace_id,account_id) REFERENCES account(workspace_id,id));
CREATE TABLE material_item(workspace_id text NOT NULL REFERENCES cloud_workspace(id),id text NOT NULL,version integer NOT NULL CHECK(version>0),payload jsonb NOT NULL,PRIMARY KEY(workspace_id,id));
CREATE TABLE material_project_meta(workspace_id text NOT NULL REFERENCES cloud_workspace(id),id text NOT NULL,version integer NOT NULL CHECK(version>0),payload jsonb NOT NULL,PRIMARY KEY(workspace_id,id));
CREATE TABLE material_context(workspace_id text NOT NULL REFERENCES cloud_workspace(id),id text NOT NULL,version integer NOT NULL CHECK(version>0),payload jsonb NOT NULL,PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX material_context_zone ON material_context(workspace_id,(payload->>'projectId'),(payload->>'materialId'),(payload->>'phase'),(payload->>'zone'));
CREATE TABLE material_event(workspace_id text NOT NULL REFERENCES cloud_workspace(id),id text NOT NULL,seq bigint NOT NULL,request_id text NOT NULL,body_hash text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,seq),UNIQUE(workspace_id,request_id));
CREATE TABLE material_alert(workspace_id text NOT NULL REFERENCES cloud_workspace(id),id text NOT NULL,version integer NOT NULL CHECK(version>0),payload jsonb NOT NULL,PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX material_alert_source ON material_alert(workspace_id,(payload->>'key'));
CREATE TABLE material_history(workspace_id text NOT NULL REFERENCES cloud_workspace(id),id text NOT NULL,entity_id text NOT NULL,actor_id text NOT NULL REFERENCES account(id),actor_name text NOT NULL,at timestamptz NOT NULL DEFAULT now(),before_value jsonb,after_value jsonb NOT NULL,PRIMARY KEY(workspace_id,id));
CREATE TRIGGER material_event_immutable BEFORE UPDATE OR DELETE ON material_event FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
CREATE TRIGGER material_history_immutable BEFORE UPDATE OR DELETE ON material_history FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
