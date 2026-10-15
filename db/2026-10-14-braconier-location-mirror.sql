-- Braconier: mirror ServiceTrade locations and companies into Supabase.
--
-- WHY. The after-hours lookup has to answer "which of this company's sites is this?"
-- A caller at DENVER PUBLIC SCHOOLS can name any of 113 addresses, and ServiceTrade
-- holds two separate customer records under that same name. Scoring a spoken address
-- against every site on the account needs those sites locally; the contact search
-- returns only the sites the one matched contact is attached to.
--
-- WHAT THIS FILE DOES. Nothing is created: `public.servicetrade_locations` and
-- `public.servicetrade_companies` already exist and already carry every column needed
-- (street, city, state, postal_code, name, phone_number, status, raw_response).
-- This file verifies Braconier's rows and surfaces the cases the lookup has to handle.
--
-- STATE WHEN THIS RAN, 2026-10-14. Braconier was ALREADY mirrored under
-- `company_id = 630`, but every row was written 2026-06-24 — roughly four months stale.
-- A full refresh brought it to 4,843 locations and 5,612 companies.
--
--   before: 4,707 locations / 5,525 companies, all dated 2026-06-24
--   after:  4,843 locations / 5,612 companies
--
-- So step 2 below is for a tenant that has never been mirrored. Braconier does not need
-- it; keep it for the next one.
--
-- THE ROWS THEMSELVES are written by the Supabase Edge Function
-- `supabase/functions/sync-locations`, which is the only writer. It fetches
-- GET /company and GET /location paged at limit=1000 and upserts on
-- (agent_id, servicetrade_id).
--
-- ⚠️ NO CREDENTIAL VALUES IN THIS FILE. This repository is public and this file is
-- tracked. Braconier's ServiceTrade session and password live in
-- `public.servicetrade_tokens` and are read at runtime by the Edge Function.

-- ---------------------------------------------------------------------------
-- 1. Confirm Braconier has a token row with usable credentials.
--
-- The Edge Function validates the stored session first and only re-authenticates
-- when it has expired, so both st_username and st_password must be present or a
-- dead session cannot heal.
-- ---------------------------------------------------------------------------

select agent_id,
       "Name",
       auth_token is not null                      as has_session,
       st_username is not null                     as has_username,
       st_password is not null                     as has_password,
       last_auth_status,
       last_auth_checked_at
  from public.servicetrade_tokens
 where agent_id = 'agent_41010d0d8c1f46cf1d9dfcddbf';

-- ---------------------------------------------------------------------------
-- 2. Claim a company_id for Braconier.
--
-- `company_id` is NOT NULL on both mirror tables and is NOT ServiceTrade's company
-- id — that arrives per record as `servicetrade_company_id`. It is an internal
-- tenant tag. Nothing reads it except the Edge Function's own deriveTenant(), which
-- is why a brand-new tenant cannot bootstrap itself: it reads the value off rows
-- that do not exist yet.
--
-- Pick the next free integer rather than reusing one. `public.companies` is NOT a
-- usable source — it disagrees with the mirror for 3 of 5 agents.
-- ---------------------------------------------------------------------------

select agent_id,
       min(company_id) as company_id,
       count(*)        as rows
  from public.servicetrade_locations
 group by agent_id
 order by company_id;

-- The value to configure. Record it; step 3 needs it.
select coalesce(max(company_id), 0) + 1 as next_free_company_id
  from public.servicetrade_locations;

-- ---------------------------------------------------------------------------
-- 3. Configure the sync, in BOTH places. They must stay in step.
--
--   a) The Edge Function secret, which is what actually runs:
--
--        supabase secrets set LOCATION_SYNC_AGENT_IDS=\
--          "agent_efbe503faedf1bf516f961979f,agent_41010d0d8c1f46cf1d9dfcddbf:<company_id>"
--
--      The `:<company_id>` suffix is what lets a tenant with no rows bootstrap.
--      Adaptive keeps its bare form and derives its id from its 395 existing rows,
--      exactly as before.
--
--   b) The Node service's own LOCATION_SYNC_AGENT_IDS, so
--      `src/config/environment.js:112` and the function agree about which tenants
--      are mirrored. The Node side only READS the mirror.
--
-- Then seed, once, by hand. `{"full":true}` skips the updatedAfter watermark and
-- fetches everything:
--
--   curl -X POST https://tpvserzjhmyxjssabokm.supabase.co/functions/v1/sync-locations \
--        -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
--        -H "Content-Type: application/json" -d '{"full":true}'
--
-- The hourly pg_cron job (db/supabase-sync-locations-cron.sql) keeps it current
-- afterwards and reconciles in full at 00:00 UTC.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Verify the seed. Run these AFTER the manual function call.
-- ---------------------------------------------------------------------------

