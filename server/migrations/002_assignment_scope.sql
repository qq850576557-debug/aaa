CREATE FUNCTION check_assignment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM assignment WHERE workspace_id=NEW.workspace_id AND scope_kind=NEW.scope_kind AND scope_id=NEW.scope_id AND person_id=NEW.person_id) THEN RETURN NULL; END IF;
 IF NEW.scope_kind='project' AND NEW.scope_id<>NEW.project_id THEN RAISE EXCEPTION 'Invalid project assignment' USING ERRCODE='23514'; END IF;
 IF NEW.scope_kind='trade' AND NOT EXISTS(SELECT 1 FROM trade WHERE workspace_id=NEW.workspace_id AND id=NEW.scope_id AND project_id=NEW.project_id) THEN RAISE EXCEPTION 'Invalid trade assignment' USING ERRCODE='23514'; END IF;
 IF NEW.scope_kind='task' AND NOT EXISTS(SELECT 1 FROM task WHERE workspace_id=NEW.workspace_id AND id=NEW.scope_id AND project_id=NEW.project_id) THEN RAISE EXCEPTION 'Invalid task assignment' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER assignment_scope_check AFTER INSERT OR UPDATE ON assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_assignment_scope();
