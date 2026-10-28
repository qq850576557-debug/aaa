-- Additive public staff cards and independently protected employment date.
CREATE TABLE department (
 workspace_id text NOT NULL REFERENCES cloud_workspace(id), id text NOT NULL,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 60),
 name_key text COLLATE "C" GENERATED ALWAYS AS (lower(normalize(name,NFKC))) STORED,
 english_name text NOT NULL DEFAULT '' CHECK(char_length(english_name)<=100),
 active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,name_key)
);
CREATE TABLE member_card (
 workspace_id text NOT NULL, account_id text NOT NULL,
 english_name text NOT NULL DEFAULT '' CHECK(char_length(english_name)<=80),
 department_id text, joined_on date CHECK(joined_on BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,account_id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES account(workspace_id,id),
 FOREIGN KEY(workspace_id,department_id) REFERENCES department(workspace_id,id)
);
