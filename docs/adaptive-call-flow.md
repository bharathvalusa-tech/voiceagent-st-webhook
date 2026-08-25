# Adaptive Climate — Emergency Call Escalation Flow

> Scope: the **Adaptive Climate** emergency-dispatch pipeline only. It spans three
> codebases: this repo (`voiceagent-st-webhook`), `vercel-webhook-integration`
> (`api/adaptiveclimate.py`), and the Google Apps Script web app, whose source is
> mirrored in THIS repo at `google-sheet/code.gs` (gitignored). The Apps Script is
> deployed separately as a `/exec` web app; it is **not** run from this repo.
> There is no `vercel-webhook-integration/appscript/` directory — that path was stale.

## 1. Pipeline at a glance

```
 Customer places emergency call
            │
            ▼
 ┌───────────────────────────┐   Retell fires call_started / call_ended /
 │  Retell (inbound agent)   │   call_analyzed webhooks
 └───────────────────────────┘
            │ POST (raw body + x-retell-signature)
            ▼
 ┌──────────────────────────────────────────────┐
 │ voiceagent-st-webhook  (main router)          │
 │  src/app.js → src/routes/webhook/retell.js    │
 │  • forwardToApiGateway()  → API_GATEWAY_URL   │  (forwards call_started/ended/analyzed)
 └──────────────────────────────────────────────┘
            │
            ▼
 ┌──────────────────────────────────────────────┐
 │ vercel-webhook-integration                    │
 │  api/adaptiveclimate.py  do_POST()            │
 │  • only call_analyzed is processed            │
 │  • WS-4: skip direction=="outbound"           │
 │  • is_duplicate_call() (hash dedupe)          │
 │  • extract_variables_v4() + ensure_complete   │
 │  • get_tech_data_from_adaptive_climate_api()  │
 │  • send_to_google_sheets_v4() → ADAPTIVE_EXEC_URL
 └──────────────────────────────────────────────┘
            │ POST JSON (sheet_data)
            ▼
 ┌──────────────────────────────────────────────┐
 │ Google Apps Script  adaptiveclimate.gs        │
 │  doPost()                                     │
 │   • action=='job_update' → handleJobUpdate()  │  ◄── outbound post-call write-back
 │   • WS-4 guard: ignore outbound/self call_ids │
 │   • WS-3 upsert: findRowByCallId → update/append
 │   • emergency? → first call + tech email      │
 │  processAllEscalations()  (time trigger, 1m)  │
 │   • advances the escalation chain             │
 │   • places outbound "dispatch" calls (Retell) │
 └──────────────────────────────────────────────┘
            │ create-phone-call (outbound dispatch agent)
            ▼
 ┌──────────────────────────────────────────────┐
 │ Retell (OUTBOUND dispatch agent "Clara")      │
 │  calls tech → John → Alex → John …            │
 └──────────────────────────────────────────────┘
            │ post-call call_analyzed (outbound)
            ▼
 ┌──────────────────────────────────────────────┐
 │ voiceagent-st-webhook                         │
 │  src/routes/webhook/retellOutbound.js         │
 │  • gate on servicetrade_job_created           │
 │  • createJobFromCallContext() (ServiceTrade)  │
 │  • notifySheet() → job_update back to GAS      │
 └──────────────────────────────────────────────┘
            │ job_update (inbound_call_id, outbound_call_id, is_job_created, job_number, outcome)
            ▼
   GAS handleJobUpdate() writes final fields + (on job created) sends the
   consolidated client email with the full call log + transcripts (WS-6).
```

## 2. Inbound leg — creating the row

1. **Retell → main router.** `src/routes/webhook/retell.js` receives the inbound
   agent's `call_analyzed`. `forwardToApiGateway()` forwards the raw body +
   `x-retell-signature` to `API_GATEWAY_URL` (the Vercel function) so the
   signature stays verifiable. Only `call_started` / `call_ended` /
   `call_analyzed` are forwarded.
2. **Vercel (`api/adaptiveclimate.py`).** `do_POST()`:
   - Processes **only** `call_analyzed`.
   - **WS-4:** if `call.direction == "outbound"`, the event is one of our own
     escalation calls — it is skipped (returns 200) and never reaches the sheet.
   - `is_duplicate_call()` — hash of `call_id` + data signature + minute-rounded
     timestamp, persisted to `/tmp`, 24 h window. Suppresses the Python retry and
     Retell re-deliveries.
   - `extract_variables_v4()` (+ `ensure_complete_data()` re-fetch) resolves
     `fromNumber, customerName, serviceAddress, callSummary, email, isitEmergency,
     emergencyType`.
   - `get_tech_data_from_adaptive_climate_api()` resolves the on-call tech
     (name / email / phone), with `FALLBACK_TECH_*` env fallback.
   - `send_to_google_sheets_v4()` POSTs the `sheet_data` payload (incl.
     `direction`, WS-4) to `ADAPTIVE_EXEC_URL`.
