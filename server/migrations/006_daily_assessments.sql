-- Additive, independent of replaceable workspace projections and 15-day history.
CREATE TABLE assessment_recorder(
 workspace_id text NOT NULL REFERENCES cloud_workspace(id), account_id text NOT NULL,
 granted_by text NOT NULL REFERENCES account(id), granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,account_id), FOREIGN KEY(workspace_id,account_id) REFERENCES account(workspace_id,id)
);
CREATE TABLE daily_assessment(
 workspace_id text NOT NULL REFERENCES cloud_workspace(id), id text NOT NULL,
 work_date date NOT NULL CHECK(work_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
 person_id text NOT NULL, project_id text NOT NULL, trade_id text NOT NULL,
 version integer NOT NULL CHECK(version>0), payload jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,work_date,person_id,project_id,trade_id),
 CHECK(payload->>'attendance' IN ('pending','yes','no')),
 CHECK(payload->>'photo' IN ('pending','yes','no')),
 CHECK(payload->>'cleaning' IN ('pending','yes','no'))
);
CREATE INDEX assessment_date ON daily_assessment(workspace_id,work_date,person_id,project_id);
CREATE TABLE assessment_history(
 id text PRIMARY KEY, workspace_id text NOT NULL, record_id text NOT NULL,
 actor_id text NOT NULL REFERENCES account(id), actor_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), before_value jsonb, after_value jsonb NOT NULL,
 FOREIGN KEY(workspace_id,record_id) REFERENCES daily_assessment(workspace_id,id)
);
CREATE INDEX assessment_history_record ON assessment_history(workspace_id,record_id,created_at);
CREATE TRIGGER assessment_history_immutable BEFORE UPDATE OR DELETE ON assessment_history FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
CREATE TABLE assessment_submission(
 workspace_id text NOT NULL REFERENCES cloud_workspace(id), request_id text NOT NULL,
 actor_id text NOT NULL REFERENCES account(id), body_hash text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,request_id)
);
