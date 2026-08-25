# Adaptive Climate escalation — session record

Written at the end of a working session on the Adaptive Climate emergency-dispatch flow. It exists
because most of what was changed **does not appear in git**, and because a number of decisions were
made deliberately that would otherwise look like bugs worth "fixing".

Read `docs/adaptive-call-flow.md` for the contract. This file covers what changed, why, and what is
still outstanding.

> **No credentials appear in this file.** Secrets are referenced by name and location only.

---

## 1. Orientation

Three codebases serve one flow:

| Codebase | Owns |
|---|---|
| `voiceagent-st-webhook` (this repo) | ServiceTrade job creation, the outbound post-call webhook, all client email |
| Apps Script `Adaptiveclimates oc-outbound` | escalation state — who gets dialled, when the emergency is over |
| `vercel-webhook-integration` (`api/adaptiveclimate.py`) | the inbound leg; builds the sheet row. Skips `direction == "outbound"` entirely |

The sheet (`Sheet1`, columns A–AC) is the escalation state machine's storage. One row per inbound
emergency call, updated in place until terminal.

## 2. Where the code lives — read this before assuming a PR is complete

`google-sheet/code.gs` is the **deployed** Apps Script `Code.gs`. `retell/*.json` are the **live**
Retell agent configs, with the prompts also exported as `.txt` for readability.

**Both directories are gitignored** (`.gitignore:152` and `:75`). They appear in no diff, no commit
and no PR. Changes to them must be pasted into the Apps Script editor and the Retell dashboard by
hand, and the two must not drift from the files here.

A copy of the current versions lives outside the repo at
`~/dev/adaptive-backups/2026-08-11-adaptive-fixes/`. There is **no pre-change copy** — Apps Script
version history and Retell agent versions are the only rollback points.

## 3. Defects found and fixed

Each was diagnosed from live sheet rows, not from reading alone.

**Duplicated `outcome` lines.** Row 375 had `JOB CREATED` twice; row 390 had one line three times
and another twice; row 377 had four identical lines. Cause: `notifySheet` gave the Apps Script 4
seconds to respond, but `handleJobUpdate` takes a script lock, writes, flushes twice and could send
an email before replying. The abort only closed the client socket — Apps Script kept running and
committed the write — so the retry re-applied an update that had already succeeded. Row 390's
counts match the retry limit exactly.

**Mislabelled steps.** `RESPONSE_CALL_ID_3` is a shared slot for every call from the third onward,
so call 4's result was labelled `call3`. Fixed by taking the step number from
`call_decline_counter`.

**Escalation continued after a technician answered and declined.** The dedupe guard in
`checkAnsweredAndComplete` matched on a `callN - ` prefix and sat *before* the Retell fetch. The
webhook's own line carries the same prefix and usually lands first, so the guard returned
`'continue'` — meaning "no answer, dial the next contact" — and answer detection never ran. On row
377 that produced three unnecessary calls. This was the most damaging of the four.

**Jobs created from voicemail.** The `servicetrade_job_created` post-call variable was defined in
terms of a tool that no longer exists, so the analyzer inferred loosely from the transcript — and
Clara's own voicemail message reads as engagement.

**The client email described a state the row had not reached.** `checkAnsweredAndComplete` sent it
the moment a call was classified as answered, before the job result arrived, so an approved job
emailed "Needs Review" with no job number and the correct email was then blocked by the once-guard.
Largely dormant until the answer-detection fix above made it the normal path.

## 4. Decisions taken

**Gate order is no-answer → voicemail → approved → declined.** All three "no job" cases arrive with
`servicetrade_job_created = false`. No-answer must be separated first, or a decline cannot safely
end escalation — an unanswered call would end it too and the backup contacts would never be dialled.
No-answer is checked before voicemail because both can look true on one call, and what the carrier
reports about the connection outranks what the analyzer inferred from a transcript that may not
exist.

**Terminality is decided by the webhook, not the Apps Script**, and travels as a `terminal` field on
`job_update`. The Apps Script cannot derive it — all three cases used to read identically.

