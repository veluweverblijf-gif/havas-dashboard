-- Dagelijkse back-up om 01:48 (Nederlandse tijd ≈ 23:48 UTC in de zomer, 00:48 in de winter).
-- Vervang eerst de twee waarden tussen < > en draai dit daarna in de SQL Editor.
--   <PROJECT-REF>     staat in je Supabase-URL: https://<PROJECT-REF>.supabase.co
--   <BACKUP_SECRET>   dezelfde tekst als het geheim BACKUP_SECRET van de functie
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('havas-backup') where exists (select 1 from cron.job where jobname = 'havas-backup');
select cron.schedule(
  'havas-backup',
  '48 23 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT-REF>.supabase.co/functions/v1/backup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-secret', '<BACKUP_SECRET>'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
