-- Schedule sync-locations hourly. Replace the key on line 8, run the file.
-- pg_cron and pg_net are already enabled on this project.

-- 1. Store the service_role key (Settings -> API) in Vault, not in the job body:
--    cron.job.command is readable by anyone who can query that table.
do $$
declare
    v_key text := 'PASTE_SERVICE_ROLE_KEY_HERE';
    v_id  uuid;
begin
    if v_key like 'PASTE%' then
        raise exception 'Replace PASTE_SERVICE_ROLE_KEY_HERE with the service_role key';
    end if;
    select id into v_id from vault.secrets where name = 'service_role_key';
    if v_id is null then
        perform vault.create_secret(v_key, 'service_role_key', 'pg_cron -> Edge Functions');
    else
        perform vault.update_secret(v_id, v_key);
    end if;
end $$;

-- 2. The job. Body is '{}' on purpose: the function reconciles in full at 00:00
--    UTC and runs incremental the other 23 hours, because ServiceTrade's
--    updatedAfter filter cannot report a hard-deleted location.
select cron.unschedule('sync-servicetrade-locations')
where exists (select 1 from cron.job where jobname = 'sync-servicetrade-locations');

select cron.schedule(
    'sync-servicetrade-locations',
    '0 * * * *',
    $job$
    select net.http_post(
        url     := 'https://tpvserzjhmyxjssabokm.supabase.co/functions/v1/sync-locations',
        headers := jsonb_build_object(
                       'Content-Type',  'application/json',
                       'Authorization', 'Bearer ' || (
                           select decrypted_secret from vault.decrypted_secrets
                           where name = 'service_role_key')),
        body                 := '{}'::jsonb,
        timeout_milliseconds := 30000
    );
    $job$
);

select jobid, jobname, schedule, active from cron.job
where jobname = 'sync-servicetrade-locations';


-- Verifying it works. cron.job_run_details will say "succeeded" even when the
-- function 500s -- net.http_post returns as soon as the request is queued -- so
-- check the data, not the job:
--   select count(*), max(updated_at) from public.servicetrade_locations
--   where agent_id = 'agent_efbe503faedf1bf516f961979f';   -- 395 rows, written within the hour
--
-- Per-run counts: Dashboard -> Edge Functions -> sync-locations -> Logs.
-- Stop it: select cron.unschedule('sync-servicetrade-locations');