**Client email ownership moved to `emailNotificationService`.** The Apps Script notifies
`POST /st-escalation-complete`; that endpoint sends. Recipients and the send/fail toggles come from
the agent's `servicetrade_tokens` row rather than a hardcoded list. One trigger
(`escalation_complete = true`), one sender — which is why the direct send in `matchLocation.js` was
removed rather than kept alongside it.

**Whoever writes last, sends.** Paths where no call was placed notify immediately. Paths with a
`job_update` still in flight mark the row pending and let `handleJobUpdate` notify. A 15-minute
backstop covers a `job_update` that never arrives, flagged so staff are alerted. No settle timer.

**Endpoint scoping is an allowlist** (`ESCALATION_EMAIL_AGENT_IDS`), so no other tenant can trigger
an escalation email through that route.

**Test-caller mode** routes an emergency from a nominated number back to that same number for the
whole ladder, redirects both emails to a test inbox, tags the row `[TEST_ROW]`, and prefixes the
ServiceTrade job summary `[TEST]` so it can be found and deleted. Real jobs are created on purpose
and cleaned up by hand.

**Inbound address capture is mandatory**, with a once-through street → city/state → postal re-ask
triggered by `validate_address` failure. `/st-match-location` is never called during a call — the
only in-call address signal is Google Maps geocoding.

### Reversed on 2026-08-14 — inactive locations no longer block

`f6e6ebe` made an inactive ServiceTrade location terminal: no dispatch call, no job,
manual-review email. That has been **reverted by decision**. Deactivation is a
bookkeeping state in ServiceTrade and says nothing about whether the emergency is real —
and 147 of the account's 393 locations are inactive.

An inactive location now behaves exactly like an active one, except that it is flagged
everywhere: the dispatch call says it (`{{inactive_address}}` /
`{{location_status_note}}`), the technician email is subject-prefixed
`[INACTIVE LOCATION]`, the outcome trail names it, the ServiceTrade job description
carries `[INACTIVE LOCATION]`, and the client email subject is prefixed
`[Inactive Location]`. The technician's explicit yes or no still decides the job.

### Reversed on 2026-08-24 — `none` no longer blocks either

`none` — no location match at all — used to be terminal: no call, no job, manual-review
email. That has been **reverted by decision**, for the same reason `inactive` was, plus a
worse one: nobody was dialled, so no human ever heard about the emergency. The office got
an email and the caller got nothing.

An address that is not on file now dispatches exactly like an inactive one. The dispatch
call says it (`{{unmatched_address}}` / `{{location_status_note}}`), the technician email
is subject-prefixed `[ADDRESS NOT ON FILE]`, the outcome trail names it, column AD reads
`none`, and the client email is subject-prefixed `[Address Not On File]` with its own flag
card. The technician's explicit yes or no still decides.

What their **yes** cannot do is create the job: `POST /job` requires a `locationId` and
there is none. So the post-call webhook ends the chain and the office email says the job
must be created by hand (`OUTCOMES.no_match`, reason label
`Technician Approved — No Location On File`). A decline is labelled
`declined_unmatched`. Both are terminal.

Only a **missing address entirely** is still terminal (`code.gs` doPost) — there is
nothing to brief a technician with, which is a different case from an address that is
simply not on file.

**Unverified:** whether ServiceTrade actually accepts `POST /job` against an inactive
`locationId`. The API documents no restriction (`required: ['locationId','type']`, only
permission notes), and no probe job was created against the production account. If it
does refuse, the handler already has a first-class path for it —
`inactive_job_failed` — and the first real inactive emergency is where it gets exercised.

### Deliberate — do not "fix" without asking

- The technician alert CCs the client addresses. Raised, kept.
- When the on-call tech has an email but no phone, the first call goes to a backup contact but the
  tech is still the one emailed. Raised, kept.
- Only the on-call technician is ever emailed; backup contacts are dialled cold.
- A test call creates a **real** ServiceTrade job against a real customer location.

## 5. Current state

Branch `adaptive_code`, PR #13 open against `main`.

Committed: the `notifySheet` timeout, the voicemail gate, the three-gate split with the `terminal`
field, and `docs/adaptive-call-flow.md`.

Uncommitted: `src/routes/serviceTrade/escalationComplete.js` (new), plus changes to `src/app.js`,
`src/config/environment.js`, `src/routes/serviceTrade/matchLocation.js`,
`src/services/emailNotificationService.js` and `.env.example`.

