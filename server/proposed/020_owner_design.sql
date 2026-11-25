CREATE TABLE owner_portal.project_design (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  rendering text NOT NULL DEFAULT '' CHECK (rendering='' OR (length(rendering)<=1500 AND rendering LIKE 'https://%')),
  panorama text NOT NULL DEFAULT '' CHECK (panorama='' OR (length(panorama)<=1500 AND panorama LIKE 'https://%')),
  version integer NOT NULL CHECK (version>0),
  PRIMARY KEY (workspace_id,project_id),
  FOREIGN KEY (workspace_id,project_id) REFERENCES public.project(workspace_id,id) ON DELETE CASCADE
);
REVOKE ALL ON owner_portal.project_design FROM PUBLIC;

CREATE FUNCTION owner_portal.authorized_design(session_key text, project_key text)
RETURNS TABLE (rendering text, panorama text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(d.rendering,''),COALESCE(d.panorama,'')
  FROM owner_portal.session s
  JOIN owner_portal.available_project p ON p.member_id=s.member_id AND p.id=project_key
  LEFT JOIN owner_portal.project_design d ON d.workspace_id=p.workspace_id AND d.project_id=p.id
  WHERE s.digest=session_key AND s.expires_at>now()
$$;
REVOKE ALL ON FUNCTION owner_portal.authorized_design(text,text) FROM PUBLIC;
