-- Schedule the proactive quality watch (2026-07-13). Run once in the WhatsApp
-- app's Supabase SQL editor, AFTER the app with app/api/cron/quality-watch is
-- deployed. Same placeholders and auth pattern as setup_pg_cron.sql — replace:
--   <APP_URL>      the production *.vercel.app URL
--   <CRON_SECRET>  the CRON_SECRET env var value on Vercel
--   <BYPASS>       the VERCEL_AUTOMATION_BYPASS_SECRET value
--
-- Runs hourly. It measures per-sender delivery% and marketing-throttle (63049)%
-- over the last 24h and auto-pauses a sender in send_guard BEFORE Meta locks it.
-- It only ADDS pauses; a human clears them from the sender-health panel.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'whatsapp-quality-watch',
  '17 * * * *',            -- hourly, offset off the :00 dispatch tick
  $$
  select net.http_post(
    url     := '<APP_URL>/api/cron/quality-watch',
    headers := jsonb_build_object(
      'x-cron-secret', '<CRON_SECRET>',
      'x-vercel-protection-bypass', '<BYPASS>'
    ),
    timeout_milliseconds := 55000
  );
  $$
);

-- Management:
--   select * from cron.job where jobname = 'whatsapp-quality-watch';
--   select cron.unschedule('whatsapp-quality-watch');
