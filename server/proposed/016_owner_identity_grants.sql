-- Run with psql -v staff_role=<existing app role> -v owner_role=<new dedicated role>.
-- The owner role must be non-superuser/non-inheriting with no staff role membership.
GRANT USAGE ON SCHEMA owner_portal TO :"staff_role", :"owner_role";
GRANT SELECT, INSERT, UPDATE ON owner_portal.member, owner_portal.project_service,
  owner_portal.project_grant, owner_portal.invite TO :"staff_role";
GRANT SELECT (member_id), DELETE ON owner_portal.session TO :"staff_role";

GRANT SELECT (id, workspace_id, label, phone_digest, identity_digest, app_id),
  UPDATE (identity_digest, app_id, bound_at) ON owner_portal.member TO :"owner_role";
GRANT SELECT, UPDATE (consumed_at) ON owner_portal.invite TO :"owner_role";
GRANT SELECT, INSERT, DELETE ON owner_portal.session TO :"owner_role";
GRANT SELECT, INSERT, UPDATE ON owner_portal.login_limit TO :"owner_role";
GRANT SELECT ON owner_portal.available_project TO :"owner_role";
