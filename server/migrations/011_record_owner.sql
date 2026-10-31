-- Existing records remain unchanged; legacy clients may continue to omit owner.
ALTER TABLE work_record ADD COLUMN owner text NOT NULL DEFAULT '' CHECK (char_length(owner) <= 100);
