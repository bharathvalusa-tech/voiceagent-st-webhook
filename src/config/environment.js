// Load .env.local before .env. dotenv never overwrites an already-set variable, so
// on Vercel (where everything arrives as a real process env var) both calls are
// no-ops. Locally, .env does not exist and .env.local does — a bare dotenv.config()
// silently loaded nothing and every consumer got undefined.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const parseNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

// Parse a comma/semicolon-separated email list into a de-duplicated array.
// Returns the provided fallback array when the env var is unset/empty.
const parseEmailList = (value, fallback = []) => {
    if (!value) return fallback;
    const emails = [...new Set(
        String(value)
            .split(/[;,]/)
            .map((entry) => entry.trim())
            .filter(Boolean)
    )];
    return emails.length > 0 ? emails : fallback;
};

// Parse a comma/semicolon-separated id list into a de-duplicated array.
const parseIdList = (value, fallback = []) => {
    if (!value) return fallback;
    const ids = [...new Set(
        String(value)
            .split(/[;,]/)
            .map((entry) => entry.trim())
            .filter(Boolean)
    )];
    return ids.length > 0 ? ids : fallback;
};

const config = {
    port: process.env.PORT || 3000,
    retellApiKey: process.env.RETELL_API_KEY || process.env.retellapikey,
    openaiApiKey: process.env.OPENAI_API_KEY || process.env.openaiapikey,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY,
    googleMapsKey: process.env.GOOGLE_MAPS_KEY,
    sendgridApiKey: process.env.SENDGRID_API_KEY,
    notificationEmailFrom: process.env.NOTIFICATION_EMAIL_FROM || 'developer@justclara.ai',
    notificationEmailFromName: process.env.NOTIFICATION_EMAIL_FROM_NAME || 'CLARA.AI',
    nodeEnv: process.env.NODE_ENV || 'development',
    // Adaptive Climates Apps Script /exec URL. The outbound post-call webhook POSTs
    // the job result here (action:'job_update') so the escalation sheet row is
    // updated with is_job_created / job_number / outcome. Same value as the
    // Vercel ADAPTIVE_EXEC_URL that feeds the sheet.
    adaptiveSheetExecUrl: process.env.ADAPTIVE_SHEET_EXEC_URL || '',
    // Recipients of internal error/alert emails (sendInternalAlert). Comma or
    // semicolon separated. Falls back to the built-in team list when unset.
    internalAlertRecipients: parseEmailList(process.env.INTERNAL_ALERT_RECIPIENTS, [
        'pavan.kalyan@justclara.ai',
        'subham.agarwal@justclara.ai',
        'aayush.thapar@justclara.ai',
        'bharath.valusa@justclara.ai'
    ]),
    // Agents allowed to trigger the consolidated escalation email via
    // POST /st-escalation-complete. Scoping is deliberate: that endpoint exists for the
    // Adaptive Climate escalation flow, where the Apps Script owns the terminal state and
    // fires ONE email per emergency. Tenants whose jobs are created on the inbound
    // post-call path email through their own route and must not reach this one.
    // Defaults to the Adaptive outbound dispatch agent.
    escalationEmailAgentIds: parseIdList(process.env.ESCALATION_EMAIL_AGENT_IDS, [
        'agent_c4123a0589c456c9f19e369340'
    ]),
    // INBOUND agent ids allowed to call POST /st-inbound-lookup (Retell's per-phone-number
    // inbound webhook). Same scoping reason as above: the route resolves against one
    // tenant's ServiceTrade account. Defaults to the two Adaptive inbound agents.
    // Adaptive main router, office-hours and after-hours agents.
    inboundLookupAgentIds: parseIdList(process.env.INBOUND_LOOKUP_AGENT_IDS, [
        'agent_b2c640200a45d2f4b7d8ad8d28',
        'agent_052cc725604f449c8725ef2718',
        'agent_efbe503faedf1bf516f961979f'
    ]),
    // Whose servicetrade_tokens row the inbound lookup authenticates with. NOT the
    // inbound agent — for Adaptive the ServiceTrade config lives on the OUTBOUND
    // dispatch agent, the same row /st-match-location and job creation resolve.
    inboundLookupStAgentId: process.env.INBOUND_LOOKUP_ST_AGENT_ID
        || 'agent_c4123a0589c456c9f19e369340',
    // Agents whose ServiceTrade locations are mirrored into `servicetrade_locations`.
    //
    // WRITING the mirror is the Supabase Edge Function's job
    // (supabase/functions/sync-locations). This service only READS it, as the
    // phone-index fallback when ServiceTrade is unreachable.
    //
    // Just the agent id the mirrored rows are keyed by. Everything else is derived:
    // `company_id` comes off the rows already stored for that agent, and the
    // ServiceTrade session is found via the shared `st_username` on
    // `servicetrade_tokens` — the inbound and outbound Adaptive agents authenticate
    // as the same ServiceTrade user, so there is nothing to declare.
    //
    // Keep in step with the Edge Function's own LOCATION_SYNC_AGENT_IDS secret.
    locationSyncAgentIds: parseIdList(process.env.LOCATION_SYNC_AGENT_IDS, [
        'agent_efbe503faedf1bf516f961979f'
    ]),
    matchingThresholds: {
        confidence: parseNumber(process.env.MATCH_CONFIDENCE_THRESHOLD, 80),
        fuzzySimilarity: parseNumber(process.env.FUZZY_SIMILARITY_THRESHOLD, 0.8),
        nameSimilarity: parseNumber(process.env.NAME_SIMILARITY_THRESHOLD, 0.6)
    }
};

module.exports = config;
