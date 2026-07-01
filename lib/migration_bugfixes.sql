-- Console bug-fix migration (2026-07-01).
-- WhatsApp Supabase project id: kvmkwxyjyrpergqojmgr
-- Run ONCE in that project's SQL editor. DO NOT run automatically.
-- Every statement is idempotent/safe to re-run.
--
-- Covers four fixes:
--   1. Atomic round-robin pointer RPCs (campaigns + lead_routes) — kills the
--      read-modify-write race that let two concurrent leads get the same agent.
--   2. UNIQUE partial index on messages.twilio_sid — makes inbound idempotency a
--      DB guarantee (a duplicate insert now errors instead of double-processing).
--   3. Advisory-lock helper so only ONE /api/cron/dispatch run executes at a time
--      (per-run pacing was not enforced across overlapping cron invocations).

-- ── 1. Atomic round-robin pointers ─────────────────────────────────────────────
-- Before: distribution.ts read rr_pointer in JS, added 1, wrote it back. Two
-- inbound leads racing through this window both read the same value and picked
-- the same agent (and clobbered each other's write). Doing the increment inside a
-- single UPDATE ... RETURNING makes it atomic under Postgres row locking, so every
-- caller gets a distinct, monotonically increasing pointer.
create or replace function next_campaign_rr_pointer(p_id uuid)
returns int
language sql
as $$
  update campaigns
     set rr_pointer = coalesce(rr_pointer, 0) + 1
   where id = p_id
  returning rr_pointer;
$$;

-- lead_routes is keyed by `ref` (its primary key — there is no `id` column), so
-- the route pointer function takes the ref. Same atomic UPDATE ... RETURNING.
create or replace function next_route_rr_pointer(p_ref text)
returns int
language sql
as $$
  update lead_routes
     set rr_pointer = coalesce(rr_pointer, 0) + 1
   where ref = p_ref
  returning rr_pointer;
$$;

grant execute on function next_campaign_rr_pointer(uuid) to service_role;
grant execute on function next_route_rr_pointer(text) to service_role;

-- ── 2. UNIQUE partial index on messages.twilio_sid (inbound idempotency) ────────
-- Before: idx_messages_twilio_sid was a NON-unique partial index, so a Twilio
-- retry of the same inbound webhook could insert a second messages row with the
-- same MessageSid and re-fire the auto-reply / lead distribution. A UNIQUE index
-- turns the second insert into a unique-violation the inbound route now catches
-- and treats as a duplicate (ack + stop).
--
-- Step A: de-duplicate any existing rows, keeping the lowest id per non-null SID,
-- so the unique index can be built.
delete from messages a
using messages b
where a.twilio_sid is not null
  and a.twilio_sid = b.twilio_sid
  and a.id > b.id;

-- Step B: replace the non-unique index with a UNIQUE partial one (null SIDs — the
-- scheduled/queued drip rows — are exempt, so many nulls stay allowed).
drop index if exists idx_messages_twilio_sid;
create unique index if not exists idx_messages_twilio_sid
  on messages (twilio_sid) where twilio_sid is not null;

-- ── 3. Dispatch single-flight lease ─────────────────────────────────────────────
-- Before: the dispatcher's per-run CAP (25) + 250ms throttle only paced a single
-- invocation. If two cron runs overlapped (a slow run still going when the next
-- fires), the global send rate doubled.
-- NOTE: we deliberately do NOT use pg_advisory_lock here. Advisory locks are
-- session-scoped, but Supabase/PostgREST runs each RPC on a pooled connection, so
-- the lock taken in try_dispatch_lock() would be released (or stranded) before the
-- dispatch work and the later release_dispatch_lock() runs on a different session —
-- giving false pacing OR a permanently stuck lock. Instead we use a single-row TTL
-- lease: a run "wins" only if the lease is free or expired, and it auto-heals after
-- the TTL if a run crashes without releasing.
create table if not exists dispatch_lock (
  id           int primary key default 1,
  locked_until timestamptz,
  constraint dispatch_lock_singleton check (id = 1)
);
insert into dispatch_lock (id, locked_until) values (1, null)
  on conflict (id) do nothing;

-- Returns true if this caller acquired the lease (lease was free or expired), else
-- false. TTL of 2 minutes bounds how long a crashed run can block the next one.
create or replace function try_dispatch_lock()
returns boolean
language plpgsql
as $$
declare got boolean;
begin
  update dispatch_lock
     set locked_until = now() + interval '2 minutes'
   where id = 1
     and (locked_until is null or locked_until < now())
  returning true into got;
  return coalesce(got, false);
end;
$$;

create or replace function release_dispatch_lock()
returns boolean
language sql
as $$
  update dispatch_lock set locked_until = null where id = 1 returning true;
$$;

grant execute on function try_dispatch_lock() to service_role;
grant execute on function release_dispatch_lock() to service_role;

-- ── 4. RLS lockdown for the new tables ──────────────────────────────────────────
-- Console convention (see project_whatsapp_rls_lockdown): every public table has
-- RLS ENABLED with NO policies, so anon/authenticated (PostgREST) get nothing and
-- all access goes through service_role in the /api routes + RPCs (which bypass RLS).
-- Without this the Supabase linter flags rls_disabled_in_public (ERROR) and the
-- anon key could read/write these tables directly.
alter table public.agent_alert_log enable row level security;
alter table public.dispatch_lock  enable row level security;
