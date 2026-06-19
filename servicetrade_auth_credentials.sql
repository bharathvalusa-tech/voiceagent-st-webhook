-- Add credential columns to servicetrade_tokens so the server can
-- re-authenticate automatically when the PHPSESSID session expires.
-- st_password should be treated as sensitive — restrict access accordingly.

ALTER TABLE public.servicetrade_tokens
  ADD COLUMN IF NOT EXISTS st_username TEXT,
  ADD COLUMN IF NOT EXISTS st_password TEXT;
