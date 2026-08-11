const express = require('express');
const router = express.Router();
const config = require('../../config/environment');
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const { createJobFromCallContext } = require('../../services/contextJobService');
const emailNotificationService = require('../../services/emailNotificationService');
const supabaseService = require('../../services/supabaseService');

/**
 * POST /webhook/retell-outbound
 *
 * Agent-level webhook for the PRODUCTION outbound dispatch agent
 * ("Adaptive Climates (Outbound)"). The ServiceTrade job is created here,
 * post-call, and ONLY when the technician approved it on the call — signalled
 * by the post-call variable `servicetrade_job_created === true`.
 *
 * On EVERY terminal outcome (job created OR not) the handler:
 *  1. POSTs a `job_update` back to the Adaptive Apps Script web app so the
 *     escalation sheet row (keyed by the INBOUND call_id, injected by GAS into
 *     the outbound call as `retell_llm_dynamic_variables.inbound_call_id`) is
 *     updated with is_job_created / job_number / outcome; and
 *  2. sends the client job email via emailNotificationService (success email on
 *     created; "manual review" failure email on declined / no_match / error),
 *     plus an internal CLARA alert on error.
 *
 * The `outcome` string is the single source of truth: the exact same text is
 * written to the sheet AND used as the email's reasonMessage.
 */

// Canonical outcome strings — shared by the sheet write-back and the email
// reason so the two can never drift.
const OUTCOMES = {
    created: 'job created — tech approved',
    declined: 'no job — tech declined',
    no_match: 'no job created — no valid ServiceTrade location (tech approved)',
    error: 'no job — error creating job',
    // A voicemail box answered instead of a person. NOT terminal — the escalation
    // chain must keep dialing the next contact — but it IS a job failure for the
    // row's metrics, so it gets its own trail line. Deliberately worded so it does
    // NOT match handleJobUpdate's "tech approved" / "error creating job" patterns,
    // which would wrongly mark the row terminal.
    voicemail: 'no job — reached voicemail; no technician contact'
};

// Isolated idempotency cache (mirrors src/routes/webhook/retell.js). Prevents a
// retried `call_analyzed` from creating a second job. In-memory, so it resets
// per serverless instance — same trade-off as the inbound handler.
//
// NOTE: this is best-effort only, and it is NOT what keeps the sheet trail free of
// duplicates. It is checked once per HTTP request, so it cannot stop notifySheet's
// own retry loop below, and being per-instance it cannot stop a Retell re-delivery
// that lands on a fresh serverless instance. The authoritative de-duplication is
// the idempotency guard in the Apps Script `handleJobUpdate`.
const processedCalls = new Map();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of processedCalls) {
        if (now - ts > IDEMPOTENCY_TTL_MS) processedCalls.delete(id);
    }
}, 60 * 1000);

// Normalize enum/boolean post-call values ("True"/"false"/1/0/etc.) to a bool,
// or null when the value is absent/unrecognized (so a missing flag never counts
// as approval).
function normalizeBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
        return null;
    }
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['true', 'yes', 'y', '1'].includes(v)) return true;
        if (['false', 'no', 'n', '0'].includes(v)) return false;
    }
    return null;
}

const SHEET_NOTIFY_MAX_ATTEMPTS = 3;
// Must stay ABOVE the Apps Script worst case, not below it. handleJobUpdate takes a
// script lock, writes, flushes twice, and can build + send the consolidated SendGrid
// email before it responds — comfortably past 4s. A timeout shorter than that reads a
// SUCCESS as a failure: the abort only closes our socket, while GAS keeps running and
// commits the write. The retry then re-POSTs an already-applied update and the outcome
// trail gains a duplicate line.
const SHEET_NOTIFY_TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST the job result back to the Adaptive escalation sheet (via the Apps Script
 * web app). Best-effort but durable: retries a few times with backoff so a
 * transient GAS/network blip doesn't drop the update. Never throws, never fails
 * the webhook. Skips quietly if the exec URL is unset or we have no
 * inbound_call_id to key the row.
 */
