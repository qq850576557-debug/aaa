-- Owner access is through the protected function only. Backups cover all revisions.
GRANT SELECT ON owner_portal.purchase_feedback_photo TO :"staff_role", :"backup_role";
GRANT EXECUTE ON FUNCTION owner_portal.owner_purchase_photo(text,text,text,text) TO :"owner_role";