3. **GAS `doPost()`.**
   - `action == 'job_update'` → `handleJobUpdate()` (outbound write-back; never
     creates a row). See §5.
   - **WS-4 guard:** if `direction == 'outbound'` or the `call_id` matches any
     `RESPONSE_CALL_ID_1/2/3` (`isOwnEscalationCallId`), ignore — no row inserted.
   - **WS-3 upsert:** `findRowByCallId(call_id)`. If found → `updateCapturedData()`
     fills blanks in place (no new row, no re-escalation). If not → `addDataToSheet()`
     appends a new row.
   - If `is_emergency`: cooldown check (§4), then `initializeAutomationWithEmail()`
     (tech email) + `processEscalationRowWithEmail()` (first call immediately).

### 2.1 Job-creation authority — the technician gates every job

For Adaptive, **no inbound agent ever creates a ServiceTrade job.** All three inbound
agents — main router (`agent_b2c6…`), office-hours (`agent_052c…`), and after-hours
(`agent_efbe…979f`) — are listed in `POSTCALL_JOB_DISABLED_AGENT_IDS`, so the inbound
handler `src/routes/webhook/retell.js` hits its `isPostCallJobDisabledAgent(agentId)`
check (`:685`), returns early, and creates nothing.

The **only** place a job is created is the outbound post-call webhook
`src/routes/webhook/retellOutbound.js`, which:

- does **not** consult `POSTCALL_JOB_DISABLED_AGENT_IDS` at all, and
- creates a job **only** when the technician approved it on the dispatch call —
  `servicetrade_job_created === true` (`:245`).

It resolves the ServiceTrade config owner from the **outbound dispatch agent's own id**
(`call.agent_id`) and creates the job under **that** agent's `servicetrade_tokens` +
`servicetrade_job_configs` row. Each tenant's outbound agent has its own pair of rows
(config lives in Supabase, per-tenant) — there is **no** global default agent id. If the
outbound agent has no row, `getAuthToken` throws → the webhook 500s + fires an internal
alert (`retellOutbound.js:289-296`); this is deliberate, so a misconfig surfaces loudly
instead of silently creating the job under the wrong ServiceTrade account.

> **No tool runs on the outbound call.** The technician's "yes" only sets the post-call
> variable `servicetrade_job_created`; the job is created afterwards by the webhook. (A
> former in-call `create_service_trade_job` tool was removed — it created jobs without
> going through the post-call gate and 500'd with "No ServiceTrade token found" because it
> looked up the token by the *outbound* agent's own id, which has no `servicetrade_tokens`
> row. Adding such a row would be dead data: nothing on the post-call path reads by the
> outbound agent id.)

**Net effect: a job exists only after the tech says yes on the outbound call** — there is
no inbound or in-call path to create one.

## 3. The outbound "dispatch" call — the three offers

Each escalation call is placed by GAS via Retell `create-phone-call`
(`makeRetellCall`, outbound agent `RETELL_AGENT_ID`, from `+14377030443`), passing
`inbound_call_id` as a dynamic variable so the result can be mapped back.

When a person answers, the outbound agent ("Clara") makes **three independent
offers**:

| Offer | Signal | Effect |
|-------|--------|--------|
| "Log a ServiceTrade job?" | `servicetrade_job_created` (post-call var) | `retellOutbound.js` creates the job and writes `is_job_created` / `job_number` / `outcome` back via `job_update`. |
| "Patch you through to the caller now?" | `transfer_call` tool (warm transfer to `{{from_number}}`) | The actual customer connection. |
| "Call you back?" (if no patch) | `make_call` enum | **Currently unused** — see note below. |

`servicetrade_job_created` is set **only** from the technician's spoken agreement — no tool
is invoked on the call. A second post-call var, `reached_voicemail`, is set by the agent when
a voicemail box or answering machine picked up. A warm transfer on its own is not approval.

### 3.1 The three gates in `retellOutbound.js`

All three "no job" cases arrive with `servicetrade_job_created = false`, so the handler
separates them before deciding anything, and tells the sheet which one it was:

