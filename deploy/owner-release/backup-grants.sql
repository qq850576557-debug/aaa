-- Apply in the approved owner migration transaction with psql -v backup_role=<existing backup role>.
GRANT USAGE ON SCHEMA owner_portal TO :"backup_role";
GRANT SELECT ON owner_portal.member, owner_portal.project_service, owner_portal.project_grant,
  owner_portal.invite, owner_portal.session, owner_portal.login_limit,
  owner_portal.purchase_collaboration, owner_portal.purchase_event, owner_portal.purchase_write_limit,
  owner_portal.purchase_migration TO :"backup_role";
