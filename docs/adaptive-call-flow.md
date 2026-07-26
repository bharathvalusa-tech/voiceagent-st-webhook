# Adaptive Climate — Emergency Call Escalation Flow

> Scope: the **Adaptive Climate** emergency-dispatch pipeline only. It spans three
> codebases: this repo (`voiceagent-st-webhook`), `vercel-webhook-integration`
> (`api/adaptiveclimate.py`), and the Google Apps Script web app
> (`vercel-webhook-integration/appscript/adaptiveclimate.gs`). The Apps Script is
> deployed separately as a `/exec` web app; it is **not** run from this repo.

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
 │  processAllEscalations()  (time trigger, 5m)  │
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

It resolves the ServiceTrade config owner as `inbound_agent_id || ST_CONTEXT_DEFAULT_AGENT_ID`
→ `agent_efbe…979f` and creates the job under **that** agent's `servicetrade_tokens` +
`servicetrade_job_configs` row. Being in the disabled list only blocks that agent's
*inbound* handler from creating — it does **not** restrict its token; the outbound path
borrows it purely as the shared ServiceTrade-account owner.

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

> **Stop condition (WS-1):** escalation stops on **any answered call**, decided
> from Retell `get-call` `call_status` + `disconnection_reason` (instant, no
> post-call-analysis lag). A tech who answers and *declines* the job or a callback
> still stops the chain. `make_call` is intentionally **not** consulted.

## 4. Escalation state machine (`adaptiveclimate.gs`)

- **Trigger:** first call fires immediately in `doPost`; subsequent steps run from
  the `processAllEscalations` time trigger every **5 minutes**, over rows where
  `make_call == true && is_emergency == true && escalation_complete == false`.
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
     `voiceagent-st-webhook /st-match-location` (`CONFIG.ST_MATCH_URL`). If the caller's
     address can't be confidently matched to a ServiceTrade location, the post-call job
     would only fail — so **no call is placed**: the row is marked terminal
     (`make_call=false`, `escalation_complete=true`, `is_job_created=false`), an outcome
     `no call — address not matched to a ServiceTrade location; manual follow-up needed`
     is appended, and the manual-review client email is sent. **Fail-open:** any endpoint
     error / non-200 → the call is placed anyway (a transient outage never suppresses a
     real emergency). Uses the same matcher as post-call creation, so the gate's verdict
     and the eventual create verdict can't drift.
  5. **First / next call** — `checkAnsweredAndComplete(callId, stepN)` on the prior
     call returns `stop` | `pending` | `continue`; on `continue` (no answer) the
     next contact is dialed and the counter advances.
- **Stop conditions:** no ServiceTrade location match (pre-flight gate, first call) ·
  answered call (WS-1) · job created (`handleJobUpdate`) · automated-caller cooldown
  (WS-2) · max attempts exhausted.

## 5. Outbound write-back — `handleJobUpdate`

`retellOutbound.js` `notifySheet()` POSTs `{ action:'job_update', inbound_call_id,
outbound_call_id, is_job_created, job_number, outcome }`. GAS:

- Finds the row by `inbound_call_id` (`findRowByCallId`).
- **Downgrade guard:** once `is_job_created == TRUE`, a later "declined" update is ignored.
- **WS-5:** appends a step-labeled line to `outcome` (`call1/2/3 - <outcome>`),
  matching `outbound_call_id` against `RESPONSE_CALL_ID_1/2/3`.
- **WS-6:** if `is_job_created == true`, marks the row terminal (`make_call=false`,
  `escalation_complete=true`) and sends the consolidated client email. A declined /
  no-match / error update is **not** treated as terminal here (a no-answer outbound
  call also lands in that branch); WS-1's answer-detection decides stop-vs-continue.

## 6. Simultaneous webhooks

- **Python** `is_duplicate_call()` — hash-based dedupe absorbs the Python retry and
  Retell re-deliveries of the same `call_analyzed`.
- **GAS `LockService`** — `addDataToSheet` serializes appends so two concurrent
  inbound webhooks can't both compute the same `getLastRow()+1`; `SpreadsheetApp.flush()`
  commits before releasing. `handleJobUpdate` locks its read-modify-write so two
  job updates for one row can't interleave (guarding the downgrade check).
- **WS-3 upsert** collapses sequential re-deliveries of the same inbound `call_id`
  into one row; **WS-4** stops our own outbound calls from ever inserting a row.

## 7. Column-population lifecycle (`Sheet1`, A–AC)

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
| voiceagent-st-webhook | `ST_CONTEXT_DEFAULT_AGENT_ID` | ServiceTrade config owner (`agent_efbe…979f`) the outbound webhook creates jobs under |
| voiceagent-st-webhook | `POSTCALL_JOB_DISABLED_AGENT_IDS` | inbound agents blocked from post-call job creation (all 3 Adaptive inbound agents) — see §2.1 |
| GAS `CONFIG` | `ST_MATCH_URL` | pre-flight location check endpoint (`voiceagent-st-webhook /st-match-location`) — see §4 |
| vercel-webhook-integration | `ADAPTIVE_EXEC_URL` | GAS web app (inbound row create) |
| vercel-webhook-integration | `RETELL_API_KEY`, `FALLBACK_TECH_EMAIL/PHONE` | Retell re-fetch + tech fallback |
| GAS `CONFIG` | `RETELL_AGENT_ID` | outbound dispatch agent (`agent_c412…`) |
| GAS `CONFIG` | `ALARM_MONITOR_NUMBERS`, `SAME_NUMBER_COOLDOWN_MINUTES` | automated-caller cooldown |
| GAS `CONFIG` | `CLIENT_NOTIFICATION_EMAILS` | recipients of the consolidated client email (WS-6) |
| GAS `CONFIG` | `TEST_OVERRIDE_NUMBER` | route every escalation call to one test phone |
```