| # | Gate | Detected from | Job? | Ends escalation? |
|---|------|---------------|------|------------------|
| 1 | Nobody answered | `disconnection_reason` in the no-answer set (`dial_no_answer`, `dial_busy`, `registered_call_timeout`, …) or `call_status` `not_connected`/`error` | no | **no** — keep dialing |
| 2 | Voicemail | `reached_voicemail`, else `call_analysis.in_voicemail` / `voicemail_reached` | no | **no** — keep dialing |
| 3a | Human answered, approved | `servicetrade_job_created = true` | **yes** | yes → success email |
| 3b | Human answered, declined | `servicetrade_job_created = false` | no | yes → job-failure email |

An **inactive** ServiceTrade location changes none of these gates. It is flagged, not
blocked: the job is created on approval exactly as for an active location, and the only
difference is the wording — `created_inactive` / `declined_inactive` on the trail, an
`[INACTIVE LOCATION]` job-description tag, and an `[Inactive Location]` subject prefix on
the client email. A ServiceTrade refusal on an inactive location has its own outcome,
`inactive_job_failed`, so it can be told apart from an outage.

The order matters. Gates 1 and 2 can both look true on the same call — the analyzer flags
`reached_voicemail` while telephony reports the dial as unanswered — so no-answer is checked
first and wins the label: what the carrier reports about the connection outranks what the
analyzer inferred from a transcript that may not exist. `voicemail_reached` is deliberately
kept out of the no-answer set so it still falls to gate 2.

Gate 1 is also what makes a decline safe to treat as terminal. An unanswered call produces
`servicetrade_job_created = false` too (no human, question never asked), so without it the
chain would end after the first no-answer and the ladder would never reach John / Alex /
Brian. `disconnection_reason` is used rather than a post-call variable because these calls
have no transcript to infer from.

The verdict travels to GAS as a `terminal` boolean on the `job_update` payload — GAS cannot
derive it, since all three cases used to read as `no job — tech declined`.

> **Stop condition (WS-1):** escalation stops on **any answered call**, decided
> from Retell `get-call` `call_status` + `disconnection_reason` (instant, no
> post-call-analysis lag). A tech who answers and *declines* the job or a callback
> still stops the chain. `make_call` is intentionally **not** consulted.

## 4. Escalation state machine (`adaptiveclimate.gs`)

- **Trigger:** first call fires immediately in `doPost`; subsequent steps run from
  the `processAllEscalations` time trigger every **1 minute** (`.everyMinutes(1)`),
  over rows where `make_call == true && is_emergency == true && escalation_complete == false`.
  The tick is deliberately faster than `DELAY_MINUTES` so answer detection and the
  outcome/terminal sheet writes land within ~1 min; the dial spacing is enforced
  separately by `canMakeCall`.
- **Steps (`getCallTarget`):** 1 = on-call tech (or skip to 3 if none) → 2 = John
  McLean → 3 = Alex Kovachev → 4 = John McLean. Hard cap `MAX_ESCALATION_ATTEMPTS = 4`.
- **Per tick (`processEscalationRowWithEmail`):**
  1. **WS-2 cooldown guard** — for `ALARM_MONITOR_NUMBERS`, if the same number
     already placed a real call within `SAME_NUMBER_COOLDOWN_MINUTES` (45), set
     `make_call=false`, `escalation_complete=true`, append a cooldown outcome, and
     dial nothing.
  2. **Terminal (counter ≥ MAX)** — evaluate the last placed call one final time:
     answered → stop; pending → wait; no answer → mark complete + send the
     "no one reached" client email (WS-6).
  3. **Delay gate** (`canMakeCall`, `DELAY_MINUTES = 5`).
  4. **Pre-flight ServiceTrade location gate (first call only)** — before the very
     first escalation call, `matchesServiceTradeLocation()` POSTs to
     `voiceagent-st-webhook /st-match-location` (`CONFIG.ST_MATCH_URL`). The verdict is
     written to column AD `location_status` and decides only whether we dial:
     - `active` → dial.
     - `inactive` → **dial anyway.** Deactivation is a ServiceTrade bookkeeping state and
       says nothing about whether the emergency is real; 147 of the account's 393
       locations are inactive. The technician is dialled, told on the call
       (`{{inactive_address}}` / `{{location_status_note}}`), emailed with an
       `[INACTIVE LOCATION]` subject prefix, and their yes or no decides the job exactly
       as it would for an active location.
     - `none` → **terminal, no call.** There is no `locationId`, so `POST /job` is
       impossible (`required: ['locationId','type']`). Outcome
       `no job created — no valid ServiceTrade location for the address`, manual-review
       client email.

     **Fail-open:** any endpoint error / non-200 → the call is placed anyway and AD reads
     `failed_open` (a transient outage never suppresses a real emergency). Uses the same
     matcher as post-call creation, so the gate's verdict and the eventual create verdict
     can't drift; when they do differ, the post-call one wins and overwrites AD. Every
     path appends a trail line, so a genuine match, a deactivated location and a fail-open
     are all distinguishable when reading the sheet afterwards.
  5. **First / next call** — `checkAnsweredAndComplete(callId, stepN)` on the prior
     call returns `stop` | `pending` | `continue`; on `continue` (no answer) the
     next contact is dialed and the counter advances. It re-fetches the call on every
     tick — it must never short-circuit on the presence of an outcome line, because the
     `job_update` webhook writes lines with the same `callN - ` prefix and would
     otherwise suppress answer detection entirely.
