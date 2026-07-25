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

**Recent Adaptive-specific changes:** escalation now stops on any *answered* call (not just transfer), a hard 45-min cooldown for automated alarm callers, de-duplication of re-delivered calls, and a single consolidated client email with the call log + transcripts of every escalation call — sent by the Apps Script layer, so the per-call emails here are retired (`SEND_CLIENT_EMAILS_FROM_OUTBOUND` in `retellOutbound.js`).

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
