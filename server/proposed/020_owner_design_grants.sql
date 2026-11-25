GRANT SELECT, INSERT, UPDATE ON owner_portal.project_design TO :"staff_role";
GRANT EXECUTE ON FUNCTION owner_portal.authorized_design(text,text) TO :"owner_role";
