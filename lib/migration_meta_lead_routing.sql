-- Meta ad lead routing (Instant Lead Form -> console -> per-listing round-robin)
-- Run once in the Supabase SQL editor for the WhatsApp project.
--
-- What it adds:
--   1. Source/attribution columns on conversations so the inbox shows a lead came
--      from a Meta ad and which listing it was.
--   2. A lead_routes table: one row per listing/ad ref code, holding the agent pool
--      that catches that listing's ad leads and a round-robin pointer.

-- 1. Where did this conversation come from? (null for normal inbound)
alter table conversations
  add column if not exists source        text,  -- e.g. meta_lead_form
  add column if not exists source_ref    text,  -- listing ref matched, e.g. CAYAN-BH
  add column if not exists source_detail text;  -- ad / campaign / form name, for context

-- 2. Per-listing routing pools for inbound ad leads. The Meta lead webhook resolves
--    a route by ref (or by a ref token found in the ad/campaign/form name), then
--    round-robins across its active agents (or notifies all when distribution='all').
create table if not exists lead_routes (
  ref          text primary key,                          -- match key, compared case-insensitively
  label        text,                                      -- human label, shown in the agent alert
  agent_ids    uuid[] not null default '{}',              -- references agents(id), order preserved
  distribution text not null default 'round_robin',       -- round_robin | all
  rr_pointer   int  not null default 0,                   -- next-agent cursor (round_robin)
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Example: route Barsha Heights (Cayan) office ad leads to two agents, round-robin.
-- Replace the UUIDs with real agents.id values, then put "CAYAN-BH" in the ad's
-- hidden ref field (or name the form/ad so it contains CAYAN-BH).
--
-- insert into lead_routes (ref, label, agent_ids, distribution) values
--   ('CAYAN-BH', 'Cayan Business Center office for rent',
--    array['<agent-uuid-1>','<agent-uuid-2>']::uuid[], 'round_robin')
-- on conflict (ref) do update set
--   label = excluded.label, agent_ids = excluded.agent_ids,
--   distribution = excluded.distribution, active = true;
