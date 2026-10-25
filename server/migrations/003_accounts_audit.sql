-- Additive V1.1 migration. Stable login/id and every existing business row stay unchanged.
ALTER TABLE account ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK(char_length(display_name)<=80);
ALTER TABLE account ADD CONSTRAINT account_workspace_identity UNIQUE(workspace_id,id);
CREATE TABLE account_note(
 workspace_id text NOT NULL,
 author_id text NOT NULL,
 target_id text NOT NULL,
 note text NOT NULL CHECK(char_length(note)<=1000),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,author_id,target_id),
 FOREIGN KEY(workspace_id,author_id) REFERENCES account(workspace_id,id),
 FOREIGN KEY(workspace_id,target_id) REFERENCES account(workspace_id,id),
 CHECK(author_id<>target_id)
);
ALTER TABLE audit_event
 ADD COLUMN actor_display_name text NOT NULL DEFAULT '',
 ADD COLUMN entity_type text NOT NULL DEFAULT 'workspace',
 ADD COLUMN entity_id text NOT NULL DEFAULT '',
 ADD COLUMN operation text NOT NULL DEFAULT 'update',
 ADD COLUMN before_value jsonb,
 ADD COLUMN after_value jsonb,
 ADD COLUMN changed_fields jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN device jsonb NOT NULL DEFAULT '{"category":"unknown","os":"未知","browser":"未知","model":"未知设备","source":"历史记录未采集设备信息"}';
-- Before this migration accounts displayed their stable login, not a custom display name.
UPDATE audit_event e SET actor_display_name=a.login FROM account a WHERE e.actor_id=a.id;
CREATE INDEX audit_workspace_time ON audit_event(workspace_id,created_at DESC,id DESC);
CREATE INDEX audit_workspace_entity ON audit_event(workspace_id,entity_type,created_at DESC);
CREATE FUNCTION immutable_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE='42501';
END $$;
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION immutable_audit_event();