async function notifySheet({ inboundCallId, outboundCallId, isJobCreated, jobNumber, outcome }) {
    const url = config.adaptiveSheetExecUrl;
    if (!url) {
        console.log('[retell-outbound] ADAPTIVE_SHEET_EXEC_URL not set — skipping sheet update');
        return;
    }
    if (!inboundCallId) {
        console.log('[retell-outbound] no inbound_call_id — cannot map to a sheet row; skipping sheet update');
        return;
    }

    const body = JSON.stringify({
        action: 'job_update',
        inbound_call_id: inboundCallId,
        // WS-5: the outbound (escalation) call's own id, so GAS can step-label the
        // OUTCOME trail entry (call1/call2/call3) by matching RESPONSE_CALL_ID_*.
        outbound_call_id: outboundCallId || '',
        is_job_created: Boolean(isJobCreated),
        job_number: jobNumber || '',
        outcome: outcome || ''
    });

    for (let attempt = 1; attempt <= SHEET_NOTIFY_MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SHEET_NOTIFY_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: controller.signal
            });
            const text = await res.text().catch(() => '');
            if (res.ok) {
                console.log(`[retell-outbound] sheet job_update for ${inboundCallId}: ${res.status} ${text} (attempt ${attempt})`);
                return;
            }
            console.warn(`[retell-outbound] sheet job_update non-OK for ${inboundCallId}: ${res.status} ${text} (attempt ${attempt}/${SHEET_NOTIFY_MAX_ATTEMPTS})`);
        } catch (err) {
            console.warn(`[retell-outbound] sheet job_update error for ${inboundCallId}: ${err.message || err} (attempt ${attempt}/${SHEET_NOTIFY_MAX_ATTEMPTS})`);
        } finally {
            clearTimeout(timeout);
        }
        if (attempt < SHEET_NOTIFY_MAX_ATTEMPTS) await sleep(400 * attempt);
    }
    console.error(`[retell-outbound] sheet job_update FAILED after ${SHEET_NOTIFY_MAX_ATTEMPTS} attempts for ${inboundCallId}`);
}