Not in git at all: every Apps Script and Retell agent change described above.

**Nothing is deployed.** The Apps Script and the agent configs still hold their previous versions,
and the new endpoint is not live. The Apps Script depends on that endpoint existing — deploy the
Node side first, or notifies 404 and the backstop retries them.

## 6. Outstanding

- Sync `google-sheet/code.gs` into the Apps Script project and import the three Retell configs.
- Set `ESCALATION_EMAIL_AGENT_IDS` in the Vercel project environment; it currently relies on a
  hardcoded fallback.
- Confirm `ADAPTIVE_SHEET_EXEC_URL` is set in Vercel. If it is not, `notifySheet` skips silently and
  no `job_update` ever reaches the sheet.
- Rotate the plaintext credentials: the Retell and SendGrid keys in `google-sheet/code.gs`, and the
  `validate_address` bearer in both inbound Retell configs. Move the Apps Script pair to
  `PropertiesService`.
- Repair the duplicated `outcome` cells on rows 375, 377, 384 and 390 by hand.
- ~~The verification harnesses were written to a session scratchpad~~ — **done.** They live
  in `tests/` (`node --test`, no network). Run `npm test` for the current count —
  pinning a number here only makes the doc wrong on the next commit.
- ~~`caller_details` and `location_extract` describe an `st_customer` function~~ —
  **done.** Zero `st_customer` references remain in any of the three agent configs.

## 7. Landmines

- ~~**`npm install` fails with an E401**~~ — **fixed 2026-08-14.** The cause was the global
  `~/.npmrc` pointing npm at an AWS CodeArtifact registry with a dead token. Every dependency is
  public and `package-lock.json` resolves all 266 to `registry.npmjs.org`, so
  `npm ci --registry=https://registry.npmjs.org` installs cleanly. `npm run build:smoke` now runs
  and passes, and there is a real suite: `npm test`.
- ~~**`.env.local` is not loaded.**~~ — **fixed 2026-08-14.** `src/config/environment.js` and
  `src/config/database.js` now load `.env.local` before `.env`. dotenv never overwrites an
  already-set variable, so both calls are no-ops on Vercel.
- **Apps Script URLs are hardcoded** to the production Vercel domain.
- **`processAllEscalations` takes no script lock**, so it can interleave with `handleJobUpdate`.
  `appendOutcome` re-reads immediately before writing, which narrows the window but does not close
  it.
- The escalation trigger runs **every 1 minute**, not the 5 the old header comment claimed.

---

## 8. 2026-08-14 session — what changed

### Inactive locations dispatch instead of blocking
See §4. Touches `contextJobService.js:65-100` (the active-preferred pick now falls through
to `matched` with `locationStatus:'inactive'`), `matchLocation.js`, `retellOutbound.js`
(three new OUTCOMES + `location_status` on `job_update`), `code.gs` (the pre-flight gate,
`makeRetellCall`, `sendTechnicianEmergencyEmail`, `handleJobUpdate`,
`notifyEscalationComplete`), `emailNotificationService.js` (subject prefix + flag card) and
all three Retell agents.

### New sheet column AD `location_status`
`active | inactive | none | failed_open | ''`. Written by the pre-flight gate, overwritten
by `handleJobUpdate` when the post-call webhook resolves a location — that verdict wins,
because it is what the job was created against. `SHEET_NUM_COLUMNS` is 30.
**Run `setupTriggers()` once after deploying** to write the AD header.

### Outcome trail is timestamped
`appendOutcome` prefixes `[dd/MM HH:mm:ss]` (America/New_York). The exact-duplicate guard
compares text with the stamp stripped — without that, two deliveries of the same
`job_update` differ by a few seconds and the guard that stops duplicated outcome cells
silently dies.

### Bugs found and fixed
- **`classifyCall` discarded voicemail when the hangup reason was in the ANSWERED set.**
  An answering machine that took Clara's message ended as `user_hangup`, which won over
  `in_voicemail`/`reached_voicemail`, so the chain stopped terminal with nobody reached.
  The voicemail check moved above the ANSWERED set. Caught by a test, not by reading.
