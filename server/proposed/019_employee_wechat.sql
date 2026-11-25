-- Additive and intentionally outside the production migration allowlist.
CREATE TABLE public.employee_wechat_binding (
  account_id text PRIMARY KEY REFERENCES public.account(id),
  phone_digest text UNIQUE NOT NULL CHECK (phone_digest ~ '^[a-f0-9]{64}$'),
  phone_suffix text NOT NULL CHECK (phone_suffix ~ '^[0-9]{4}$'),
  app_id text,
  identity_digest text,
  UNIQUE (app_id, identity_digest),
  CHECK ((app_id IS NULL) = (identity_digest IS NULL))
);
REVOKE ALL ON public.employee_wechat_binding FROM PUBLIC;

CREATE FUNCTION public.clear_employee_wechat_on_credential_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (OLD.active AND NOT NEW.active) OR OLD.password_hash IS DISTINCT FROM NEW.password_hash THEN
    UPDATE public.employee_wechat_binding SET identity_digest=NULL,app_id=NULL
    WHERE account_id=NEW.id AND identity_digest IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.clear_employee_wechat_on_credential_change() FROM PUBLIC;
CREATE TRIGGER clear_employee_wechat_on_credential_change
AFTER UPDATE OF active, password_hash ON public.account
FOR EACH ROW EXECUTE FUNCTION public.clear_employee_wechat_on_credential_change();

-- Match the owner portal retirement behavior when a project is removed.
-- This prevents an active collaboration grant from blocking normal project removal.
CREATE FUNCTION public.retire_employee_project_permission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  DELETE FROM public.project_permission WHERE workspace_id=OLD.workspace_id AND project_id=OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.retire_employee_project_permission() FROM PUBLIC;
CREATE TRIGGER retire_employee_project_permission BEFORE DELETE ON public.project
FOR EACH ROW EXECUTE FUNCTION public.retire_employee_project_permission();
