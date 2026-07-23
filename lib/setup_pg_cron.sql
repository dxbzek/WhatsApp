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

-- Every minute, POST the dispatcher. x-vercel-protection-bypass clears
-- Vercel's edge protection; x-cron-secret is OUR auth inside the route.
--
-- Every minute, not every 5: the cadence is only how often we LOOK for due
-- messages, never how fast they go out — pacing comes from each row's
-- scheduled_at plus the 60-per-run claim cap. At 5 min a batch could sit idle
-- for 5 minutes after it was due, which reads as a stalled campaign.
select cron.schedule(
  'whatsapp-drip-dispatch',
  '* * * * *',
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
