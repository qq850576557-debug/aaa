-- Apply only after 016. Existing purchase and workspace rows require no backfill.
CREATE TABLE owner_portal.purchase_collaboration (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  purchase_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  responsibility text NOT NULL CHECK (responsibility IN ('owner', 'company', 'supplier')),
  published boolean NOT NULL DEFAULT false CHECK (NOT published OR responsibility = 'owner'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description text NOT NULL CHECK (length(description) <= 4000),
  specification text NOT NULL CHECK (length(specification) <= 1000),
  quantity text NOT NULL CHECK (length(quantity) <= 100),
  reference text NOT NULL CHECK (length(reference) <= 1000 AND (reference = '' OR reference LIKE 'https://%')),
  bought boolean NOT NULL DEFAULT false,
  brand text NOT NULL DEFAULT '' CHECK (length(brand) <= 80),
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 80),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  feedback_actor_id text,
  feedback_actor_name text,
  feedback_at timestamptz,
  return_reason text NOT NULL DEFAULT '' CHECK (length(return_reason) <= 1000),
  PRIMARY KEY (workspace_id, project_id, purchase_id)
);
CREATE TABLE owner_portal.purchase_event (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  purchase_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner', 'staff')),
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  request_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('publication', 'purchase', 'withdraw', 'return', 'finish', 'reopen')),
  input jsonb NOT NULL,
  before_value jsonb,
  after_value jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, purchase_id, actor_kind, actor_id, request_id),
  FOREIGN KEY (workspace_id, project_id, purchase_id)
    REFERENCES owner_portal.purchase_collaboration(workspace_id, project_id, purchase_id)
);
CREATE TRIGGER immutable_owner_purchase_event BEFORE UPDATE OR DELETE ON owner_portal.purchase_event
  FOR EACH ROW EXECUTE FUNCTION public.immutable_audit_event();
CREATE TABLE owner_portal.purchase_write_limit (
  member_id uuid PRIMARY KEY REFERENCES owner_portal.member(id),
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);

-- The deadline is derived from the current purchase and its linked task, using the
-- same earliest-date rule as rawPurchaseDue/purchaseCeiling. No internal payload is exposed.
CREATE VIEW owner_portal.purchase_effective WITH (security_barrier=true) AS
SELECT p.workspace_id, p.project_id, p.id, p.payload->>'name' AS internal_title,
  least(planned.due, coalesce(p.payload->>'approvedDue', p.payload->>'originalDue', planned.due)) AS due,
  p.payload->>'status' IN ('已完成','已到货') AS complete
FROM public.purchase p
LEFT JOIN public.task t ON t.workspace_id=p.workspace_id AND t.project_id=p.project_id
  AND t.id=p.task_id AND (p.payload->>'deadlineMode') IS DISTINCT FROM 'fixed'
CROSS JOIN LATERAL (
  SELECT CASE WHEN t.id IS NULL THEN p.payload->>'due'
    ELSE to_char(t.start_date - (p.payload->>'leadDays')::integer, 'YYYY-MM-DD') END AS due
) planned;

CREATE VIEW owner_portal.purchase_staff WITH (security_barrier=true) AS
SELECT e.*, coalesce(p.version,0) AS version, p.responsibility, p.published, p.title, p.description,
  p.specification, p.quantity, p.reference, p.bought, p.brand, p.model, p.note,
  p.feedback_actor_name, p.feedback_at, p.return_reason,
  md5(jsonb_build_array(coalesce(p.version,0), e.due, e.complete, e.internal_title)::text) AS etag
FROM owner_portal.purchase_effective e
LEFT JOIN owner_portal.purchase_collaboration p ON p.workspace_id=e.workspace_id
  AND p.project_id=e.project_id AND p.purchase_id=e.id;

-- Retire an old publication when a purchase is removed or moved. Restoring the
-- same ID requires publishing again. The original purchase audit logs the change.
CREATE FUNCTION owner_portal.retire_purchase() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.project_id IS DISTINCT FROM NEW.project_id THEN
    UPDATE owner_portal.purchase_collaboration SET published=false, version=version+1
      WHERE workspace_id=OLD.workspace_id AND project_id=OLD.project_id AND purchase_id=OLD.id;
  ELSIF OLD.payload IS DISTINCT FROM NEW.payload THEN
    UPDATE owner_portal.purchase_collaboration SET version=version+1
      WHERE workspace_id=OLD.workspace_id AND project_id=OLD.project_id AND purchase_id=OLD.id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION owner_portal.retire_purchase() FROM PUBLIC;
