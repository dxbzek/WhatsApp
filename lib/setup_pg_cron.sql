-- Schedule the drip dispatcher (2026-06-12). Run once in the WhatsApp app's
-- Supabase SQL editor, AFTER migration_server_drip.sql and AFTER CRON_SECRET is
-- set on Vercel and the app is deployed.
--
-- There is NO custom domain, so the app is on a *.vercel.app URL behind Vercel
-- Deployment Protection. We clear it with the protection-bypass secret passed as
-- a HEADER (the ?x-vercel-set-bypass-cookie query form 307-redirects, and pg_net
-- does not follow redirects). Replace THREE placeholders below:
--   <APP_URL>   the production *.vercel.app URL, e.g. https://whatsapp-xyz.vercel.app
--   <CRON_SECRET>   the value set for the CRON_SECRET env var on Vercel
--   <BYPASS>    Vercel → Settings → Deployment Protection → "Protection Bypass
--               for Automation" secret (the VERCEL_AUTOMATION_BYPASS_SECRET env var)

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Every 5 minutes, POST the dispatcher. x-vercel-protection-bypass clears
-- Vercel's edge protection; x-cron-secret is OUR auth inside the route.
select cron.schedule(
  'whatsapp-drip-dispatch',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := '<APP_URL>/api/cron/dispatch',
    headers := jsonb_build_object(
      'x-cron-secret', '<CRON_SECRET>',
      'x-vercel-protection-bypass', '<BYPASS>'
    ),
    timeout_milliseconds := 55000
  );
  $$
);

-- Useful management commands:
--   select * from cron.job;                                  -- list jobs
--   select * from cron.job_run_details order by start_time desc limit 20;  -- recent runs
--   select cron.unschedule('whatsapp-drip-dispatch');        -- stop it
