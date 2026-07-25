# Standard ServiceTrade Call Flow (all accounts except Adaptive Climate)

> Scope: the **generic** inbound Retell → ServiceTrade → email flow shared by
> **every account except Adaptive Climate** (which has its own escalation pipeline
> — see [`adaptive-call-flow.md`](./adaptive-call-flow.md)).
>
> **There is one shared code path, not one per account.** Accounts are *config-only
> tenants*: each is a row in the Supabase `servicetrade_tokens` table keyed by the
> Retell `agent_id`. The business logic has **no per-tenant branching** — the only
> account-level switch is the `POSTCALL_JOB_DISABLED_AGENT_IDS` gate (§4). Adding a
> new company = adding a Supabase row; it then follows this exact flow. So this
> single doc covers all current and future non-Adaptive accounts.

## 1. Pipeline at a glance

```
 Customer places call
        │
        ▼
 ┌───────────────────────────┐
 │ Retell (inbound agent)    │  fires call_started / call_ended / call_analyzed
 └───────────────────────────┘
        │ POST /webhook/retell  (raw body + x-retell-signature)
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ voiceagent-st-webhook  src/routes/webhook/retell.js        │
 │  1. forwardToApiGateway() (only used by Adaptive)          │
 │  2. respond 200 immediately; real work in waitUntil()      │
 │  3. only call_analyzed is processed; idempotency dedupe    │
 │  4. extract caller/issue data                              │
 │  5. POST-CALL GATE: skip if agent in DISABLED list         │
 │  6. skip non-actionable calls (service_call=false, etc.)   │
 │  7. validate address (Google Maps)                         │
 │  8. load ST config (Supabase servicetrade_tokens by agent) │
 │  9. match customer/location (tiered fuzzy confidence)      │
 │ 10. create job (ServiceTrade API)                          │
 │ 11. send job email (success OR manual-review)              │
 └──────────────────────────────────────────────────────────┘
        │
        ▼
   ServiceTrade job created + email to the account's recipients
```

## 2. Entry point

`POST /webhook/retell` — `src/routes/webhook/retell.js`.

- `forwardToApiGateway()` (L24) forwards `call_started`/`call_ended`/`call_analyzed`
  to the Vercel Python integration. **Only Adaptive consumes this**; other accounts
  ignore it downstream.
- Only `call_analyzed` is processed; other events return `200 {status:'ignored'}` (L279).
- The handler responds **200 immediately** and runs the real work in
  `waitUntil(backgroundWork)` (L313) — Vercel serverless keeps the function alive
  after the response.
- **Idempotency:** a duplicate `call_analyzed` for an already-processed `call_id`
  is ignored (L292).

## 3. Data extraction

From the Retell `call` object the handler resolves (in priority order across
`collected_dynamic_variables` → `call_analysis.custom_analysis_data` → extracted
fields): caller phone (+ fallback phone), customer/company name, service address,
issue description, emergency flag, and optional ServiceTrade hints (tech IDs,
service-line IDs), plus feature flags like `service_call`.

## 4. Post-call job gate (the only account-specific switch)

```
if (isPostCallJobDisabledAgent(agentId)) return;   // src/routes/webhook/retell.js:685
```

- Driven by env `POSTCALL_JOB_DISABLED_AGENT_IDS` (comma-separated `agent_id`s, L131).
- Agents in this list **do not auto-create a job post-call** — job creation is
  deferred to an outbound approval flow (this is how Adaptive's inbound agents
  behave). **Every other agent proceeds to auto job creation.**

## 5. Skip / non-actionable guards

Before creating a job the flow skips (with an appropriate log / optional email):

- `service_call === false` — Retell explicitly flagged a non-service call →
  `reasonCode: 'not_a_service_call'` (L779-801).
- Non-actionable calls — too short, voicemail, unsuccessful, or no usable data.
- **No matching location** in ServiceTrade → sends a **manual-review** email
  (`reasonCode: 'no_matches'`) and stops (L995-1010).

## 6. Address validation & customer/location matching

