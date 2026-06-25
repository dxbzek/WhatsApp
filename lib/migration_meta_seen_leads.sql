-- Dedupe ledger for the meta-leads cron (direct Graph API poll, no Zapier).
-- One row per leadgen_id ever processed, so each Meta Instant-Form lead is
-- routed exactly once even though the cron re-scans recent leads every run.
-- Run once in the Supabase SQL editor for the WhatsApp project.

create table if not exists meta_seen_leads (
  leadgen_id text primary key,         -- Meta leadgen_id (the dedupe key)
  name       text,                     -- captured for at-a-glance debugging
  status     text,                     -- routed | no_route | ... | ingest error
  created_at timestamptz not null default now()
);

-- On first deploy, seed this with every EXISTING lead id so the cron does not
-- re-alert leads that came in before it went live (the app does this seeding
-- programmatically; this comment documents the intent).
