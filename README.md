# voiceagent-st-webhook

Node.js Express service that receives Retell `call_analyzed` webhooks, validates addresses with Google Maps, matches customers in ServiceTrade with fuzzy scoring, and creates jobs when confidence meets the threshold.

## Project Structure

```
src/
├── config/
│   ├── database.js          # Supabase configuration
│   └── environment.js       # Environment variables configuration
├── services/
│   ├── googleMapsService.js # Google Maps address validation
│   ├── customerMatchingService.js # Parallel matching + scoring
│   ├── retellService.js     # Retell API helper
│   ├── serviceTradeService.js # ServiceTrade API service
│   └── supabaseService.js   # Supabase database service
├── routes/
│   ├── webhook/
│   │   └── retell.js         # Retell webhook handler
│   └── serviceTrade/         # Existing ServiceTrade routes
├── middleware/
│   ├── logger.js            # Request logging middleware
│   └── errorHandler.js      # Error handling middleware
├── utils/
│   └── responseHelper.js    # Response utility functions
├── app.js                   # Express application setup
└── server.js                # Server startup file
```

## API Endpoints

### POST /webhook/retell
Handles Retell `call_analyzed` events, validates address, performs matching, and creates a job if confidence >= threshold.

### POST /webhook/retell-outbound
Handles the post-call event from the **outbound dispatch** agent (Adaptive Climate escalation). On technician approval it creates the ServiceTrade job and posts a `job_update` back to the escalation sheet.

### POST /st-match-location
Pre-flight, match-only location check (no job created). Given call context (`service_address`, `from_number`, `customer_name`), returns `{ matched, locationId, locationName, tier }` using the same matcher as job creation. The Adaptive GAS escalation calls this before the first outbound call so it never dials the technician for an address that has no ServiceTrade location.

### GET /health
Health check endpoint.

## Adaptive Climate escalation pipeline (spans two other components)

Most accounts use the self-contained flow above (Retell → this service → ServiceTrade → email). **Adaptive Climate** is different: emergency calls run an escalation/dispatch pipeline that also involves the **`vercel-webhook-integration`** repo and a **Google Apps Script** web app.

- **`vercel-webhook-integration`** (Python — `api/adaptiveclimate.py`): a Vercel function that receives the forwarded Retell `call_analyzed` event, extracts/normalises the caller + emergency fields, looks up the on-call tech, and POSTs the row to the Apps Script web app.
- **Google Apps Script** (`adaptiveclimate.gs`, deployed separately as a `/exec` web app): writes the row to the tracking Google Sheet and runs the outbound escalation — calling the on-call tech, then fallback contacts, until someone answers.

**Data flow:**

```
Retell (inbound) → this service  POST /webhook/retell   (main router; forwardToApiGateway)
   → vercel-webhook-integration  api/adaptiveclimate.py
      → Google Apps Script web app → Google Sheet (row created)
         → GAS places the outbound "dispatch" call(s) to the technician
            → this service  POST /webhook/retell-outbound   (job decision)
               → job_update written back to the sheet
```

**Job-creation authority (important):** for Adaptive, **no inbound agent ever creates a ServiceTrade job** — the main router, office-hours, and after-hours agents are all in `POSTCALL_JOB_DISABLED_AGENT_IDS`, so the inbound handler (`retell.js:685`) creates nothing. A job is created **only** by `POST /webhook/retell-outbound`, and **only** after the technician approves it on the outbound dispatch call (`servicetrade_job_created === true`). That webhook resolves the ServiceTrade config from the **outbound dispatch agent's own id** (`call.agent_id`) → that agent's `servicetrade_tokens` + `servicetrade_job_configs` rows (per-tenant, in Supabase). There is **no** global default agent-id env var; if the outbound agent has no row, the webhook 500s + alerts (loud fail) rather than creating under the wrong account. So there is no inbound or in-call path to create a job — the tech gates every one. See §2.1 of the flow doc.

