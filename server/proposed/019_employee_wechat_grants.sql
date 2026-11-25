GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_wechat_binding TO :"staff_role";
GRANT INSERT ON public.project_permission TO :"staff_role";
GRANT UPDATE (can_write) ON public.project_permission TO :"staff_role";
GRANT DELETE ON public.project_permission TO :"staff_role";
