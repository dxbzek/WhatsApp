-- Database linter fixes (2026-07-07). Already applied to prod.
-- WhatsApp Supabase project: kvmkwxyjyrpergqojmgr. Run ONCE. Idempotent.
--
-- Fixes two findings from the Supabase database linter:
--   1. rls_disabled_in_public (ERROR) — public.ad_creatives had no RLS, so the
--      anon/authenticated PostgREST roles could read/write it directly. It's a
--      service_role-only cache table (see lib/adCreatives.ts), so this follows
--      the same "RLS on, no policies" console convention as every other table.
--   2. extension_in_public (WARN) — pg_net was installed in the public schema.
--      pg_net is NOT relocatable (`alter extension ... set schema` errors with
--      "does not support SET SCHEMA"), so the fix is drop + recreate targeting
--      the `extensions` schema already used for pgcrypto / uuid-ossp /
--      pg_stat_statements — same pattern Supabase documents for non-relocatable
--      extensions like PostGIS. Nothing else in the DB depends on the pg_net
--      extension itself (checked pg_depend — only its own internal members),
--      and its functions are recreated under the separate `net` schema as
--      before, so existing net.http_post() calls (lib/setup_pg_cron.sql) keep
--      working unchanged.
--
-- The remaining rls_enabled_no_policy (INFO) findings are expected: every
-- public table intentionally has RLS enabled with no policies, so all access
-- goes through service_role in the /api routes (see migration_bugfixes.sql).

alter table public.ad_creatives enable row level security;

drop extension if exists pg_net;
create extension if not exists pg_net schema extensions;