CREATE TRIGGER retire_owner_purchase AFTER DELETE OR UPDATE OF project_id,payload ON public.purchase
  FOR EACH ROW EXECUTE FUNCTION owner_portal.retire_purchase();

CREATE FUNCTION owner_portal.owner_purchases(session_key text, project_key text)
RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'id',p.id,'title',p.title,'description',p.description,'due',p.due,
    'specification',p.specification,'quantity',p.quantity,'reference',p.reference,
    'state',CASE WHEN p.complete THEN 'complete' WHEN p.bought THEN 'bought' ELSE 'pending' END,
    'version',p.etag,'feedback',jsonb_build_object('brand',p.brand,'model',p.model,'note',p.note),
    'returnReason',p.return_reason)
  FROM owner_portal.session s
  JOIN owner_portal.available_project g ON g.member_id=s.member_id AND g.id=project_key
  JOIN owner_portal.purchase_staff p ON p.workspace_id=g.workspace_id AND p.project_id=g.id
  WHERE s.digest=session_key AND s.expires_at>now() AND p.published AND p.responsibility='owner'
  ORDER BY p.due,p.id
$$;
REVOKE ALL ON FUNCTION owner_portal.owner_purchases(text,text) FROM PUBLIC;

CREATE FUNCTION owner_portal.owner_purchase_feedback(
  session_key text, project_key text, purchase_key text, request_key uuid,
  expected text, action text, feedback jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  actor owner_portal.member%ROWTYPE;
  prior owner_portal.purchase_staff%ROWTYPE;
  previous jsonb;
  sent jsonb := jsonb_build_object('version',expected,'action',action,'feedback',feedback);
  attempts integer;
BEGIN
  SELECT m.* INTO actor FROM owner_portal.session s
    JOIN owner_portal.member m ON m.id=s.member_id
    WHERE s.digest=session_key AND s.expires_at>now();
  IF NOT FOUND THEN RETURN 'session'; END IF;
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
  IF action NOT IN ('purchase','withdraw') THEN RETURN 'invalid'; END IF;
  IF action='purchase' AND (
    jsonb_typeof(feedback) IS DISTINCT FROM 'object' OR
    jsonb_typeof(feedback->'brand') IS DISTINCT FROM 'string' OR
    jsonb_typeof(feedback->'model') IS DISTINCT FROM 'string' OR
    jsonb_typeof(feedback->'note') IS DISTINCT FROM 'string' OR
    (feedback - ARRAY['brand','model','note']) <> '{}'::jsonb OR
    length(feedback->>'brand')>80 OR length(feedback->>'model')>80 OR length(feedback->>'note')>1000
  ) THEN RETURN 'invalid'; END IF;
  UPDATE owner_portal.purchase_collaboration p SET
    version=p.version+1, bought=action='purchase',
    brand=CASE WHEN action='purchase' THEN feedback->>'brand' ELSE p.brand END,
    model=CASE WHEN action='purchase' THEN feedback->>'model' ELSE p.model END,
    note=CASE WHEN action='purchase' THEN feedback->>'note' ELSE p.note END,
    feedback_actor_id=CASE WHEN action='purchase' THEN actor.id::text ELSE p.feedback_actor_id END,
    feedback_actor_name=CASE WHEN action='purchase' THEN actor.label ELSE p.feedback_actor_name END,
    feedback_at=CASE WHEN action='purchase' THEN now() ELSE p.feedback_at END,
    return_reason=''
    WHERE p.workspace_id=actor.workspace_id AND p.project_id=project_key AND p.purchase_id=purchase_key;
  INSERT INTO owner_portal.purchase_event
    (workspace_id,project_id,purchase_id,actor_kind,actor_id,actor_name,request_id,operation,input,before_value,after_value)
    SELECT p.workspace_id,p.project_id,p.purchase_id,'owner',actor.id::text,actor.label,request_key,action,sent,
      jsonb_build_object('bought',prior.bought,'brand',prior.brand,'model',prior.model,'note',prior.note),
      jsonb_build_object('bought',p.bought,'brand',p.brand,'model',p.model,'note',p.note)
    FROM owner_portal.purchase_collaboration p
    WHERE p.workspace_id=actor.workspace_id AND p.project_id=project_key AND p.purchase_id=purchase_key;
  RETURN 'saved';
END $$;
REVOKE ALL ON FUNCTION owner_portal.owner_purchase_feedback(text,text,text,uuid,text,text,jsonb) FROM PUBLIC;

CREATE TABLE owner_portal.purchase_migration (
  filename text PRIMARY KEY, sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
