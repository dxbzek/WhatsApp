-- Normalized phone keys for robust WhatsApp <-> CRM matching.
--
-- Problem: the inbox marks warm repliers "Not in Audience CRM yet" because the
-- old lookup exact-matched a handful of format variants against the indexed
-- `phone` column only. It missed (a) numbers stored with spaces/dashes and
-- (b) numbers held in the secondary `phone2` field.
--
-- Fix: a format-proof key = the subscriber's LAST 9 DIGITS of each phone field,
-- indexed so PostgREST can match it fast. "+971 50 123 4567", "0501234567",
-- "971501234567" and ".0501234567" all reduce to "501234567".
--
-- Run this ONCE on the ERE contacts (CRM) Supabase. The 9.48M-row table means
-- you must NOT do it in one giant transaction (role timeout / rollback). Follow
-- the batched steps below — this matches the existing bulk-ops playbook.

-- 1) Add the columns (instant — plain nullable text, no table rewrite).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_norm  text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone2_norm text;

-- 2) Backfill in ID-range batches so no single UPDATE exceeds the role timeout.
--    Repeat, advancing the id window, until no rows remain (or script it).
--    Example window — adjust the range/size to your id distribution:
--
--    UPDATE contacts
--       SET phone_norm  = NULLIF(right(regexp_replace(coalesce(phone,''),  '[^0-9]', '', 'g'), 9), ''),
--           phone2_norm = NULLIF(right(regexp_replace(coalesce(phone2,''), '[^0-9]', '', 'g'), 9), '')
--     WHERE id >= 0 AND id < 500000
--       AND phone_norm IS NULL;            -- idempotent: re-runs skip done rows
--
--    ...then 500000–1000000, 1000000–1500000, and so on.

-- 3) Index both keys CONCURRENTLY (no write-lock; run each on its own, outside a txn).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_phone_norm  ON contacts (phone_norm);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_phone2_norm ON contacts (phone2_norm);

-- 4) (Optional) keep them fresh on future writes so new contacts match too:
--    CREATE OR REPLACE FUNCTION contacts_phone_norm() RETURNS trigger AS $$
--    BEGIN
--      NEW.phone_norm  := NULLIF(right(regexp_replace(coalesce(NEW.phone,''),  '[^0-9]', '', 'g'), 9), '');
--      NEW.phone2_norm := NULLIF(right(regexp_replace(coalesce(NEW.phone2,''), '[^0-9]', '', 'g'), 9), '');
--      RETURN NEW;
--    END $$ LANGUAGE plpgsql;
--    CREATE TRIGGER trg_contacts_phone_norm BEFORE INSERT OR UPDATE OF phone, phone2
--      ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_phone_norm();
--
-- Once the columns + indexes exist, lib/crm.ts crmContactByPhone() uses them
-- automatically (it falls back to the old variant match until then).
