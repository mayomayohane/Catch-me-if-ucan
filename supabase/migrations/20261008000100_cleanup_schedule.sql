-- Hourly cleanup: pg_cron calls the `cleanup` Edge Function (supabase/functions/cleanup),
-- which removes rooms idle for 24 h together with their selfie files in Storage.
-- Files must be removed through the Storage API, which is why this is an Edge Function
-- rather than plain SQL.
--
-- The bearer token is the project's public anon key (already shipped in the web app);
-- the function only touches rooms past retention, so early calls are harmless.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'drokei-cleanup',
  '17 * * * *',
  $$
  select net.http_post(
    url := 'https://ylsnqgihqulrptgsqkas.supabase.co/functions/v1/cleanup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlsc25xZ2locXVscnB0Z3Nxa2FzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzOTM0MDYsImV4cCI6MjEwNjk2OTQwNn0.SZUddi5wu84YV1-4QFAdGYWt37GSYXK3t_dFsMBSOvU'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
