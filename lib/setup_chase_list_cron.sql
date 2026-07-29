-- Daily chase list at 09:00 Dubai (2026-07-29).
--
-- Run once in the WhatsApp app's Supabase SQL editor, AFTER the app is deployed and
-- CHASE_LIST_TO is set on Vercel. Replace THREE placeholders:
--   <APP_URL>       production *.vercel.app URL, e.g. https://whatsapp-xyz.vercel.app
--   <CRON_SECRET>   the CRON_SECRET env var value on Vercel
--   <BYPASS>        Vercel -> Settings -> Deployment Protection -> Protection Bypass
--                   for Automation (the VERCEL_AUTOMATION_BYPASS_SECRET value)
--
-- pg_cron runs in UTC, so 05:00 UTC = 09:00 Asia/Dubai. Dubai does not observe DST,
-- so this stays correct year round — do NOT "fix" it seasonally.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ere-chase-list',
  '0 5 * * *',
  $$
  select net.http_post(
    url     := '<APP_URL>/api/cron/chase-list',
    headers := jsonb_build_object(
      'x-cron-secret', '<CRON_SECRET>',
      'x-vercel-protection-bypass', '<BYPASS>'
    ),
    timeout_milliseconds := 55000
  );
  $$
);

-- Check it before trusting it (returns the rows, sends no email):
--   <APP_URL>/api/cron/chase-list?key=<CRON_SECRET>&dry=1
--
-- Management:
--   select * from cron.job where jobname = 'ere-chase-list';
--   select * from cron.job_run_details order by start_time desc limit 20;
--   select cron.unschedule('ere-chase-list');