-- 4a. Rows landed, and landed recently.
select count(*) as locations,
       max(updated_at) as last_written
  from public.servicetrade_locations
 where agent_id = 'agent_41010d0d8c1f46cf1d9dfcddbf';

select count(*) as companies,
       max(updated_at) as last_written
  from public.servicetrade_companies
 where agent_id = 'agent_41010d0d8c1f46cf1d9dfcddbf';

-- 4b. Addresses are actually populated. A mirror of blank streets matches nothing,
--     and the fuzzy scorer reads street/city/state/postal_code only.
select count(*)                                             as total,
       count(*) filter (where street     <> '')             as with_street,
       count(*) filter (where city       <> '')             as with_city,
       count(*) filter (where postal_code <> '')            as with_postal,
       count(*) filter (where name       <> '')             as with_name
  from public.servicetrade_locations
 where agent_id = 'agent_41010d0d8c1f46cf1d9dfcddbf';

-- 4c. The DENVER PUBLIC SCHOOLS case this whole change exists for: two separate
--     customer records under one name. Expect two rows with different
--     servicetrade_id, and a location count on each.
select c.servicetrade_id as company_id,
       c.name,
       c.status,
       count(l.id)       as locations
  from public.servicetrade_companies c
  left join public.servicetrade_locations l
         on l.agent_id = c.agent_id
        and l.servicetrade_company_id = c.servicetrade_id
 where c.agent_id = 'agent_41010d0d8c1f46cf1d9dfcddbf'
   and c.name ilike '%denver public schools%'
 group by c.servicetrade_id, c.name, c.status
 order by locations desc;

-- 4d. Any company name held by more than one record. These are the accounts where
--     "which company?" is not a question a caller can answer, so the spoken address
--     has to decide instead.
select name,
       count(*)                          as records,
       array_agg(servicetrade_id)        as company_ids
  from public.servicetrade_companies
 where agent_id = 'agent_41010d0d8c1f46cf1d9dfcddbf'
 group by name
having count(*) > 1
 order by records desc, name;

-- 4e. Locations whose company is missing from the mirror. The location upsert
--     filters these out rather than letting one unresolvable foreign key fail the
--     whole batch, so a non-zero count here means sites are being dropped.
--     Measured 2026-10-14: 0.
select count(*) as orphaned
  from public.servicetrade_locations l
 where l.agent_id = 'agent_41010d0d8c1f46cf1d9dfcddbf'
   and l.servicetrade_company_id is not null
   and not exists (
         select 1 from public.servicetrade_companies c
          where c.agent_id = l.agent_id
            and c.servicetrade_id = l.servicetrade_company_id);

-- 4f. Rows the last full sync did not touch — present in the mirror, no longer
--     returned by ServiceTrade. The Edge Function REPORTS these and never deletes
--     them, on purpose: a vanishing location is more often a permissions or paging
--     anomaly than a real deletion, and a job created against a deleted row is
--     unrecoverable (sync-locations/index.ts:447-451).
--
--     They matter here because the lookup scores a spoken address against every
--     mirrored row, so a site that no longer exists can still win a match.
--     Measured 2026-10-14: 9 locations, 4 companies, all still marked active.
--
--     Replace the date with the timestamp of the sync you are checking.
select servicetrade_id, name, street, city, status, updated_at
  from public.servicetrade_locations
 where agent_id = 'agent_41010d0d8c1f46cf1d9dfcddbf'
   and updated_at < date '2026-10-14'
 order by name;