router.post('/retell-outbound', async (req, res) => {
    // Declared out here so the catch block and the inner helpers can use them.
    let call = {};
    let vars = {};
    let callId = '';
    let inboundCallId = '';
    let configAgentId = '';

    // ---- per-request helpers (close over the vars above) ----

    // Load the Adaptive ServiceTrade settings row once (send_job_email flags,
    // emailto/ccmail, auth_data, company Name). Memoized; never throws.
    let _settings;
    let _settingsLoaded = false;
    const getSettings = async () => {
        if (_settingsLoaded) return _settings;
        _settingsLoaded = true;
        try {
            const tokenData = configAgentId ? await supabaseService.getServiceTradeToken(configAgentId) : null;
            _settings = (tokenData && tokenData[0]) || null;
        } catch (e) {
            console.error(`[retell-outbound] settings load failed for ${configAgentId}: ${e.message || e}`);
            _settings = null;
        }
        return _settings;
    };

    const buildBaseDetails = () => ({
        callId: inboundCallId || callId,
        agentId: configAgentId,
        customerName: vars.customer_name || vars.customerName,
        callerPhone: vars.from_number || vars.fromNumber,
        serviceAddress: vars.customer_address || vars.service_address,
        // Verbatim issue text drives both the summary card and the fallback.
        issueDescription: vars.call_summary || vars.callSummary,
        callSummary: vars.call_summary || vars.callSummary,
        priority: 'Emergency', // outbound dispatch only happens for emergencies
        timestamp: call.start_timestamp || Date.now()
    });

    // WS-6: the client-facing escalation email — now with the full call log +
    // transcripts of EVERY escalated call — is sent once by the GAS layer at the
    // terminal state (job created / answered-and-declined / max-attempts). The
    // per-outbound-call client emails here are therefore retired to avoid
    // duplicates and no-answer-call spam. notifySheet (write-back) and
    // alertInternal (staff error alerts) are unchanged. Flip this flag to
    // re-enable the legacy per-call ServiceTrade job-link emails from this service.
    const SEND_CLIENT_EMAILS_FROM_OUTBOUND = false;

    // Send the client job email (gated inside sendJobNotification by
    // send_job_email / send_job_fail_email). Never throws.
    const sendJobEmail = async (outcome, extraDetails = {}) => {
        if (!SEND_CLIENT_EMAILS_FROM_OUTBOUND) {
            console.log(`[retell-outbound] WS-6: client ${outcome} email suppressed here — GAS sends the consolidated escalation email with transcripts`);
            return;
        }
        try {
            const settings = await getSettings();
            if (!settings) {
                console.log(`[retell-outbound] no ST settings for ${configAgentId} — skipping ${outcome} email`);
                return;
            }
            await emailNotificationService.sendJobNotification({
                settings,
                outcome,
                details: { ...buildBaseDetails(), authData: settings.auth_data || {}, ...extraDetails }
            });
        } catch (e) {
            console.error(`[retell-outbound] job email (${outcome}) failed: ${e.message || e}`);
        }
    };

    // Internal CLARA staff alert (expired token / API errors). Never throws.
    const alertInternal = async (errorMessage) => {
        try {
            const settings = await getSettings();
            await emailNotificationService.sendInternalAlert({
                callId: inboundCallId || callId,
                agentId: configAgentId,
                companyName: settings && settings.Name,
                errorType: 'Outbound job creation error',
                errorMessage
            });
        } catch (e) {
            console.error(`[retell-outbound] internal alert failed: ${e.message || e}`);
        }
    };

    try {
        const body = req.body || {};
        const event = body.event;
        call = body.call || {};
        callId = call.call_id || body.call_id || '';
        const agentId = call.agent_id || body.agent_id || '';
        vars = call.retell_llm_dynamic_variables || {};
        inboundCallId = vars.inbound_call_id || vars.inboundCallId || '';
        // ServiceTrade config owner = the OUTBOUND dispatch agent's own id. Its
        // `servicetrade_tokens` + `servicetrade_job_configs` rows (per tenant) supply
        // the token/job config. No global env fallback — a missing row must fail loudly
        // (see the createJobFromCallContext catch below) rather than silently create the
        // job under some other tenant's ServiceTrade account.
        configAgentId = agentId;

        // Only the post-call analysis event carries servicetrade_job_created.
        if (event && event !== 'call_analyzed') {
            return sendSuccessResponse(res, { status: 'ignored', event }, `Event '${event}' not processed`, 200);
        }

        // Idempotency: skip a call we've already handled.
        if (callId && processedCalls.has(callId)) {
            return sendSuccessResponse(res, { status: 'duplicate', call_id: callId }, 'Call already processed', 200);
        }
        if (callId) processedCalls.set(callId, Date.now());

        const analysis = call.call_analysis || {};
        const custom = analysis.custom_analysis_data || {};
        const collected = call.collected_dynamic_variables || {};

        // Gate 1: a voicemail box is not a technician. The outbound agent classifies
        // this on the call itself (`reached_voicemail`), because the post-call analyzer
        // otherwise reads Clara's own voicemail message as engagement and flags the job
        // approved. Retell's native in_voicemail / disconnection_reason is the backstop
        // for when the agent misses it.
        //
        // NOT terminal: no client email and no escalation stop here. The chain keeps
        // dialing the next contact — GAS decides terminal state — but the row records
        // the voicemail as a job failure.
        const reachedVoicemail = normalizeBool(
            custom.reached_voicemail ??
            custom.reachedVoicemail ??
            collected.reached_voicemail
        );
        const voicemailDetected =
            reachedVoicemail === true ||
            analysis.in_voicemail === true ||
            String(call.disconnection_reason || '').toLowerCase() === 'voicemail_reached';

        if (voicemailDetected) {
            console.log(`[retell-outbound] voicemail detected (reached_voicemail: ${JSON.stringify(custom.reached_voicemail)}, in_voicemail: ${analysis.in_voicemail}, disconnection_reason: ${call.disconnection_reason}) — no job for call ${callId}, agent ${agentId}`);
            await notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.voicemail });
            return sendSuccessResponse(
                res,
                { status: 'skipped', reason: 'voicemail', call_id: callId },
                'Reached voicemail — no technician contact, no ServiceTrade job',
                200
            );
        }

        // Gate 2: create the job ONLY when the technician approved it on the call.
        const jobApproved = normalizeBool(
            custom.servicetrade_job_created ??
            custom.serviceTradeJobCreated ??
            collected.servicetrade_job_created
        );

        if (jobApproved !== true) {
            console.log(`[retell-outbound] servicetrade_job_created !== true (raw: ${JSON.stringify(custom.servicetrade_job_created)}) — no job for call ${callId}, agent ${agentId}`);
            await Promise.allSettled([
                notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.declined }),
                sendJobEmail('job_not_created', { reasonCode: 'tech_declined', reasonLabel: 'Technician Declined', reasonMessage: OUTCOMES.declined })
            ]);
            return sendSuccessResponse(
                res,
                { status: 'skipped', reason: 'not_approved', call_id: callId },
                'Technician did not approve a ServiceTrade job',
                200
            );
        }

        if (!configAgentId) {
            console.error(`[retell-outbound] approved but no outbound agent id on the call payload for call ${callId}`);
            await Promise.allSettled([
                notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.error }),
                alertInternal('No ServiceTrade config agent id available (call.agent_id missing from the outbound webhook payload)')
            ]);
            return sendSuccessResponse(
                res,
                { status: 'error', reason: 'no_st_config', call_id: callId },
                'Approved, but no ServiceTrade config agent id available',
                200
            );
        }

        let jobResult;
        try {
            jobResult = await createJobFromCallContext({
                agent_id: configAgentId,
                customer_name: vars.customer_name || vars.customerName,
                service_address: vars.customer_address || vars.service_address,
                from_number: vars.from_number || vars.fromNumber,
                call_summary: vars.call_summary || vars.callSummary,
                call_id: callId
            });
        } catch (createErr) {
            console.error(`[retell-outbound] job creation threw for call ${callId}: ${createErr.message || createErr}`);
            await Promise.allSettled([
                notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.error }),
                sendJobEmail('job_not_created', { reasonCode: 'internal_error', reasonLabel: 'Job Creation Error', reasonMessage: OUTCOMES.error }),
                alertInternal(createErr.message || String(createErr))
            ]);
            return sendErrorResponse(res, createErr.message || 'Job creation failed', 500);
        }

        if (jobResult.status === 'no_match') {
            console.error(`[retell-outbound] tech approved but no confident location match for call ${callId} (agent ${configAgentId})`);
            await Promise.allSettled([
                notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.no_match }),
                sendJobEmail('job_not_created', { reasonCode: 'no_matches', reasonLabel: 'No Location Match', reasonMessage: OUTCOMES.no_match })
            ]);
            return sendSuccessResponse(
                res,
                { status: 'no_match', call_id: callId },
                'Approved, but no confident ServiceTrade location match — manual follow-up needed',
                200
            );
        }

        const job = jobResult.job || {};
        const jobNumber = job.jobNumber || '';
        console.log(`[retell-outbound] job created for call ${callId}: location ${jobResult.matchedLocationName} (tier ${jobResult.matchTier}), job_number ${jobNumber}`);
        await Promise.allSettled([
            notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: true, jobNumber, outcome: OUTCOMES.created }),
            sendJobEmail('job_created', { jobId: job.jobId, jobUri: job.jobUri, jobNumber })
        ]);
        return sendSuccessResponse(
            res,
            { status: 'created', call_id: callId, ...jobResult },
            'ServiceTrade job created from outbound approval',
            201
        );
    } catch (error) {
        console.error('[retell-outbound] error:', error);
        await Promise.allSettled([
            notifySheet({ inboundCallId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.error }),
            sendJobEmail('job_not_created', { reasonCode: 'internal_error', reasonLabel: 'Job Creation Error', reasonMessage: OUTCOMES.error }),
            alertInternal(error.message || String(error))
        ]);
        return sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
