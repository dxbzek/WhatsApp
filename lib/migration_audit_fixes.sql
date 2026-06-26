-- Audit fixes (2026-06-12): performance indexes + aggregate RPCs.
-- Run once in the WhatsApp app's Supabase SQL editor. The app already falls back
-- to its old row-paging if the RPCs don't exist, so it's safe to deploy code
-- first and run this whenever — it just makes the heavy routes fast.

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Status callbacks + inbound dedupe + dispatcher all look up by twilio_sid.
-- Partial (non-null) keeps it small (scheduled/queued drip rows have null sid).
create index concurrently if not exists idx_messages_twilio_sid
  on messages (twilio_sid) where twilio_sid is not null;

-- insights / template-performance / repliedIds / outCount all filter on
-- direction (+ a created_at window).
create index concurrently if not exists idx_messages_dir_created
  on messages (direction, created_at);

-- Unread badge, polled every 15s.
create index concurrently if not exists idx_conversations_unread
  on conversations (unread) where unread = true;

-- ── Aggregate RPCs (replace Node row-paging) ───────────────────────────────
-- Per-campaign delivery funnel: one grouped query instead of streaming every
-- outbound message into the function on each 20s poll.
create or replace function campaign_funnel()
returns table(campaign uuid, status text, error_code text, n bigint)
language sql stable as $$
  select campaign, status, error_code, count(*)::bigint
  from messages
  where campaign is not null and direction = 'out'
  group by campaign, status, error_code
$$;

-- Status counts for a specific set of campaigns (used by /campaign/refresh).
create or replace function campaign_status_counts(ids uuid[])
returns table(campaign uuid, status text, n bigint)
language sql stable as $$
  select campaign, status, count(*)::bigint
  from messages
  where campaign = any(ids)
  group by campaign, status
$$;

grant execute on function campaign_funnel() to service_role;
grant execute on function campaign_status_counts(uuid[]) to service_role;
