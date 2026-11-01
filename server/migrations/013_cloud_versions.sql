-- Additive history metadata and recovery protection. Existing business rows are untouched.
CREATE TABLE workspace_history_revision (
 workspace_id text NOT NULL REFERENCES cloud_workspace(id), node_id text NOT NULL,
 revision bigint NOT NULL, PRIMARY KEY(workspace_id,node_id)
);
CREATE TABLE record_version (
 workspace_id text NOT NULL, record_id text NOT NULL, version integer NOT NULL,
 snapshot jsonb NOT NULL, at timestamptz NOT NULL, actor_id text NOT NULL,
 actor_name text NOT NULL, baseline boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,record_id,version),
 FOREIGN KEY(workspace_id,record_id) REFERENCES work_record(workspace_id,id)
);
-- Only the current, actually stored version can be backfilled. Do not invent older contents.
INSERT INTO record_version SELECT workspace_id,id,version,to_jsonb(r),updated_at,updated_by,updated_name,true FROM work_record r;
CREATE TABLE cloud_restore_backup (
 workspace_id text NOT NULL REFERENCES cloud_workspace(id), request_id text NOT NULL,
 actor_id text NOT NULL REFERENCES account(id), body_hash text NOT NULL,
 backup jsonb NOT NULL, result jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,request_id)
);
CREATE TRIGGER restore_backup_immutable BEFORE UPDATE OR DELETE ON cloud_restore_backup FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
CREATE TRIGGER workspace_revision_immutable BEFORE UPDATE OR DELETE ON workspace_history_revision FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
CREATE FUNCTION protect_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND OLD.at < now()-interval '15 days' AND EXISTS(SELECT 1 FROM work_record WHERE workspace_id=OLD.workspace_id AND id=OLD.record_id AND version>OLD.version) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'history snapshot is immutable' USING ERRCODE='42501';
END $$;
CREATE TRIGGER record_version_immutable BEFORE UPDATE OR DELETE ON record_version FOR EACH ROW EXECUTE FUNCTION protect_record_version();
CREATE FUNCTION capture_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.version=OLD.version THEN RETURN NEW; END IF;
 INSERT INTO record_version VALUES(NEW.workspace_id,NEW.id,NEW.version,to_jsonb(NEW),NEW.updated_at,NEW.updated_by,NEW.updated_name,false);
 DELETE FROM record_version WHERE workspace_id=NEW.workspace_id AND record_id=NEW.id AND at<now()-interval '15 days' AND version<NEW.version;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_record_version AFTER INSERT OR UPDATE ON work_record FOR EACH ROW EXECUTE FUNCTION capture_record_version();
