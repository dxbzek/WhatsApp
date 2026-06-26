-- Meta ad lead TRACKING (so no lead falls through unnoticed).
-- Run once in the Supabase SQL editor for the WhatsApp project, after
-- migration_meta_lead_routing.sql.
--
-- Adds: a denormalised routing outcome on conversations (for the inbox), and a
-- permanent append-only lead_events log (the audit trail / report source).

-- 1. At-a-glance outcome on the conversation itself.
alter table conversations
  add column if not exists assigned_agent text,   -- agent the lead was routed to
  add column if not exists routing_status text;   -- routed | no_route | no_active_agents | alert_failed | error

-- 2. Permanent per-lead log. One row per inbound Meta lead, never overwritten,
--    so you can always answer "did this lead reach an agent?".
create table if not exists lead_events (
  id             uuid primary key default gen_random_uuid(),
  conversation   uuid references conversations(id) on delete set null,
  wa_phone       text,
  name           text,
  ref            text,                              -- matched listing ref, e.g. CAYAN-BH
  detail         text,                              -- ad / campaign / form name
  routing_status text,                              -- routed | no_route | no_active_agents | alert_failed | error
  assigned_agent text,                              -- agent name pinged (null if unrouted)
  alert_status   text,                              -- sent | fallback | none
  created_at     timestamptz not null default now()
);
create index if not exists idx_lead_events_created_at on lead_events(created_at desc);

-- Tracking query — recent leads and whether each reached an agent:
--   select created_at, name, wa_phone, ref, routing_status, assigned_agent, alert_status
--   from lead_events order by created_at desc limit 100;
--
-- Leads that did NOT cleanly reach an agent (chase these):
--   select * from lead_events
--   where routing_status <> 'routed' or alert_status <> 'sent'
--   order by created_at desc;