- **Phone matching never matched anything.** `normalizePhone` stripped to bare digits, so
  E.164 `+14169012663` (11) was compared against ServiceTrade's `(416) 901-2663` (10).
  Now compares the last ten digits. Confirmed live: `GET /contact?search=+14169012663`
  returns **0** contacts; `search=4169012663` returns the right one. `searchByPhone` now
  queries the ten-digit form.
- **The outer catch in `retellOutbound.js` omitted `terminal`**, defaulting to false while
  every other error branch sent true — an unexpected throw left the chain live.
- **`retellOutbound.js`'s idempotency-sweep `setInterval` was not `.unref()`'d**, unlike
  `retell.js:22`. It held the event loop open; a test run never exited.
- **`/st-escalation-complete` had no idempotency of its own.** If SendGrid succeeded and
  the HTTP response was lost, GAS never set its `client_email_sent_<callId>` guard, the
  15-minute backstop retried, and the client got a second email. Now cached per instance
  — but recorded **only after a successful send**, so a genuine SendGrid failure still
  returns 500 and the Apps Script retry still gets through.

### Caller phone → location (`POST /st-inbound-lookup`)
Retell's inbound-call webhook, configured **per phone number**. Advisory only, fail-open,
never blocks. Lets the agent confirm a known caller's address instead of interrogating.

Measured against the live account: **393 locations, one page, ~370ms**, so
`src/services/locationPhoneIndex.js` builds a cached phone→location index (12h TTL) and
that is the primary lookup; `/contact?search=` is the fallback. 204 distinct numbers, of
which **159 map to exactly one location** — those resolve. 45 map to several and are
refused rather than guessed. Contacts spread over more than 8 locations are rejected:
Adaptive's `Service Trade Work Acknowledgements` contact is attached to 103 of them.

The "removed slow getLocations() fallback (2-3 minutes)" note at
`customerMatchingService.js:432` does not hold for a tenant this size.

### Retell prompt fixes (gitignored — must be pasted into the dashboard)

Six defects in the prompts themselves, all verified before changing:

- **Office Hours had a MANDATORY block calling `{{create_job}}`**, a tool that exists on
  neither agent, told Clara to ask *the caller* "Do you need me to create a job number?"
  (a technician question — `oc-tech` is a lookup, not a connection), and both forbade
  sharing the job number and instructed reading it aloud. It also contradicted the
  architecture: no inbound agent may create a job at all. Replaced with the After Hours
  block, which was already correct.
- **Office Hours promised the caller a follow-up call** to confirm an unmatched address.
  Nothing in any of the three codebases places one. The promise is gone; the flag stays.
- **Office Hours enumerated street/city/province/postal on the FIRST address ask** while
  After Hours explicitly forbids it. Enumerating invites the fragmented back-and-forth.
  Both agents now use the single plain ask.
- **Both claimed all company facts live in a knowledge base** named "Adaptive Climates",
  and Office Hours said "Answer ONLY using knowledge base" — but `knowledge_base_ids` is
  `[]` on both agents, so the instruction is unfollowable. Replaced with "do not invent;
  offer to have someone confirm".
- **`begin_message` overrode the prompt's mandated greeting**, so Clara never introduced
  herself by name on either agent. Aligned to the prompt.
- **`location_extract` and `caller_details` read fields off `{{st_customer}}`**, a tool
  defined nowhere, so `locationId` was permanently unfillable. Repointed at
  `{{st_location_id}}` / `{{st_location_found}}` from the new inbound webhook.

No `{{...}}` reference in any of the three prompts is now undefined.

### `default_dynamic_variables` added to all three agents

The key was **absent** on every agent. Any variable the caller never supplied rendered as
a raw `{{mustache}}` in the prompt: Clara can read that aloud, and the inbound KNOWN
CALLER branch reads the literal string `{{st_location_found}}` as truthy and confirms an
address it never received. Defaults are now declared agent-side, so a missing inbound
webhook, a failed lookup or an older Apps Script deploy all degrade to the safe value.

| Agent | Defaults |
|---|---|
| After Hours, Office Hours | `st_lookup_ok=false`, `st_location_found=false`, `st_location_status=unknown`, `st_location_serviceable=false`, `st_location_id/name/address=""` |
| Outbound | `inactive_address=false`, `location_status_note=""`, plus `customer_name`, `customer_address`, `from_number`, `call_summary`, `contact_name`, `escalation_call=false`, `inbound_agent_id`, `inbound_call_id` |

