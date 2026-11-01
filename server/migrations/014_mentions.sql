-- Additive only: no historical record is deleted, reclassified or moved.
ALTER TABLE work_record ADD COLUMN mention_ids text[] NOT NULL DEFAULT '{}' CHECK(cardinality(mention_ids)<=50);
CREATE TABLE mention_notification (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES cloud_workspace(id),
 recipient_id text NOT NULL REFERENCES account(id),
 actor_id text NOT NULL REFERENCES account(id), actor_name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('purchase','record')), record_id text NOT NULL,
 project_id text NOT NULL, project_name text NOT NULL,
 title text NOT NULL, summary text NOT NULL, node_date text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 UNIQUE(workspace_id,kind,record_id,recipient_id)
);
CREATE INDEX mention_notification_inbox ON mention_notification(workspace_id,recipient_id,id DESC);
CREATE INDEX mention_notification_unread ON mention_notification(workspace_id,recipient_id) WHERE read_at IS NULL;
