-- Additive identity migration: preserve every existing id/login and business relation.
-- Generated key is canonical and unique across every studio, independent of collation.
ALTER TABLE account ADD COLUMN login_changed_at timestamptz;
ALTER TABLE account ADD COLUMN login_key text COLLATE "C" GENERATED ALWAYS AS
 (translate(normalize(login,NFKC),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')) STORED;
-- If existing names collide canonically this transaction stops without rewriting identities.
ALTER TABLE account ADD CONSTRAINT account_login_key_unique UNIQUE(login_key);
CREATE FUNCTION guard_account_login() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical_name text; changed_at timestamptz;
BEGIN
 IF TG_OP='UPDATE' AND NEW.login_changed_at IS DISTINCT FROM OLD.login_changed_at THEN
   RAISE EXCEPTION 'Login change time is database managed' USING ERRCODE='42501';
 END IF;
 IF TG_OP='INSERT' AND NEW.login_changed_at IS NOT NULL THEN
   RAISE EXCEPTION 'Initial login change time must be empty' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND NEW.login IS NOT DISTINCT FROM OLD.login THEN RETURN NEW; END IF;
 canonical_name=translate(normalize(NEW.login,NFKC),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
 IF char_length(canonical_name)<3 OR char_length(canonical_name)>80
    OR canonical_name !~ '^[a-z0-9㐀-䶿一-鿿𠀀-𲎯]+([_.@-][a-z0-9㐀-䶿一-鿿𠀀-𲎯]+)*$' THEN
   RAISE EXCEPTION 'Invalid login account' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
   IF canonical_name=OLD.login_key THEN
     RAISE EXCEPTION 'Canonical login did not change' USING ERRCODE='23514';
   END IF;
   changed_at=clock_timestamp();
   IF OLD.login_changed_at IS NOT NULL AND changed_at<OLD.login_changed_at+interval '2160 hours' THEN
     RAISE EXCEPTION 'Login change cooldown is 90 days' USING ERRCODE='23514';
   END IF;
   NEW.login_changed_at=changed_at;
   DELETE FROM auth_session WHERE account_id=OLD.id;
 END IF;
 NEW.login=canonical_name;
 RETURN NEW;
END $$;
CREATE TRIGGER account_login_guard BEFORE INSERT OR UPDATE ON account FOR EACH ROW EXECUTE FUNCTION guard_account_login();
