-- Explicit, owner-confirmed business migration only; this schema migration moves no records.
CREATE TABLE legacy_migration_batch (
 workspace_id text NOT NULL REFERENCES cloud_workspace(id), request_id text NOT NULL,
 actor_id text NOT NULL REFERENCES account(id), body_hash text NOT NULL,
 backup jsonb NOT NULL, result jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,request_id)
);
CREATE TABLE legacy_record_link (
 id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 workspace_id text NOT NULL REFERENCES cloud_workspace(id), source_key text NOT NULL,
 source_id text NOT NULL, project_id text NOT NULL, source_hash text NOT NULL,
 source jsonb NOT NULL, source_history jsonb NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN ('purchase','record','reference')),
 target_id text, actor_id text NOT NULL REFERENCES account(id),
 batch_id text NOT NULL, at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,source_key),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES legacy_migration_batch(workspace_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER legacy_batch_immutable BEFORE UPDATE OR DELETE ON legacy_migration_batch FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
CREATE TRIGGER legacy_link_immutable BEFORE UPDATE OR DELETE ON legacy_record_link FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
