-- Circuit-breaker for the send flow (2026-07-01).
-- WhatsApp Supabase project: kvmkwxyjyrpergqojmgr. Run ONCE. Idempotent.
--
-- WHY: the old number was banned after ~2,400 "63051 number LOCKED" + 2,728 "63049
-- throttle" errors over three weeks — the automation kept sending straight into the
-- penalties instead of stopping. This table is the brake: when a sender hits a real
-- penalty code (63051 locked / 90010 rate-limit) the status callback pauses THAT
-- sender, and the dispatcher skips any message on a paused sender until it clears.
--
-- NOTE: we deliberately do NOT trip on 63049 (marketing throttle). At volume it is
-- expected noise (a 20k-send campaign can log thousands of 63049s), so halting on it
-- would kill legitimate sending. 63051 (the number itself being locked) is the true
-- pre-ban signal, so a single 63051 pauses the sender for a human to investigate.

create table if not exists send_guard (
  sender        text primary key,        -- bare WhatsApp sender digits, e.g. 16592207300
  paused_until  timestamptz,             -- sends on this sender are held until this time
  reason        text,
  updated_at    timestamptz not null default now()
);

-- Console convention: RLS on, no policies — all access via service_role (/api routes).
alter table send_guard enable row level security;
