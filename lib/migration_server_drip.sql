-- Server-side drip queue (2026-06-12). Run once in the WhatsApp app's Supabase
-- SQL editor. Reuses the existing `messages` table as the queue: a drip writes
-- status='scheduled' rows with a scheduled_at, and /api/cron/dispatch sends each
-- when due. No new table needed — the campaign log already understands
-- "scheduled" messages.

-- Columns the queue/dispatcher rely on (idempotent).
alter table messages add column if not exists scheduled_at timestamptz;
alter table messages add column if not exists content_vars jsonb;

-- Hot path for the dispatcher: "give me the next due scheduled messages".
create index if not exists idx_messages_due
  on messages (scheduled_at)
  where status = 'scheduled';