- **Voicemail is not an answer.** `classifyCall` returns `no_answer` for
  `voicemail_reached`, for `call_analysis.in_voicemail`, and for the outbound agent's own
  `reached_voicemail` verdict — so the chain keeps escalating to the next contact. The
  voicemail check sits **above** the ANSWERED disconnection-reason set: an answering
  machine that takes Clara's message and hangs up ends as `user_hangup`/`agent_hangup`, and
  with the check below that set the hangup reason won and the chain stopped with nobody
  reached. It stays below the no-answer set, so the carrier still outranks the analyzer.
  Gate order is no-answer → voicemail → answered, matching `retellOutbound.js`. The
  outbound webhook records `no job — reached voicemail; no technician contact` on the row
  without marking it terminal.
- **No service address → terminal before any dial.** If the inbound row lands with a blank
  `service_address`, `doPost` marks it complete, appends
  `no job — call ended before a service address was captured; manual follow-up needed`, and
  sends the manual-review client email. No escalation call is placed.
- **Stop conditions:** no ServiceTrade location match at all (pre-flight gate, first
  call) · no service address captured · answered call (WS-1) · job created, declined, or
  approved-but-failed — any `terminal` `job_update` (`handleJobUpdate`) ·
  automated-caller cooldown (WS-2) · max attempts exhausted.
- **Not stop conditions:** voicemail, no-answer, and an **inactive** location. All three
  write an outcome line and the chain continues.

## 5. Outbound write-back — `handleJobUpdate`

`retellOutbound.js` `notifySheet()` POSTs `{ action:'job_update', inbound_call_id,
outbound_call_id, is_job_created, job_number, outcome, terminal }`. GAS:

- Finds the row by `inbound_call_id` (`findRowByCallId`).
- **Downgrade guard:** once `is_job_created == TRUE`, a later "declined" update is ignored.
- **Duplicate guard:** once `is_job_created == TRUE`, a repeat "created" update returns
  `ignored_duplicate` before writing anything — `notifySheet` retries at-least-once and
  Retell re-delivers `call_analyzed` on any non-2xx, so the same payload does arrive twice.
- **WS-5:** appends a step-labeled line to `outcome` (`callN - <outcome>`), matching
  `outbound_call_id` against `RESPONSE_CALL_ID_1/2/3`. `RESPONSE_CALL_ID_3` is a shared slot
  for every call from the 3rd onward, so a match there takes its step number from
  `call_decline_counter` rather than assuming 3.
- **WS-6:** stops the chain (`make_call=false`, `escalation_complete=true`) and sends the
  consolidated client email when `is_job_created == true` (success email) or when the payload
  says `terminal` (manual-review email — a human answered and declined, or approved but the
  job failed). Voicemail and no-answer updates carry `terminal: false`, write only their
  outcome line, and leave escalation running. If `terminal` is absent (an older webhook
  deploy), GAS falls back to the legacy wording check so a rollout in either order is safe.

## 6. Simultaneous webhooks

- **Python** `is_duplicate_call()` — hash-based dedupe absorbs the Python retry and
  Retell re-deliveries of the same `call_analyzed`.
- **GAS `LockService`** — `addDataToSheet` serializes appends so two concurrent
  inbound webhooks can't both compute the same `getLastRow()+1`; `SpreadsheetApp.flush()`
  commits before releasing. `handleJobUpdate` locks its read-modify-write so two
  job updates for one row can't interleave (guarding the downgrade check).