`from_number` mattering most on the outbound side: it is the `transfer_call` destination,
so a raw mustache there is a failed warm transfer.

Also corrected: the KNOWN CALLER block interpolated `{{st_location_status}}` inside an
instruction *not* to mention it, which renders the value into the prompt text ("NEVER
mention active"). And the outbound `make_call` description covered only two of the four
cases the prompt actually treats as false (transfer, declined callback, self-handling,
callback requested); it now covers all four.

### Retell agent changes (gitignored — must be pasted into the dashboard)
- Outbound: `{{inactive_address}}` + `{{location_status_note}}` in the context block and
  the briefing; "an inactive location is not a reason to refuse" in the job-decision
  section; `servicetrade_job_created` description extended to cover it.
- Both inbound: a KNOWN CALLER block that confirms `{{st_location_name}}` /
  `{{st_location_address}}` instead of running the address interrogation; new post-call
  variables `address_unmatched` and `address_capture_method`.
- Office Hours only: added the missing `fromNumber` and `isitEmergency` post-call
  variables. Both are in `adaptiveclimate.py`'s `CRITICAL_FIELDS`, so every Office Hours
  call was burning the full 3-attempt / 18-second retry ladder before falling back.

## 9. Still outstanding

- `validate_address` (`https://clara-validate-address.vercel.app/api/validate-address`)
  returns `[{"error":"1"},"No address provided"]` for **every** body shape tried — root
  JSON, nested `args`, form-encoded, and a bare `address` field, with and without the
  configured bearer. If it is failing in production too, both inbound agents run the
  structured re-ask on every single call, which is exactly the back-and-forth being
  complained about. Needs the `clara-validate-address` source to settle.
- Because of that, the `args_at_root` mismatch on `validate_address` (After Hours `true`,
  Office Hours `false`, same endpoint) was **left alone** — there is no way to tell which
  is correct without the endpoint's parser.
- Native Retell voicemail detection is still off. `voicemail_detection`,
  `voicemail_option` and `end_call_after_silence_ms` are absent keys on all three agents;
  detection is prompt text plus a post-call LLM guess, so beep timing is uncontrolled and
  a 60-minute `max_call_duration_ms` has no silence timeout under it. Dashboard change.
- WS-2 cooldown (`code.gs:1030`) and the doPost duplicate-caller cooldown (`code.gs:1543`)
  still mark rows terminal without notifying Node, so those rows never produce a client
  email.
- `processAllEscalations` still takes no script lock while `handleJobUpdate` does, so a
  concurrent read-modify-write on column AA can drop a trail line.
- `vercel.json:12-15` routes `/adaptive` to `api/webhook.py`, which has no outbound skip
  and no dedupe, while `api/adaptiveclimate.py` has both. Confirm which is live.

---

## 10. 2026-08-24 session — phone-first matching, the location mirror, unmatched dispatch

### Phone normalization was silently wrong on extensions

`normalizePhone` was `replace(/[^\d]/g,'').slice(-10)`. It handled `()`, `-` and spaces
fine, but reducing to digits *before* stripping an extension glues the extension on and
`slice(-10)` then reads the wrong ten:

| stored | was | now |
|---|---|---|
| `416-408-2300 ext 450` | `4082300450` | `4164082300` |
| `905-374-4446 ext. 4306` | `7444464306` | `9053744446` |
| `(416) 360-0599 ext. 202` | `3600599202` | `4163600599` |

Ten locations on this account carry an extension, in five spellings. There is now **one**
normalizer, `src/utils/phone.js`, replacing three divergent copies
(`customerMatchingService.js`, `locationPhoneIndex.js`, and a weaker
`replace(/[()-\s]/g,'')` in `serviceTradeController.js`).

`code.gs`'s `normalizePhoneNumber` is a *different* function (it produces E.164, not a
comparison key) and keeps its contract, but got the same strip: `416-408-2300 ext 450`
used to reach 13 digits, fall through the `length >= 11 && <= 15` branch and return
**`+4164082300450`** — a dialable number that is not the technician's. It feeds the stored
caller column and every cooldown comparison.

