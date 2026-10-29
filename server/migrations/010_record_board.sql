-- Independent project follow-up records; do not rewrite the existing workspace graph.
-- No FK to project: its projection is transactionally rebuilt on every workspace save.
CREATE TABLE work_record (
 workspace_id text NOT NULL REFERENCES cloud_workspace(id),
 id text NOT NULL,
 project_id text NOT NULL,
 project_name text NOT NULL,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 240),
 node_date text NOT NULL DEFAULT '',
 status text NOT NULL CHECK(status IN ('待执行','进行中','持续跟进','待备料','紧急','已完成','已取消')),
 notes text NOT NULL DEFAULT '' CHECK(char_length(notes)<=4000),
 follow_up text NOT NULL DEFAULT '' CHECK(char_length(follow_up)<=4000),
 version integer NOT NULL CHECK(version>0),
 deleted boolean NOT NULL DEFAULT false,
 created_by text NOT NULL REFERENCES account(id),
 created_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_by text NOT NULL REFERENCES account(id),
 updated_name text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
CREATE INDEX work_record_project ON work_record(workspace_id,project_id) WHERE NOT deleted;
CREATE TABLE record_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id text NOT NULL,
 record_id text NOT NULL,
 actor_id text NOT NULL REFERENCES account(id),
 actor_name text NOT NULL,
 at timestamptz NOT NULL DEFAULT now(),
 operation text NOT NULL CHECK(operation IN ('create','update','delete')),
 changed_fields jsonb NOT NULL,
 before_value jsonb,
 after_value jsonb,
 FOREIGN KEY(workspace_id,record_id) REFERENCES work_record(workspace_id,id)
);
CREATE INDEX record_history_lookup ON record_history(workspace_id,record_id,id DESC);
CREATE TRIGGER record_history_immutable BEFORE UPDATE OR DELETE ON record_history FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
CREATE TABLE record_submission (
 workspace_id text NOT NULL REFERENCES cloud_workspace(id),
 request_id text NOT NULL,
 actor_id text NOT NULL REFERENCES account(id),
 body_hash text NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(workspace_id,request_id)
);
CREATE TRIGGER record_submission_immutable BEFORE UPDATE OR DELETE ON record_submission FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
