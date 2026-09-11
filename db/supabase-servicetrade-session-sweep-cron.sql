-- Schedule the ServiceTrade session sweep hourly, from Supabase rather than from Vercel.
--
-- Why here and not vercel.json: the Vercel project is on the Hobby plan, which refuses any
-- cron running more than once a day —
--     "This cron expression (0 * * * *) would run more than once per day.
--      Upgrade to the Pro plan to unlock all Cron Jobs features."
-- pg_cron has no such limit, and this repository already drives sync-locations the same way
-- (db/supabase-sync-locations-cron.sql). One scheduler, one place to look.
--
-- pg_cron and pg_net are already enabled on this project.
--
-- ⚠️ DO NOT PUT THE SECRET IN THIS FILE. This repository is public and this file is tracked.
-- Run the set_config line below on its own in the SAME SQL editor session first, then run the
-- rest. The value lives in that session and in Vault, never on disk.
--
-- Step 0 — paste this alone, with the CRON_SECRET you set on the Vercel project, and do not
-- save it:
--
--     select set_config('app.st_sweep_cron_secret', 'PASTE_SECRET_HERE_IN_THE_EDITOR_ONLY', false);
--
-- It must be the SAME string as the Vercel env var CRON_SECRET. The endpoint compares them and
-- returns 401 on a mismatch, 503 when Vercel has no CRON_SECRET set at all.
--
-- Then run everything below.

-- 1. Copy the session value into Vault, so the scheduled job keeps it.
--    Vault and not the job body: cron.job.command is readable by anyone who can query that
--    table, and this secret authorises re-issuing every tenant's ServiceTrade login.
--
--    Read via current_setting, not a psql :'variable' — psql does not substitute variables
--    inside a dollar-quoted body, so an interpolated secret would land as literal text.
do $$
declare
    v_secret text := current_setting('app.st_sweep_cron_secret', true);
    v_id     uuid;
begin
    if v_secret is null or v_secret = '' or v_secret like 'PASTE%' then
        raise exception
            'Run this first, in this session: select set_config(''app.st_sweep_cron_secret'', ''<your CRON_SECRET>'', false);';
    end if;
    select id into v_id from vault.secrets where name = 'st_sweep_cron_secret';
    if v_id is null then
        perform vault.create_secret(v_secret, 'st_sweep_cron_secret', 'pg_cron -> voiceagent-st-webhook /auth/servicetrade/refresh-all');
    else
        perform vault.update_secret(v_id, v_secret);
    end if;
end $$;

-- 2. The job. Body is '{}' on purpose — the endpoint takes no parameters; it walks every row
--    of servicetrade_tokens itself.
--
--    Hourly. The sweep is the BACKSTOP, not the mechanism: a tenant taking calls already heals
--    inline on its next ServiceTrade request (resolveSession in
--    src/controllers/serviceTradeController.js). This exists for tenants that go a long time
--    without one, so an expired session is never discovered by a caller.
--
--    Cost per run, measured on the live account across 8 tenants: one 20.7 KB Supabase read,
--    8 × 1.4 KB GET /api/auth, 5 × 2.1 KB GET /location?limit=1, and a POST /api/auth only for
--    the sessions that actually died. ~42 KB, nearly all of it inbound to the function.
--
--    timeout_milliseconds is 120000, not the 30000 used by sync-locations: this walks every
--    tenant in sequence and each one can involve three round trips to ServiceTrade.
select cron.unschedule('servicetrade-session-sweep')
where exists (select 1 from cron.job where jobname = 'servicetrade-session-sweep');

select cron.schedule(
    'servicetrade-session-sweep',
    '0 * * * *',
    $job$
    select net.http_post(
        url     := 'https://voiceagent-st-webhook.vercel.app/auth/servicetrade/refresh-all',
        headers := jsonb_build_object(
                       'Content-Type',  'application/json',
                       'Authorization', 'Bearer ' || (
                           select decrypted_secret from vault.decrypted_secrets
                           where name = 'st_sweep_cron_secret')),
        body                 := '{}'::jsonb,
        timeout_milliseconds := 120000
    );
    $job$
);

select jobid, jobname, schedule, active from cron.job
where jobname = 'servicetrade-session-sweep';


-- Verifying it works.
--
-- cron.job_run_details will say "succeeded" even when the endpoint 401s or 500s —
-- net.http_post returns as soon as the request is QUEUED, not when it completes. So check the
-- data, not the job:
--
--   select "Name", last_auth_status, last_auth_checked_at, last_auth_error
--     from public.servicetrade_tokens order by last_auth_checked_at desc nulls last;
--
-- last_auth_checked_at within the hour means the sweep ran and reached ServiceTrade. This
-- requires db/servicetrade_tokens_session_health.sql to have been run first — without those
-- columns the sweep still works, but it records nothing and there is nothing here to read.
--
-- To see the actual HTTP status pg_net got back:
--
--   select id, status_code, content::text
--     from net._http_response order by created desc limit 5;
--
--   401 -> the Vault secret and the Vercel CRON_SECRET do not match
--   503 -> CRON_SECRET is not set on the Vercel project at all
--   200 -> read `content` for the per-tenant results
--
-- Run it once by hand, without waiting for the hour:
--   select net.http_post(
--       url     := 'https://voiceagent-st-webhook.vercel.app/auth/servicetrade/refresh-all',
--       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
--                      (select decrypted_secret from vault.decrypted_secrets where name = 'st_sweep_cron_secret')),
--       body := '{}'::jsonb, timeout_milliseconds := 120000);
--
-- Stop it: select cron.unschedule('servicetrade-session-sweep');
