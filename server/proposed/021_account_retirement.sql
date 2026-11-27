-- Preserve account and identity records used by business history and audit.
ALTER TABLE public.account ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT retired_employee_inactive CHECK (deleted_at IS NULL OR (NOT active AND role='employee'));

ALTER TABLE owner_portal.member ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT retired_owner_unbound CHECK (deleted_at IS NULL OR identity_digest IS NULL);

CREATE OR REPLACE VIEW owner_portal.available_project WITH (security_barrier=true) AS
  SELECT g.member_id, p.workspace_id, p.id, p.payload->>'name' AS title,
         p.payload->>'status' AS phase
  FROM owner_portal.project_grant g
  JOIN owner_portal.project_service s USING (workspace_id,project_id)
  JOIN owner_portal.member m ON m.workspace_id=g.workspace_id AND m.id=g.member_id
  JOIN public.project p ON p.workspace_id=g.workspace_id AND p.id=g.project_id
  WHERE s.enabled AND g.revoked_at IS NULL AND m.deleted_at IS NULL;
