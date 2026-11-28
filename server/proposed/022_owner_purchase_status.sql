-- Keep the owner write, canonical purchase, workspace revision and owner audit in one transaction.
-- Replacing the view/function preserves the existing grants and requires no historical rewrite.
CREATE OR REPLACE VIEW owner_portal.purchase_staff WITH (security_barrier=true) AS
SELECT e.*, coalesce(p.version,0) AS version, p.responsibility, p.published, p.title, p.description,
  p.specification, p.quantity, p.reference,
  (coalesce(p.bought,false) OR EXISTS (
    SELECT 1 FROM public.purchase source
    WHERE source.workspace_id=e.workspace_id AND source.project_id=e.project_id AND source.id=e.id
      AND source.payload->>'status'='已下单'
  )) AS bought, p.brand, p.model, p.note,
  p.feedback_actor_name, p.feedback_at, p.return_reason,
  md5(jsonb_build_array(coalesce(p.version,0), e.due, e.complete, e.internal_title)::text) AS etag, p.feedback_link, p.feedback_photo
FROM owner_portal.purchase_effective e
LEFT JOIN owner_portal.purchase_collaboration p ON p.workspace_id=e.workspace_id
  AND p.project_id=e.project_id AND p.purchase_id=e.id;

CREATE OR REPLACE FUNCTION owner_portal.owner_purchase_feedback(
  session_key text, project_key text, purchase_key text, request_key uuid,
  expected text, action text, feedback jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  actor owner_portal.member%ROWTYPE;
  prior owner_portal.purchase_staff%ROWTYPE;
  previous jsonb;
  sent jsonb;
  audited_feedback jsonb := feedback;
  jpeg_bytes bytea;
  photo_digest text;
  attempts integer;
  next_status text;
  saved_revision bigint;
BEGIN
  SELECT m.* INTO actor FROM owner_portal.session s
    JOIN owner_portal.member m ON m.id=s.member_id
    WHERE s.digest=session_key AND s.expires_at>now();
  IF NOT FOUND THEN RETURN 'session'; END IF;
  -- Match the workspace writer's lock order before acquiring the shared authorization lock.
  PERFORM 1 FROM public.workspace_state WHERE workspace_id=actor.workspace_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'hidden'; END IF;
  -- Shared with project authorization, staff actions and normal workspace saves.
  PERFORM pg_advisory_xact_lock(hashtextextended(actor.workspace_id,16));
  IF NOT EXISTS (SELECT 1 FROM owner_portal.session WHERE digest=session_key AND expires_at>now())
    THEN RETURN 'session'; END IF;
  SELECT p.* INTO prior FROM owner_portal.purchase_staff p
    JOIN owner_portal.available_project g
      ON g.workspace_id=p.workspace_id AND g.id=p.project_id AND g.member_id=actor.id
    WHERE p.workspace_id=actor.workspace_id AND p.project_id=project_key
      AND p.id=purchase_key AND p.published AND p.responsibility='owner';
  IF NOT FOUND THEN RETURN 'hidden'; END IF;
  IF action IS NULL OR action NOT IN ('purchase','withdraw') THEN RETURN 'invalid'; END IF;
  IF action='purchase' AND (
    jsonb_typeof(feedback) IS DISTINCT FROM 'object' OR
    jsonb_typeof(feedback->'brand') IS DISTINCT FROM 'string' OR
    jsonb_typeof(feedback->'model') IS DISTINCT FROM 'string' OR
    jsonb_typeof(feedback->'note') IS DISTINCT FROM 'string' OR
    (feedback - ARRAY['brand','model','note','link','image']) <> '{}'::jsonb OR
    (feedback ? 'link' AND (jsonb_typeof(feedback->'link') IS DISTINCT FROM 'string' OR
      length(feedback->>'link')>1000 OR (feedback->>'link' <> '' AND feedback->>'link' NOT LIKE 'https://%'))) OR
    (feedback ? 'image' AND (jsonb_typeof(feedback->'image') IS DISTINCT FROM 'string' OR
      length(feedback->>'image')>699052 OR feedback->>'image' !~ '^[A-Za-z0-9+/]*={0,2}$')) OR
    length(feedback->>'brand')>80 OR length(feedback->>'model')>80 OR length(feedback->>'note')>1000
  ) THEN RETURN 'invalid'; END IF;
  IF action='purchase' AND feedback ? 'image' THEN
    IF feedback->>'image' <> '' THEN
      BEGIN
        jpeg_bytes := decode(feedback->>'image','base64');
      EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
        RETURN 'invalid';
      END;
      IF octet_length(jpeg_bytes) NOT BETWEEN 3 AND 524288
          OR substring(jpeg_bytes FROM 1 FOR 3) <> decode('ffd8ff','hex')
        THEN RETURN 'invalid'; END IF;
      photo_digest := encode(sha256(jpeg_bytes),'hex');
    END IF;
    audited_feedback := (feedback - 'image') || jsonb_build_object('imageId',photo_digest);
  END IF;
  sent := jsonb_build_object('version',expected,'action',action,'feedback',audited_feedback);
  SELECT e.input INTO previous FROM owner_portal.purchase_event e
    WHERE e.workspace_id=actor.workspace_id AND e.project_id=project_key AND e.purchase_id=purchase_key
      AND e.actor_kind='owner' AND e.actor_id=actor.id::text AND e.request_id=request_key;
  IF FOUND THEN
    RETURN CASE WHEN previous=sent THEN 'saved' ELSE 'conflict' END;
  END IF;
  INSERT INTO owner_portal.purchase_write_limit AS l VALUES(actor.id,1,now()+interval '1 minute')
    ON CONFLICT(member_id) DO UPDATE SET
    attempts=CASE WHEN l.expires_at<=now() THEN 1 ELSE l.attempts+1 END,
    expires_at=CASE WHEN l.expires_at<=now() THEN now()+interval '1 minute' ELSE l.expires_at END
    RETURNING l.attempts INTO attempts;
  IF attempts>30 THEN RETURN 'limit'; END IF;
  IF prior.etag<>expected OR prior.complete OR (action='withdraw' AND NOT prior.bought)
    THEN RETURN 'conflict'; END IF;
  IF jpeg_bytes IS NOT NULL THEN
    INSERT INTO owner_portal.purchase_feedback_photo
      VALUES(actor.workspace_id,project_key,purchase_key,photo_digest,jpeg_bytes) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE owner_portal.purchase_collaboration p SET
    version=p.version+1, bought=action='purchase',
    brand=CASE WHEN action='purchase' THEN feedback->>'brand' ELSE p.brand END,
    model=CASE WHEN action='purchase' THEN feedback->>'model' ELSE p.model END,
    note=CASE WHEN action='purchase' THEN feedback->>'note' ELSE p.note END,
    feedback_link=CASE WHEN action='purchase' AND feedback ? 'link' THEN feedback->>'link' ELSE p.feedback_link END,
    feedback_photo=CASE WHEN action='purchase' AND feedback ? 'image' THEN photo_digest ELSE p.feedback_photo END,
    feedback_actor_id=CASE WHEN action='purchase' THEN actor.id::text ELSE p.feedback_actor_id END,
    feedback_actor_name=CASE WHEN action='purchase' THEN actor.label ELSE p.feedback_actor_name END,
    feedback_at=CASE WHEN action='purchase' THEN now() ELSE p.feedback_at END,
    return_reason=''
    WHERE p.workspace_id=actor.workspace_id AND p.project_id=project_key AND p.purchase_id=purchase_key;
  next_status := CASE WHEN action='purchase' THEN '已下单' ELSE '待采购' END;
  UPDATE public.purchase SET payload=jsonb_set(payload,'{status}',to_jsonb(next_status))
    WHERE workspace_id=actor.workspace_id AND project_id=project_key AND id=purchase_key
      AND payload->>'status' IS DISTINCT FROM next_status;
  IF FOUND THEN
    UPDATE public.purchase_record SET payload=jsonb_set(payload,'{status}',to_jsonb(next_status))
      WHERE workspace_id=actor.workspace_id AND project_id=project_key AND id=purchase_key AND NOT deleted;
    UPDATE public.workspace_state w
      SET data=jsonb_set(w.data, '{purchases}', (
        SELECT jsonb_agg(
          CASE WHEN node->>'id'=purchase_key AND node->>'projectId'=project_key
            THEN jsonb_set(node,'{status}',to_jsonb(next_status)) ELSE node END ORDER BY ord
        ) FROM jsonb_array_elements(w.data->'purchases') WITH ORDINALITY AS entries(node,ord)
      )), revision=w.revision+1
      WHERE w.workspace_id=actor.workspace_id AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(w.data->'purchases') AS node
        WHERE node->>'id'=purchase_key AND node->>'projectId'=project_key
      )
      RETURNING revision INTO saved_revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase is missing from the workspace'; END IF;
    PERFORM pg_notify('chunmo_updates', jsonb_build_object(
      'workspaceId',actor.workspace_id,'revision',saved_revision)::text);
  END IF;
  INSERT INTO owner_portal.purchase_event
    (workspace_id,project_id,purchase_id,actor_kind,actor_id,actor_name,request_id,operation,input,before_value,after_value)
    SELECT p.workspace_id,p.project_id,p.purchase_id,'owner',actor.id::text,actor.label,request_key,action,sent,
      jsonb_build_object('status',CASE WHEN prior.bought THEN '已下单' ELSE '待采购' END,'bought',prior.bought,'brand',prior.brand,'model',prior.model,'note',prior.note,'link',prior.feedback_link,'imageId',prior.feedback_photo),
      jsonb_build_object('status',next_status,'bought',p.bought,'brand',p.brand,'model',p.model,'note',p.note,'link',p.feedback_link,'imageId',p.feedback_photo)
    FROM owner_portal.purchase_collaboration p
    WHERE p.workspace_id=actor.workspace_id AND p.project_id=project_key AND p.purchase_id=purchase_key;
  RETURN 'saved';
END $$;
REVOKE ALL ON FUNCTION owner_portal.owner_purchase_feedback(text,text,text,uuid,text,text,jsonb) FROM PUBLIC;
