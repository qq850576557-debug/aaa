-- Additive studio settings; no rewrite of prior business data.
CREATE TABLE studio_daily (
 workspace_id text PRIMARY KEY REFERENCES cloud_workspace(id),
 version integer NOT NULL CHECK(version>=1),
 value jsonb NOT NULL,
 updated_by text NOT NULL REFERENCES account(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE studio_daily_submission (
 workspace_id text NOT NULL REFERENCES cloud_workspace(id),
 request_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES account(id),
 body_hash text NOT NULL,
 version integer NOT NULL,
 PRIMARY KEY(workspace_id,request_id)
);
CREATE TRIGGER studio_daily_submission_immutable BEFORE UPDATE OR DELETE ON studio_daily_submission FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