**Recent Adaptive-specific changes:** escalation now stops on any *answered* call (not just transfer), a hard 45-min cooldown for automated alarm callers, de-duplication of re-delivered calls, a single consolidated client email with the call log + transcripts of every escalation call (sent by the Apps Script layer, so the per-call emails here are retired — `SEND_CLIENT_EMAILS_FROM_OUTBOUND` in `retellOutbound.js`), and a **pre-flight ServiceTrade location gate** (`/st-match-location`) that skips the outbound call entirely when the caller's address matches no ServiceTrade location.

See **[`docs/adaptive-call-flow.md`](docs/adaptive-call-flow.md)** for the full Adaptive pipeline (field lifecycle, simultaneous-webhook handling). The generic non-Adaptive flow is in **[`docs/standard-call-flow.md`](docs/standard-call-flow.md)**.

## Environment Variables

### Env files in this repo

| File | Committed? | Purpose |
| --- | --- | --- |
| `.env.example` | yes | Reference/template. Documents the non-obvious variables (the ones added for the Adaptive escalation pipeline) with inline comments explaining *why* each exists. Copy it when setting up a new environment; it holds no secrets. |
| `.env.local` | no (gitignored) | The values the service actually reads when you run it locally. Generated by `vercel env pull`, then hand-completed (see the gotcha below). |
| `.vercel/.env.development.local` | no (gitignored) | Written by `vercel env pull` / `vercel dev`. Same contents as the Development pull; not read directly by `npm run dev`. |

Source of truth for deployed values is the **Vercel project's Environment Variables** (`vercel env ls`), not these files.

#### Gotcha: `vercel env pull` only pulls the Development environment

`vercel env pull` defaults to `--environment=development`, so any variable that exists **only** in Preview/Production will be silently absent from `.env.local`. Three of the Adaptive variables are Preview/Production-only, which is why they never appear after a plain pull:

- `INTERNAL_ALERT_RECIPIENTS`
- `ADAPTIVE_SHEET_EXEC_URL`
- `POSTCALL_JOB_DISABLED_AGENT_IDS`

To see or fetch them, target the environment explicitly:

```bash
vercel env ls                                        # shows which environments each var is set in
vercel env pull .env.production.local --environment=production
```

Then copy the missing keys into `.env.local` (or add them to the Development environment in Vercel so future pulls include them). Note that all three have safe fallbacks in `src/config/environment.js`, so a local run without them starts fine — it just behaves as if escalation gating and sheet write-back were off, which is a common source of "works in prod, not locally" confusion.

### Reference

Create a `.env` file in the root directory with the following variables:

```env
PORT=3000
NODE_ENV=development
SUPABASE_URL=your_supabase_url_here
SUPABASE_ANON_KEY=your_supabase_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
RETELL_API_KEY=your_retell_api_key_here
GOOGLE_MAPS_KEY=your_google_maps_key_here
MATCH_CONFIDENCE_THRESHOLD=80
FUZZY_SIMILARITY_THRESHOLD=0.8
INTERNAL_ALERT_RECIPIENTS=first.alerts@example.com,second.alerts@example.com
POSTCALL_JOB_DISABLED_AGENT_IDS=agent_xxxxxxxxxxxxxxxxxxxxxxxxxx,agent_yyyyyyyyyyyyyyyyyyyyyyyyyy
ADAPTIVE_SHEET_EXEC_URL=https://script.google.com/macros/s/<script_id>/exec
```

All values shown in this section are **placeholders**. Real recipient lists, Retell `agent_id`s, and the Apps Script `/exec` URL are tenant-specific and live only in the Vercel project's Environment Variables — read them with `vercel env ls` / `vercel env pull`, and do not paste them back into this file or `.env.example`.

### `INTERNAL_ALERT_RECIPIENTS`