- **WS-3 upsert** collapses sequential re-deliveries of the same inbound `call_id`
  into one row; **WS-4** stops our own outbound calls from ever inserting a row.

## 7. Column-population lifecycle (`Sheet1`, A–AD)

| Col | Field | Owner | When written |
|-----|-------|-------|--------------|
| A | timestamp | Vercel | row create |
| B | call_id | Vercel | row create (row key) |
| C | agent_name | Vercel | row create (+WS-3 self-heal) |
| D | call_duration | Vercel | row create (+WS-3) |
| E | user_sentiment | Vercel | row create (+WS-3) |
| F | call_successful | Vercel | row create (+WS-3) |
| G | call_summary | Vercel | row create (+WS-3) |
| H | transcript | Vercel | row create (+WS-3) |
| I | from_number | Vercel | row create (+WS-3) |
| J | customer_name | Vercel | row create (+WS-3) |
| K | service_address | Vercel | row create (+WS-3) |
| L | extracted_call_summary | Vercel | row create (+WS-3) |
| M | email (tech) | Vercel | row create (+WS-3) |
| N | outbound_agent_id | GAS | first escalation call (`recordCallTime`) |
| O | outbound_to_number | Vercel | row create (+WS-3) |
| P | tech_name | Vercel | row create (+WS-3) |
| Q | is_automated_call | GAS | row create (`addDataToSheet`) |
| R | is_emergency | Vercel→GAS | row create |
| S | **make_call** | GAS | row create (=emergency); → false on answered / max / cooldown / job-created |
| T | response_call_id_1 | GAS | after 1st escalation call |
| U | response_call_id_2 | GAS | after 2nd escalation call |
| V | response_call_id_3 | GAS | after 3rd/later escalation call |
| W | call_decline_counter | GAS | each step advance |
| X | last_call_time | GAS | after each escalation call |
| Y | **escalation_complete** | GAS | answered / max-attempts / cooldown / job-created |
| Z | is_email_sent | GAS | tech email sent (initialize/retry) |
| AA | **outcome** | GAS trail + webhook | appended per event (WS-5 trail + job result) |
| AB | **job_number** | webhook (`job_update`) | job created |
| AC | **is_job_created** | webhook (`job_update`) | job result |
| AD | **location_status** | GAS gate + webhook | `active`/`inactive`/`none`/`failed_open`; pre-flight writes it, `job_update` overwrites it |

**Final fields** (bold above) are settled at the terminal state — a resolution
(answered / job created) or `MAX_ESCALATION_ATTEMPTS` exhausted. `outcome`
accumulates the full per-call trail, e.g.:

```
call1 - no answer
call2 - answered
call2 - no job — tech declined
```

## 8. Key config / env

| Where | Key | Purpose |
|-------|-----|---------|
| voiceagent-st-webhook | `API_GATEWAY_URL` | Vercel `adaptiveclimate.py` endpoint |
| voiceagent-st-webhook | `ADAPTIVE_SHEET_EXEC_URL` | GAS web app (`job_update` write-back) |
| voiceagent-st-webhook | *(none — ST config owner)* | resolved per-tenant from the **outbound agent's own id** (`call.agent_id`) → its `servicetrade_tokens` + `servicetrade_job_configs` rows. No global default env var (removed); missing row → loud 500. See §2.1 |
| voiceagent-st-webhook | `POSTCALL_JOB_DISABLED_AGENT_IDS` | inbound agents blocked from post-call job creation (all 3 Adaptive inbound agents) — see §2.1 |
| GAS `CONFIG` | `ST_MATCH_URL` | pre-flight location check endpoint (`voiceagent-st-webhook /st-match-location`); GAS passes `agent_id = RETELL_AGENT_ID` (the outbound agent) — see §4 |
| vercel-webhook-integration | `ADAPTIVE_EXEC_URL` | GAS web app (inbound row create) |
| vercel-webhook-integration | `RETELL_API_KEY`, `FALLBACK_TECH_EMAIL/PHONE` | Retell re-fetch + tech fallback |
| GAS `CONFIG` | `RETELL_AGENT_ID` | outbound dispatch agent (`agent_c412…`) |
| GAS `CONFIG` | `ALARM_MONITOR_NUMBERS`, `SAME_NUMBER_COOLDOWN_MINUTES` | automated-caller cooldown |
| GAS `CONFIG` | `CLIENT_NOTIFICATION_EMAILS` | recipients of the consolidated client email (WS-6) |
| GAS `CONFIG` | `TEST_OVERRIDE_NUMBER` | route every escalation call to one test phone |
```
