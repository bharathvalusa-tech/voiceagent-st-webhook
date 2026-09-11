-- servicetrade_tokens — columns that let a ServiceTrade session heal itself.
--
-- Run once in the Supabase SQL editor. Every statement is idempotent, so re-running is safe.
-- No credential value appears in this file; it only adds columns and triggers.
--
-- Why each column exists
--
--   last_modified            When this row last changed. Written by a trigger rather than by
--                            the service, so an edit made by hand in the Supabase table editor
--                            is stamped too — which is the case that matters, because that is
--                            how credentials actually get rotated.
--
--   credentials_fingerprint  SHA-256 of the st_username/st_password pair that minted the
--                            current auth_token. The service recomputes it on every read and
--                            compares. A mismatch means the credentials were edited after the
--                            token was issued, so the token is discarded and a fresh login is
--                            performed — even though the old session would still validate.
--                            A hash, not the password: the column never has to be protected.
--
--   last_auth_status         'valid' | 'healed' | 'failed' | 'no_credentials' | 'credentials_changed'
--   last_auth_checked_at     When the session was last proven against ServiceTrade.
--   last_auth_error          Text of the last failure. Cleared on success.

alter table public.servicetrade_tokens
    add column if not exists last_modified           timestamptz not null default now(),
    add column if not exists credentials_fingerprint text,
    add column if not exists last_auth_status        text,
    add column if not exists last_auth_checked_at    timestamptz,
    add column if not exists last_auth_error         text;

comment on column public.servicetrade_tokens.last_modified is
    'Set by trigger on every UPDATE, including manual table-editor edits.';
comment on column public.servicetrade_tokens.credentials_fingerprint is
    'SHA-256 of "st_username\nst_password" as of the login that minted auth_token. A mismatch forces re-authentication.';

-- Backfill so existing rows have a sensible starting value rather than the migration time
-- for a row nobody has touched in months.
update public.servicetrade_tokens
   set last_modified = coalesce(last_modified, created_at, now())
 where last_modified is null;


-- 1. Stamp last_modified on every update, whoever makes it.
create or replace function public.servicetrade_tokens_stamp_last_modified()
returns trigger
language plpgsql
as $$
begin
    new.last_modified := now();
    return new;
end;
$$;

drop trigger if exists trg_servicetrade_tokens_last_modified on public.servicetrade_tokens;
create trigger trg_servicetrade_tokens_last_modified
    before update on public.servicetrade_tokens
    for each row
    execute function public.servicetrade_tokens_stamp_last_modified();


-- 2. Mark a credential edit so it is visible in the table without reading the fingerprint.
--
--    This trigger deliberately does NOT clear credentials_fingerprint. The stale fingerprint
--    IS the signal: the service recomputes the hash from the new credentials, sees it differ
--    from the stored one, and re-authenticates. Clearing it to null would look identical to
--    "this row has never been fingerprinted", which is the one case that must NOT force a
--    login.
create or replace function public.servicetrade_tokens_mark_credentials_changed()
returns trigger
language plpgsql
as $$
begin
    if new.st_username is distinct from old.st_username
       or new.st_password is distinct from old.st_password then
        new.last_auth_status := 'credentials_changed';
        new.last_auth_error  := null;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_servicetrade_tokens_credentials_changed on public.servicetrade_tokens;
create trigger trg_servicetrade_tokens_credentials_changed
    before update on public.servicetrade_tokens
    for each row
    execute function public.servicetrade_tokens_mark_credentials_changed();


-- Check it applied:
--   select agent_id, "Name", last_auth_status, last_auth_checked_at, last_modified,
--          (credentials_fingerprint is not null) as fingerprinted
--     from public.servicetrade_tokens order by "Name";
--
-- Prove the trigger fires (touches nothing real):
--   update public.servicetrade_tokens set notes = notes where agent_id = '<some agent>';
--   -- last_modified is now.
