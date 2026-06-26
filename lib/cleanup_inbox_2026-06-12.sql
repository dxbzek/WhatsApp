-- One-time inbox cleanup (2026-06-12)
-- Run in the Supabase SQL editor for the WhatsApp app's project.
-- Safe to run more than once (idempotent). Wrapped in a transaction:
-- check the preview counts, then COMMIT (or ROLLBACK to back out).

begin;

-- 1) PREVIEW: phantom unreads — blocked/invalid contacts (e.g. replied STOP)
--    still carrying unread = true. These inflate the nav badge.
select count(*) as phantom_unreads_to_clear
from conversations
where unread = true
  and status in ('blocked', 'invalid');

-- 2) PREVIEW: past inbound replies that signalled interest but were never
--    tagged hot. (Excludes opted-out/invalid and "not interested" etc.)
select count(*) as leads_to_mark_hot
from conversations c
where coalesce(c.status, 'open') not in ('blocked', 'invalid')
  and coalesce(c.lead_status, '') <> 'hot'
  and exists (
    select 1 from messages m
    where m.conversation = c.id
      and m.direction = 'in'
      and m.body ~* '\y(interested|yes|tell me more|more info|more details|send me details|send details)\y'
      and m.body !~* '\y(not interested|no|wrong number|remove|stop)\y'
  );

-- 3) FIX: clear the stuck unread flags so the badge matches the inbox.
update conversations
set unread = false
where unread = true
  and status in ('blocked', 'invalid');

-- 4) FIX: backfill "hot" on past interested replies so they surface in the
--    inbox Hot tab. Only upgrades — never downgrades a manual status.
update conversations c
set lead_status = 'hot'
where coalesce(c.status, 'open') not in ('blocked', 'invalid')
  and coalesce(c.lead_status, '') <> 'hot'
  and exists (
    select 1 from messages m
    where m.conversation = c.id
      and m.direction = 'in'
      and m.body ~* '\y(interested|yes|tell me more|more info|more details|send me details|send details)\y'
      and m.body !~* '\y(not interested|no|wrong number|remove|stop)\y'
  );

-- If the preview counts looked right and the UPDATEs reported sane row counts:
commit;
-- Otherwise: rollback;
