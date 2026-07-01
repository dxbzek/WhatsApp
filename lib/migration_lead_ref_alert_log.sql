-- Lead ID correlation for agent status reports.
-- Run once in the Supabase SQL editor for the WhatsApp project.
--
-- Problem this solves: when an agent taps a quick-reply status button on a lead
-- alert (e.g. "Contacted"), the inbound body is just the button title with NO
-- phone/lead reference. Before this, handleAgentReport fell back to the agent's
-- NEWEST open lead — wrong when the agent is working several leads at once.
--
-- Two pieces:
--   1. conversations.lead_ref — a short, human, unique handle for each lead
--      (format: 'L' + 6 base36 chars, e.g. L3f9k2a) that we can print in alerts
--      and that an agent can text back to target a specific lead.
--   2. agent_alert_log — one row per alert we send to an agent, so a button tap
--      (which carries no lead reference) can be correlated to the exact lead the
--      agent was most recently alerted about.

-- 1. Short human lead reference -------------------------------------------------
alter table conversations add column if not exists lead_ref text;

-- Backfill existing rows with a unique 'L' + 6 base36 ref. Loops until every row
-- has one; the unique index below guarantees no collisions slip through.
do $$
declare
  r record;
  candidate text;
begin
  for r in select id from conversations where lead_ref is null loop
    loop
      -- 'L' + 6 chars of base36 drawn from a random bigint. md5->bigint keeps it
      -- dependency-free (no pgcrypto needed for the backfill itself).
      candidate := 'L' || lower(substr(
        replace(replace(replace(encode(decode(md5(random()::text || r.id::text), 'hex'), 'base64'), '/', ''), '+', ''), '=', ''),
        1, 6));
      begin
        update conversations set lead_ref = candidate where id = r.id;
        exit; -- success
      exception when unique_violation then
        -- extremely rare; try a new candidate
        null;
      end;
    end loop;
  end loop;
end $$;

-- Unique so a lead_ref always points at exactly one lead. Partial-safe: existing
-- nulls were backfilled above; new rows get a ref from the app (lib/leadRef.ts).
create unique index if not exists uq_conversations_lead_ref on conversations(lead_ref);

-- 2. Per-alert log for button-tap correlation ----------------------------------
create table if not exists agent_alert_log (
  id                 uuid primary key default gen_random_uuid(),
  agent_id           uuid,                                   -- agents.id (may be null if unknown)
  agent_wa           text,                                   -- the WhatsApp number we sent the alert to
  conversation_id    uuid references conversations(id) on delete cascade,
  alert_message_sid  text,                                   -- Twilio message SID of the alert (if returned)
  sent_at            timestamptz not null default now()
);

-- Lookup: "most recent alert sent to THIS agent number" — the button-tap match.
create index if not exists idx_agent_alert_log_wa_sent on agent_alert_log(agent_wa, sent_at desc);