### Phone is now the first filter, and corroborated before it settles

Two separate reasons it was not:

- `findCustomerWithConfidence` filters every candidate down to `directAddressLocationIds`
  when the address search returns direct hits, discarding a correct phone match in favour
  of a fuzzy address hit elsewhere.
- `buildCandidate` read `contactPhone` from the contact only, so a location-main-line hit
  arrived with `contactPhone: ''`, `phoneExact: false`, and could never reach Tier 1 —
  the one case `locationPhoneIndex.js` exists to serve.

A phone resolving to exactly one location now returns Tier 1 immediately and skips the
name/address/company searches entirely.

**It corroborates against BOTH sources first, and this is load-bearing.** `searchByPhone`
consults the location index only when contact search comes back empty, so a number on one
*contact* looks unique while the same number is two other locations' *main line*. Live
example: `416-555-0118` is on a contact at `Northvale(500 Ridgeway Ave. E)` and on the
main line of two further Northvale sites — three candidate locations, one of which the
contact path would have settled on alone. The address search used to be able to correct
that; a short-circuit cannot. So `lookupAllByPhone` (ambiguity included, unlike
`lookupByPhone`) is consulted and the union must be exactly one. An index failure defers
to the full fan-out rather than manufacturing a confident match.

Measured live: of 15 unique numbers, 13 settle by short-circuit with **0** wrong
locations; all **19** ambiguous numbers correctly defer.

### `servicetrade_locations` is mirrored hourly, and is a fallback only

The table arrived as a one-time load: `created_at 2026-03-20`, 359 rows, 35 behind live.

`GET /location?updatedAfter=<epoch>` is the incremental filter, **verified by probe** —
24 of 394 for the last 30 days. `updatedSince` is *not* supported (returns all 394) and
`updated_after` returns a 500. **Unknown query params are dropped silently**, so a
misspelled param name full-syncs every hour and looks like it is working. `GET /company`
honours it too (6 of 382).

The sync runs as a **Supabase Edge Function** — `supabase/functions/sync-locations`
(Deno) — scheduled by pg_cron calling its URL (`db/supabase-sync-locations-cron.sql`).

**There is no bespoke cron secret.** The function has `verify_jwt` on, so Supabase
rejects any unauthenticated call before the function runs, and pg_cron authenticates
with the project's existing service-role key out of Vault. Nothing new to invent, store
in two places, or rotate in lockstep.

The ServiceTrade auth it had to carry turned out to be small and fully portable: `GET
/auth` with the cookie to validate, `POST /auth` with the stored credentials to re-auth,
`PHPSESSID` out of `Set-Cookie`. It validates before re-authenticating, deliberately —
both runtimes write the same `servicetrade_tokens` row, and that order keeps a healthy
session shared rather than each side minting a new one.

The Node service has **no** sync route. `src/routes/cron/syncLocations.js` and the
helpers only it used (`getLocationsUpdatedAfter`, `getCompaniesUpdatedAfter`,
`upsertLocations`, `upsertCompanies`, the watermark and stored-id reads) are gone, so
there is exactly one writer. Node keeps `getLocationsForAgent`, the read path the
phone-index fallback needs.

Things that shaped it:

- **Companies must be written first.** `servicetrade_locations.servicetrade_company_id`
  has a foreign key to `servicetrade_companies`; 31 of the 340 referenced companies were
  missing, and the first sync attempt failed on it outright. An incremental company fetch
  is not enough either — a company created before the watermark whose *location* changed
  after it appears in neither, so the function gap-fills from the full company list when
  the location batch references anything still absent.
- **The watermark is derived, not stored:** `max(raw_response.updated)` minus a 2-hour
  overlap. No state table to drift out of step with the data.
- **Deletions are invisible to `updatedAfter`.** A deactivated location still returns with
  `status: 'inactive'`; a hard-deleted one just stops appearing. The 00:00 UTC run
  reconciles in full and **reports** absentees — it never deletes them.
- **`net.http_post` is fire-and-forget.** pg_cron records success the moment the request
  is queued, so a 500 from the endpoint is indistinguishable from a clean run in
  `cron.job_run_details`, and `net._http_response` is pruned after ~6 hours. The
  function logs its counts as one JSON line per run; the Edge Function logs are the
  durable version.
