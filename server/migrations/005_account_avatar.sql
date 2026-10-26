-- Small normalized PNGs, isolated from business history and author-private notes.
CREATE TABLE account_avatar (
 account_id text PRIMARY KEY REFERENCES account(id),
 png bytea NOT NULL CHECK(octet_length(png)>0 AND octet_length(png)<2097152),
 version text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
