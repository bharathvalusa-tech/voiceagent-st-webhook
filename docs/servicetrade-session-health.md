# ServiceTrade sessions — how they stay alive

A ServiceTrade session is a `PHPSESSID` string stored per tenant in
`public.servicetrade_tokens.auth_token`. Every ServiceTrade call this service makes sends it
as a cookie. When it dies, that tenant's calls stop working until someone logs in by hand and
pastes a new value into Supabase.

This document is what replaced that.

> No credential value appears here. Usernames are named as a column, never as a value.

---

## 1. What ServiceTrade actually returns — read this before changing anything

Measured against `api.servicetrade.com` on 2026-09-11. Three different codes, three
different meanings, and the code used to look for only one of them:

| Request | Session state | Response |
|---|---|---|
| `GET /api/auth` | dead or unknown | **404** `{"messages":{"error":["No active session found for given auth token"]},"data":{"authenticated":false,...}}` |
| `GET /api/auth` | live | **200** `data.authenticated: true`, `data.authToken` echoes the session |
| `GET /api/location` (or any other resource) | dead | **401**, empty body |
| `POST /api/auth` | wrong password | **403** `{"messages":{"error":["Invalid credentials provided"]}}` |
| `POST /api/auth` | correct password | **200**, `data.authToken` **and** `Set-Cookie: PHPSESSID=` carry the same value |

The consequence that mattered: **the expiry signal on `/auth` is 404, not 401.** The alert
path matched `/401|unauthorized/i`, so an expired session produced an email headed "401
Unauthorized" only by luck, and a session that died quietly produced nothing at all.

`src/services/serviceTradeService.js:checkSession` encodes the whole table. It returns
`{ valid, expired, status, reason }` — and `expired` is deliberately **false** for a 5xx or a
timeout. A ServiceTrade outage is not an expired session, and treating it as one means every
blip throws away a working token.

---

## 2. The two things that force a new login

`src/controllers/serviceTradeController.js:resolveSessionForRow` is the single place that
decides. In order:

**The credentials changed.** `servicetrade_tokens.credentials_fingerprint` holds
`sha256(st_username + "\n" + st_password)` as of the login that minted the current
`auth_token`. The service recomputes it on every read. If the stored one differs, the token
belongs to a login that no longer exists, and it is discarded **without asking ServiceTrade** —
because the old session is often still perfectly valid, and that is exactly the case this
catches. Someone rotating a password in the Supabase table editor does not have to touch
`auth_token`; the next request notices and re-logs-in.

A **null** fingerprint means "never recorded", which is not the same as "changed" and forces
nothing. It is backfilled the first time a session is proven valid.

**ServiceTrade says the session is dead.** 404 on `GET /auth`, per §1.

Anything else — a 503, a timeout — returns the stored token unchanged and records
`last_auth_status = 'unverified'`.

---

## 3. Where it runs

| Trigger | Path | Covers |
|---|---|---|
| Any ServiceTrade call this service makes | `getAuthToken(agentId)` → `resolveSession` | every tenant taking live calls; heals inline, the caller never sees the failure |
| Hourly cron | `GET /auth/servicetrade/refresh-all` (`vercel.json` `crons`) | tenants **not** taking calls — a session that dies overnight is otherwise found by the first caller of the morning |
| By hand, one tenant | `POST /auth/servicetrade/refresh` `{"agent_id":"agent_…"}` | forcing a check |
| By hand, read-only | `GET /auth/servicetrade/status` | what the database believes; touches ServiceTrade not at all |

The sweep proves each session **twice**: `GET /auth` for the session itself, then
`GET /location?limit=1` for a real resource. Those are not the same check — a dead session
answers the first with 404 and the second with 401 — so `/auth` alone leaves the interesting
half untested.

`refresh-all` requires `CRON_SECRET`, as `Authorization: Bearer <secret>` or `x-cron-secret`.
Vercel Cron sends the Authorization form automatically once the env var is set on the project.
**An unset secret closes the route (503), it does not open it** — CORS on this app is `*`, and
the route can re-issue every tenant's production login.

---

## 4. The alert email

`emailNotificationService.sendInternalAlert` takes an optional `session` block, and when it is
present the email stops being a work item and becomes a record of what already happened:

- the status ServiceTrade returned and its own error wording
- what triggered it — expiry, or a credential edit
- `auth_token` **before** and `auth_token` **after**
- whether it was written to `servicetrade_tokens`, and at what time
- whether a live API call with the new token returned 200

Subjects differ so the inbox sorts itself:

- `[CLARA RECOVERED] 404 ServiceTrade session expired — renewed automatically | <tenant>`
- `[CLARA ALERT] 404 — ServiceTrade session expired, NOT renewed | <tenant>`

Tokens are **masked** — first four, last four, length. A `PHPSESSID` is a live login: anyone
holding it is signed in as that tenant's user. Masking is enough to tell two sessions apart,
which is the only thing the email needs it for. `ST_ALERT_TOKENS_FULL=true` prints them whole,
for a debugging session and not as a standing setting.

The hourly sweep sends **one digest**, and only when something was not already valid. An
hourly "all fine" is how an alert channel gets muted.

---

## 5. The database

Run `db/servicetrade_tokens_session_health.sql` once in the Supabase SQL editor. Every
statement is idempotent.

| Column | What it is for |
|---|---|
| `last_modified` | When the row last changed. Written by a **trigger**, so an edit made by hand in the table editor is stamped too — which is the case that matters, because that is how credentials actually get rotated |
| `credentials_fingerprint` | §2. A hash, never the password, so the column needs no special protection |
| `last_auth_status` | `valid` \| `healed` \| `failed` \| `no_credentials` \| `unverified` \| `credentials_changed` |
| `last_auth_checked_at` | When the session was last proven against ServiceTrade |
| `last_auth_error` | Text of the last failure; cleared on success |

The credential trigger sets `last_auth_status = 'credentials_changed'` and deliberately does
**not** clear `credentials_fingerprint`. The stale fingerprint *is* the signal — clearing it to
null would look identical to "never fingerprinted", which is the one case that must not force
a login.

**The code runs before the migration does.** `supabaseService.updateAuthToken` writes the
health columns, and on an unknown-column error retries with `auth_token` alone and logs why.
Without that, deploying this code to an un-migrated database would fail every write and turn a
working self-heal into a hard outage.

---

## 6. State of the eight tenants (2026-09-11)

Every row checked with this code against the live API.

| Tenant | `st_username` set | Session then | Now |
|---|---|---|---|
| Adaptive Climates Inc. | yes | 200 valid | valid |
| Adaptive Climates Inc. (Outbound) | yes | 200 valid | valid |
| Braconier | yes | **404 expired** | **healed automatically**, `GET /location` → 200 |
| Done Right Hood & Fire Safety | yes | 200 valid | valid |
| Total Fire & Security, Inc. | yes | 200 valid | valid |
| Pacific Western Fire Protection (2017) Ltd | **no** | **404 expired** | **cannot heal** |
| Vedant Lachake | **no** | **404 expired** | **cannot heal** |
| Winninger Fire Protection, Inc. | **no** | **404 expired** | **cannot heal** |

All five credentialed accounts log in and return **200** on `GET /location?limit=1`.

The three without credentials have all been expired for some time and no amount of code fixes
them: **set `st_username` and `st_password` on those three rows**, or accept that any
ServiceTrade call for them fails. Until then the sweep reports them as `failed` every hour,
which is the correct behaviour — the row is broken and saying so is the point.

Braconier's stored token also carried a trailing newline on one row; tokens are now trimmed on
both read and write, because that character travels into the `Cookie` header verbatim.
