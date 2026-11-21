-- Staff permissions are verified against the existing project_permission table.
GRANT SELECT ON public.project_permission TO :"staff_role";
GRANT SELECT ON owner_portal.purchase_staff TO :"staff_role";
GRANT SELECT, INSERT, UPDATE ON owner_portal.purchase_collaboration TO :"staff_role";
GRANT SELECT, INSERT ON owner_portal.purchase_event TO :"staff_role";

-- Only protected, session-aware functions are visible to the dedicated owner role.
GRANT EXECUTE ON FUNCTION owner_portal.owner_purchases(text,text),
  owner_portal.owner_purchase_feedback(text,text,text,uuid,text,text,jsonb) TO :"owner_role";