- **The service-role key lives in Vault**, because `cron.job.command` is readable by
  anyone who can query that table.
- **Almost nothing is configured.** One value, `LOCATION_SYNC_AGENT_IDS`, naming the
  agent the mirrored rows are keyed by. The rest is read out of the data:
  - `company_id` off the rows already stored for that agent (**317** for Adaptive).
    `public.companies` is NOT a source — it says `1765924063641` for Adaptive and
    disagrees with the mirror for 3 of the 5 agents in the table.
  - the ServiceTrade session via the shared `st_username` on `servicetrade_tokens`.
    The Adaptive inbound and outbound agents authenticate as the same ServiceTrade
    user, so there is no inbound→outbound mapping left to declare.
- **ServiceTrade looks like one session per user, and that shapes the auth.** The two
  Adaptive token rows share a username; the inbound row's session is dead while the
  outbound row's is live — consistent with the later login having invalidated the
  earlier one. Logging in as the mirror agent could therefore kill the session the live
  call path is using, mid-emergency. So the function walks every token row for that
  username, reuses the first whose session already validates, and re-authenticates only
  when none does. Verified live: it selects `agent_c4123a0589c456c9f19e369340` — the row
  with the live session — rather than re-authenticating the mirror agent.

First run: **359 → 395 locations**, 351 → 383 companies, 147 inactive.

The mirror is consulted **only** when a cold index rebuild fails and no cached index
exists — a ServiceTrade outage on a cold instance, which is exactly when an emergency call
must still resolve. It caches for 5 minutes, not 12 hours, and logs
`SERVING FROM MIRROR` so a match resolved from mirrored data is distinguishable from a
live one. An unconfigured agent id refuses rather than reading another tenant's rows.

### One regression, found and fixed on 2026-08-24

Removing the Node sync helpers, a too-greedy regex also deleted
`serviceTradeService.getAllLocations` — the primary phone-index path
(`locationPhoneIndex.js:141`). The suite stayed green because every test stubs
`serviceTradeService`, and a diff against HEAD looked clean because that method was
itself uncommitted, so HEAD did not have it either. Restored and verified live (394
locations, 204 distinct numbers, ~755ms), and every `serviceTradeService.*` /
`supabaseService.*` call site across `src/` was audited afterwards — all resolve.

### Deliberate — do not "fix" without asking

- A **unique phone hit ends the matching**. No address search runs, and the address-direct
  filter never gets to discard it. That is the point.
- The short-circuit requires **both** the contact graph and the location index to agree.
  Removing the second check restores the wrong-location bug above.
- The daily reconcile **reports** locations missing from the API and does not delete them.
  A location vanishing is more likely a permissions or paging anomaly than a real
  deletion, and a job created against a row we deleted is unrecoverable.
- `address_unmatched` / `address_capture_method` on the inbound agents remain collected and
  unconsumed. The authoritative unmatched verdict comes from the pre-flight gate, which
  resolves against ServiceTrade; a caller-side guess must not override it.

### Still outstanding

- **Deploy the Edge Function, then schedule it:**
  `supabase functions deploy sync-locations`,
  `supabase secrets set LOCATION_SYNC_AGENT_IDS="agent_efbe503faedf1bf516f961979f"`,
  then run
  `db/supabase-sync-locations-cron.sql` (it needs the project ref and the service-role
  key filled in). Until all three are done the sync never fires. Both unique indexes the
  SQL creates were verified already present.
- The function is **not type-checked** — there is no Deno on the dev machine. `deno check
  supabase/functions/sync-locations/index.ts`, or the deploy itself, is its first parse.
- **Paste the outbound agent changes into the Retell dashboard**: `unmatched_address:
  "false"` in `default_dynamic_variables`, the note condition firing on either flag, and
  the extended `servicetrade_job_created` description. Without the default, the flag
  renders as a literal `{{unmatched_address}}` and the prompt's truthiness check reads it
  as **true** — Clara would read the location note on every call.
- Everything in §6 and §9 that is still unticked, in particular the plaintext credentials
  in `code.gs` and the `validate_address` failure.