Recipients of the **internal error/alert emails** sent by `sendInternalAlert` (`src/services/emailNotificationService.js`) when a call fails or a job cannot be created. Accepts a **comma- or semicolon-separated** list of addresses; whitespace and duplicates are ignored. These are the internal engineering/ops team addresses, distinct from the client-facing `emailto`/`ccmail` recipients configured per-agent in the `servicetrade_tokens` table.

If unset, it falls back to the built-in team list in `src/config/environment.js`, so existing deployments behave unchanged. Set this to override without a code change.

```env
INTERNAL_ALERT_RECIPIENTS="alice@example.com, bob@example.com; carol@example.com"
```

### `POSTCALL_JOB_DISABLED_AGENT_IDS`

Comma-separated list of **inbound `agent_id`s for which post-call ServiceTrade job creation is disabled**. For any agent in this list, the inbound `/webhook/retell` handler will **not** auto-create a job after the call.

This is the mechanism behind the Adaptive Climate flow described above: the main router, office-hours, and after-hours agents are all listed here, so no inbound agent ever creates a job. Instead, the job is created only by `POST /webhook/retell-outbound` **after the technician approves it** on the outbound dispatch call. Add an agent's id here whenever job creation must be gated behind human/technician approval rather than happening automatically at end of call.

**Who is currently in this list:** the agents belonging to **Adaptive Climate** and **Total Fire and Security**. No other tenant is gated this way today.

**This is a hard block, not a soft preference.** Once an `agent_id` is in this list there is **no path at all** for that agent to book a ServiceTrade job — not post-call, not in-call, not via retry. For Adaptive Climate the job instead comes from the outbound dispatch webhook after technician approval; for any tenant without that outbound path, listing the agent means jobs simply never get created. So only add an id when an alternative job-creation route exists (or when you deliberately want booking off), and remember to remove it when a tenant is meant to book normally again — a stale entry looks exactly like a silently broken integration.

```env
POSTCALL_JOB_DISABLED_AGENT_IDS="agent_xxxxxxxxxxxxxxxxxxxxxxxxxx,agent_yyyyyyyyyyyyyyyyyyyyyyyyyy,agent_zzzzzzzzzzzzzzzzzzzzzzzzzz"
```

### `ADAPTIVE_SHEET_EXEC_URL`

**Adaptive Climate only.** No other tenant has a sheet in the loop, which is why this variable is Adaptive-specific rather than a general setting.

Adaptive Climate's pipeline mirrors every call into a Google Sheet for observability. **Every inbound call** gets a row written to the sheet (by the `vercel-webhook-integration` + Apps Script layer), and then, once the job outcome is known, **that same row is updated in place** — so one row tells the whole story of a call: who rang, who was escalated to, whether a job came out of it, and its number. That closing update is what this variable enables: after `POST /webhook/retell-outbound` decides a job, it POSTs an `action: "job_update"` payload to this `/exec` URL (`notifySheet` in `src/routes/webhook/retellOutbound.js`), setting `is_job_created`, `job_number`, and `outcome` on the row keyed by `inbound_call_id`.

The escalation state lives in that sheet, not in this service — the Apps Script layer reads it to decide whether to keep escalating and what to put in the consolidated client email. Without the write-back you lose the observability the sheet exists for: a job can be created in ServiceTrade while the row still shows the call unresolved.

The call is best-effort — retried with backoff, never throws, never fails the webhook — and is skipped entirely if the URL is unset or there is no `inbound_call_id` to key the row on. Use the same `/exec` value that the `vercel-webhook-integration` project's `ADAPTIVE_EXEC_URL` points at, otherwise the update lands on a different deployment (or nothing at all).

```env
ADAPTIVE_SHEET_EXEC_URL="https://script.google.com/macros/s/<script_id>/exec"
```

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your environment variables

3. Start the development server:
```bash
npm run dev
```

4. Or start the production server:
```bash
npm start
```

## Scripts

- `npm start`: Start the production server
- `npm run dev`: Start the development server with nodemon
