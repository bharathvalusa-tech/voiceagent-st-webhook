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

**Job-creation authority (important):** for Adaptive, **no inbound agent ever creates a ServiceTrade job** — the main router, office-hours, and after-hours agents are all in `POSTCALL_JOB_DISABLED_AGENT_IDS`, so the inbound handler (`retell.js:685`) creates nothing. A job is created **only** by `POST /webhook/retell-outbound`, and **only** after the technician approves it on the outbound dispatch call (`servicetrade_job_created === true`). That webhook creates the job under the shared ServiceTrade owner `ST_CONTEXT_DEFAULT_AGENT_ID` (`agent_efbe…979f`); the outbound agent's own id is never used for a token/config lookup. So there is no inbound or in-call path to create a job — the tech gates every one. See §2.1 of the flow doc.

**Recent Adaptive-specific changes:** escalation now stops on any *answered* call (not just transfer), a hard 45-min cooldown for automated alarm callers, de-duplication of re-delivered calls, a single consolidated client email with the call log + transcripts of every escalation call (sent by the Apps Script layer, so the per-call emails here are retired — `SEND_CLIENT_EMAILS_FROM_OUTBOUND` in `retellOutbound.js`), and a **pre-flight ServiceTrade location gate** (`/st-match-location`) that skips the outbound call entirely when the caller's address matches no ServiceTrade location.

See **[`docs/adaptive-call-flow.md`](docs/adaptive-call-flow.md)** for the full Adaptive pipeline (field lifecycle, simultaneous-webhook handling). The generic non-Adaptive flow is in **[`docs/standard-call-flow.md`](docs/standard-call-flow.md)**.

## Environment Variables

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
INTERNAL_ALERT_RECIPIENTS=pavan.kalyan@justclara.ai,subham.agarwal@justclara.ai
POSTCALL_JOB_DISABLED_AGENT_IDS=agent_b2c640200a45d2f4b7d8ad8d28,agent_052cc725604f449c8725ef2718
```

### `INTERNAL_ALERT_RECIPIENTS`

Recipients of the **internal error/alert emails** sent by `sendInternalAlert` (`src/services/emailNotificationService.js`) when a call fails or a job cannot be created. Accepts a **comma- or semicolon-separated** list of addresses; whitespace and duplicates are ignored. These are the internal engineering/ops team addresses, distinct from the client-facing `emailto`/`ccmail` recipients configured per-agent in the `servicetrade_tokens` table.

If unset, it falls back to the built-in team list in `src/config/environment.js`, so existing deployments behave unchanged. Set this to override without a code change.

```env
INTERNAL_ALERT_RECIPIENTS="alice@justclara.ai, bob@justclara.ai; carol@justclara.ai"
```

### `POSTCALL_JOB_DISABLED_AGENT_IDS`

Comma-separated list of **inbound `agent_id`s for which post-call ServiceTrade job creation is disabled**. For any agent in this list, the inbound `/webhook/retell` handler will **not** auto-create a job after the call.

This is the mechanism behind the Adaptive Climate flow described above: the main router, office-hours, and after-hours agents are all listed here, so no inbound agent ever creates a job. Instead, the job is created only by `POST /webhook/retell-outbound` **after the technician approves it** on the outbound dispatch call. Add an agent's id here whenever job creation must be gated behind human/technician approval rather than happening automatically at end of call.

```env
POSTCALL_JOB_DISABLED_AGENT_IDS="agent_b2c640200a45d2f4b7d8ad8d28,agent_052cc725604f449c8725ef2718,agent_efbe503faedf1bf516f961979f"
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
