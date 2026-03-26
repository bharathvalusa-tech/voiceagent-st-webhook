alter table public.servicetrade_tokens
    add column if not exists send_job_email boolean not null default false,
    add column if not exists send_job_fail_email boolean not null default false,
    add column if not exists emailto text,
    add column if not exists ccmail text;
