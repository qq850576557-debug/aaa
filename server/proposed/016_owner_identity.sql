-- Reviewed separately from the normal deployment migration allowlist.
CREATE SCHEMA owner_portal;
REVOKE ALL ON SCHEMA owner_portal FROM PUBLIC;

CREATE TABLE owner_portal.member (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  label text NOT NULL,
  phone_digest text NOT NULL,
  phone_sealed jsonb NOT NULL,
  phone_suffix text NOT NULL CHECK (phone_suffix ~ '^[0-9]{4}$'),
  app_id text,
  identity_digest text,
  bound_at timestamptz,
  UNIQUE (workspace_id, phone_digest),
  UNIQUE (app_id, identity_digest),
  UNIQUE (workspace_id, id),
  CHECK ((app_id IS NULL) = (identity_digest IS NULL) AND (bound_at IS NULL) = (identity_digest IS NULL))
);
CREATE TABLE owner_portal.project_service (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY (workspace_id, project_id)
);
CREATE TABLE owner_portal.project_grant (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  member_id uuid NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, project_id, member_id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES owner_portal.member(workspace_id,id)
);
CREATE INDEX owner_project_grant_member ON owner_portal.project_grant(member_id) WHERE revoked_at IS NULL;
CREATE TABLE owner_portal.invite (
  digest text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  member_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (workspace_id,project_id,member_id)
    REFERENCES owner_portal.project_grant(workspace_id,project_id,member_id)
);
CREATE INDEX owner_invite_member ON owner_portal.invite(member_id);
CREATE TABLE owner_portal.session (
  digest text PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES owner_portal.member(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX owner_session_member ON owner_portal.session(member_id);
CREATE TABLE owner_portal.login_limit (
  digest text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE VIEW owner_portal.available_project WITH (security_barrier=true) AS
  SELECT g.member_id, p.workspace_id, p.id, p.payload->>'name' AS title,
         p.payload->>'status' AS phase
  FROM owner_portal.project_grant g
  JOIN owner_portal.project_service s USING (workspace_id,project_id)
  JOIN public.project p ON p.workspace_id=g.workspace_id AND p.id=g.project_id
  WHERE s.enabled AND g.revoked_at IS NULL;

-- Restore/import of the same project ID must never revive owner access.
CREATE FUNCTION owner_portal.retire_project() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE owner_portal.project_service SET enabled=false
    WHERE workspace_id=OLD.workspace_id AND project_id=OLD.id AND enabled;
  UPDATE owner_portal.project_grant SET revoked_at=now()
    WHERE workspace_id=OLD.workspace_id AND project_id=OLD.id AND revoked_at IS NULL;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION owner_portal.retire_project() FROM PUBLIC;
CREATE TRIGGER retire_owner_project AFTER DELETE ON public.project
  FOR EACH ROW EXECUTE FUNCTION owner_portal.retire_project();