- **Address validation:** `validateAddress()` (Google Maps, `googleMapsService`,
  L833). On failure it falls back to the raw address for matching (L854-865).
- **ServiceTrade config:** `supabaseService.getServiceTradeToken(agentId)` (L747/L882)
  loads the tenant's credentials + settings (§8).
- **Tiered fuzzy matching** (`customerMatchingService`):
  - **Tier 1** — high confidence (e.g. phone + address agree) (L1025).
  - **Tier 2** — medium confidence (single location, or a GPT-assisted pick among
    candidates) (L1043-1083).
  - A **fallback phone** is tried if the primary phone yields no tier-1/2 match (L968-985).
  - Extra guard: if a phone maps to multiple locations, at least one non-phone
    signal (address/company/location) must agree (L240-245).

## 7. Job creation & email

- **Create job:** `createJob()` (`serviceTradeController`) via the ServiceTrade API.
- **Notify:** `emailNotificationService.sendJobNotification()` (L331) — sends a
  **success** email (job created, with job number/link) or a **failure /
  manual-review** email, gated per account by `send_job_email` / `send_job_fail_email`.
  Recipients come from the tenant's `emailto` / `ccmail`.

> Unlike Adaptive (whose consolidated escalation email with transcripts is sent by
> the Google Apps Script layer), the standard flow sends its email **immediately
> from this service**, per call.

## 8. Per-account configuration (Supabase `servicetrade_tokens`)

Looked up by `agent_id` (`supabaseService.getServiceTradeToken`, `src/services/supabaseService.js:4-20`):

| Field | Purpose |
|-------|---------|
| `agent_id` | Retell agent UUID — the tenant key |
| `auth_token` | ServiceTrade session (PHPSESSID) |
| `st_username` / `st_password` | ServiceTrade creds (for re-auth) |
| `Name` | Company display name (emails/logs) |
| `send_job_email` / `send_job_fail_email` | Per-account email gates |
| `emailto` / `ccmail` | Recipient lists |
| `auth_data` | Job URL template, portal/app URLs |

## 9. Adaptive vs. Standard (contrast)

| Aspect | Standard account (this doc) | Adaptive Climate |
|--------|-----------------------------|------------------|
| Inbound job creation | Automatic, post-call | Disabled (via gate) |
| Approved by | Automatic (confidence ≥ threshold) | Technician on an outbound dispatch call |
| Escalation | None | 3-tier tech chain (Google Apps Script) |
| Outbound agent | No | Yes (dispatch) |
| Email sender | This service, immediately | Google Apps Script (consolidated, with transcripts) |
| External deps | None (self-contained) | Vercel Python + Google Apps Script + Sheet |

## 10. Other ServiceTrade routes (shared, account-agnostic)

From `src/app.js`:

- `POST /st-create-job` — create a job by explicit `locationId`.
- `POST /st-create-job-from-context` — **deprecated**; kept for legacy/GAS callers.
- `POST /st-customer` — customer/location lookup by phone.
- `GET  /st-customer-details`, `GET /st-job-details`, `GET /st-invoice-details`.
- `POST /st-create-service-request`.
- `POST /auth/servicetrade/refresh` — **per-account** re-auth (`src/routes/auth/serviceTradeAuth.js`): looks up `st_username`/`st_password` by `agent_id`, gets a fresh PHPSESSID, updates `servicetrade_tokens.auth_token`. (Username/password, not OAuth.)
- `GET /health`.

## 11. Key files

- `src/routes/webhook/retell.js` — the inbound flow (this doc).
- `src/controllers/serviceTradeController.js` — `createJob`.
- `src/services/customerMatchingService.js` — tiered fuzzy matching.
- `src/services/serviceTradeService.js` — ServiceTrade API client.
- `src/services/googleMapsService.js` — address validation.
- `src/services/emailNotificationService.js` — email builder/sender (SendGrid).
- `src/services/supabaseService.js` — per-tenant config lookup.
- `src/config/environment.js`, `.env.example` — env vars (`POSTCALL_JOB_DISABLED_AGENT_IDS`, ST/Supabase creds, etc.).
```
