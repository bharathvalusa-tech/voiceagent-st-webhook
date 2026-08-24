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
    // The technician answered and approved, but the address is on no ServiceTrade
    // location — POST /job requires a locationId, so there is nothing to create the job
    // against. Terminal, and the office email has to say what is needed of a human.
    no_match: 'no job created — tech APPROVED but the address is on no ServiceTrade location; create the job manually',
    error: 'no job — error creating job',
    // A deactivated ServiceTrade location does NOT block the job — the technician was
    // told on the dispatch call and approved anyway. These lines exist so the sheet, the
    // client email and the office all see the flag without having to look it up.
    created_inactive: 'job created on an INACTIVE ServiceTrade location — tech approved; office review needed',
    declined_inactive: 'no job — tech declined (INACTIVE ServiceTrade location)',
    declined_unmatched: 'no job — tech declined (address NOT on file in ServiceTrade)',
    inactive_job_failed: 'no job — ServiceTrade rejected the job on an INACTIVE location; manual follow-up needed',
    // A voicemail box answered instead of a person. NOT terminal — the escalation
    // chain must keep dialing the next contact — but it IS a job failure for the
    // row's metrics, so it gets its own trail line.
    voicemail: 'no job — reached voicemail; no technician contact',
    // Nobody picked up at all. Also NOT terminal, and distinct from `declined`:
    // `declined` now means a HUMAN answered and said no, which ends the chain.
    no_answer: 'no job — no answer; nobody reached'
};

// Disconnection reasons that mean the call was never answered by a person. Mirrors
// the NO_ANSWER set in the Apps Script `classifyCall`, so the webhook and the sheet
// agree on what "nobody was reached" means.
const NO_ANSWER_REASONS = new Set([
    'dial_no_answer', 'dial_busy', 'dial_failed', 'invalid_destination',
    'registered_call_timeout', 'marked_as_spam', 'sip_routing_error',
    'telephony_provider_permission_denied', 'telephony_provider_unavailable',
    'user_declined', 'concurrency_limit_reached', 'no_concurrency_fallback',
    'no_valid_payment', 'scam_detected'
]);

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
// .unref() so this timer never holds the event loop open, matching retell.js:22. Without
// it the process cannot exit on its own — a test run hangs forever and a serverless
// instance is kept alive by a cache sweep that has nothing to sweep.
setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of processedCalls) {
        if (now - ts > IDEMPOTENCY_TTL_MS) processedCalls.delete(id);
    }
}, 60 * 1000).unref();

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
async function notifySheet({ inboundCallId, outboundCallId, isJobCreated, jobNumber, outcome, terminal = false, locationStatus = '' }) {
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
        outcome: outcome || '',
        // Whether this result ENDS the escalation chain. Decided here because only
        // this handler can tell "a human answered and declined" (terminal) from
        // "voicemail" or "nobody picked up" (keep escalating) — all three arrive with
        // servicetrade_job_created = false. Previously GAS had to infer terminality by
        // pattern-matching the outcome wording, which could not make that distinction.
        terminal: Boolean(terminal),
        // 'active' | 'inactive' | '' — the verdict from the ADDRESS at job time, which
        // outranks the pre-flight gate's verdict on the sheet. Sent only when this
        // handler actually resolved a location; blank means "no new information, keep
        // whatever the row already has".
        location_status: locationStatus || ''
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

        // The pre-flight verdict GAS injected when it placed this dispatch call. Read
        // here so a DECLINE can be labelled correctly without a second ServiceTrade
        // round-trip — the decline path never resolves a location of its own. On the
        // approve path the freshly-resolved status wins, since it is what the job is
        // actually created against.
        const dialledInactive = normalizeBool(vars.inactive_address) === true;
        // Same source, same reason: GAS sets this when the gate returned 'none', so a
        // decline on an address that is on no ServiceTrade location is labelled without
        // re-resolving anything. On the approve path the location lookup runs for real
        // and its `no_match` verdict is what counts.
        const dialledUnmatched = normalizeBool(vars.unmatched_address) === true;

        // The gates run in this order, and the order is deliberate:
        //   1. nobody answered   2. voicemail   3a. human approved   3b. human declined
        //
        // 1 and 2 both mean "no technician was reached", so neither creates a job and
        // neither is terminal — the chain keeps dialing. They can BOTH look true on the
        // same call (the analyzer flags reached_voicemail while telephony reports the
        // dial as unanswered), so no-answer is checked first and wins the label: what
        // the carrier reports about the connection outranks what the analyzer inferred
        // from a transcript that may not exist.

        // Gate 1: nobody picked up. Retell still fires call_analyzed for a call that
        // rang out, and it arrives with servicetrade_job_created = false because there
        // was no human and the job question was never asked. Without this gate that is
        // indistinguishable from a technician declining, and the chain would end after
        // the first unanswered call instead of escalating to the next contact.
        //
        // disconnection_reason is used rather than a post-call variable because there is
        // no transcript to infer from on these calls. `voicemail_reached` is deliberately
        // NOT in NO_ANSWER_REASONS — it belongs to gate 2.
        const disconnectionReason = String(call.disconnection_reason || '').toLowerCase();
        const nobodyAnswered =
            NO_ANSWER_REASONS.has(disconnectionReason) ||
            disconnectionReason.startsWith('error_') ||
            ['not_connected', 'error'].includes(String(call.call_status || '').toLowerCase());

        if (nobodyAnswered) {
            console.log(`[retell-outbound] no answer (call_status: ${call.call_status}, disconnection_reason: ${call.disconnection_reason}) — no job for call ${callId}, agent ${agentId}; escalation continues`);
            await notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.no_answer, terminal: false });
            return sendSuccessResponse(
                res,
                { status: 'skipped', reason: 'no_answer', call_id: callId },
                'Nobody answered — no ServiceTrade job, escalation continues',
                200
            );
        }

        // Gate 2: a voicemail box is not a technician. The outbound agent classifies this
        // on the call itself (`reached_voicemail`), because the post-call analyzer
        // otherwise reads Clara's own voicemail message as engagement and flags the job
        // approved. Retell's native in_voicemail / voicemail_reached is the backstop for
        // when the agent misses it.
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
            disconnectionReason === 'voicemail_reached';

        if (voicemailDetected) {
            console.log(`[retell-outbound] voicemail detected (reached_voicemail: ${JSON.stringify(custom.reached_voicemail)}, in_voicemail: ${analysis.in_voicemail}, disconnection_reason: ${call.disconnection_reason}) — no job for call ${callId}, agent ${agentId}; escalation continues`);
            await notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.voicemail, terminal: false });
            return sendSuccessResponse(
                res,
                { status: 'skipped', reason: 'voicemail', call_id: callId },
                'Reached voicemail — no technician contact, no ServiceTrade job',
                200
            );
        }

        // Gate 3: a human answered. Create the job ONLY when they approved it. Either
        // way this call ENDS the escalation chain — someone was reached and gave an
        // answer, so dialing further contacts about the same emergency is pointless.
        const jobApproved = normalizeBool(
            custom.servicetrade_job_created ??
            custom.serviceTradeJobCreated ??
            collected.servicetrade_job_created
        );

        if (jobApproved !== true) {
            console.log(`[retell-outbound] technician answered but did not approve a job (raw: ${JSON.stringify(custom.servicetrade_job_created)}) — call ${callId}, agent ${agentId}; escalation ends`);
            // 'inactive' first: an address can only be one of the two, and the gate
            // reports 'inactive' when it resolved a location at all.
            const declinedOutcome = dialledInactive
                ? OUTCOMES.declined_inactive
                : (dialledUnmatched ? OUTCOMES.declined_unmatched : OUTCOMES.declined);
            const declinedLabel = dialledInactive
                ? 'Technician Declined (Inactive Location)'
                : (dialledUnmatched ? 'Technician Declined (Address Not On File)' : 'Technician Declined');
            // Leave column AD alone on a decline unless the gate said 'inactive'. A row
            // dialled as 'none' must KEEP 'none' — handleJobUpdate only overwrites on
            // 'active'/'inactive', so sending 'none' here would be ignored anyway, and
            // sending '' preserves what the gate wrote.
            const declinedSheetStatus = dialledInactive ? 'inactive' : '';
            await Promise.allSettled([
                notifySheet({
                    inboundCallId,
                    outboundCallId: callId,
                    isJobCreated: false,
                    jobNumber: '',
                    outcome: declinedOutcome,
                    terminal: true,
                    locationStatus: declinedSheetStatus
                }),
                sendJobEmail('job_not_created', {
                    reasonCode: 'tech_declined',
                    reasonLabel: declinedLabel,
                    reasonMessage: declinedOutcome,
                    locationStatus: dialledInactive ? 'inactive' : (dialledUnmatched ? 'none' : 'active')
                })
            ]);
            return sendSuccessResponse(
                res,
                { status: 'skipped', reason: 'not_approved', call_id: callId },
                'Technician did not approve a ServiceTrade job — escalation complete',
                200
            );
        }

        if (!configAgentId) {
            console.error(`[retell-outbound] approved but no outbound agent id on the call payload for call ${callId}`);
            await Promise.allSettled([
                notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.error, terminal: true }),
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
            // A ServiceTrade refusal on a deactivated location is its own story, not a
            // generic bug: the technician said yes, we tried, and the platform said no.
            // It gets its own outcome so the office can tell it apart from an outage.
            const rejectedForInactive = dialledInactive;
            const errOutcome = rejectedForInactive ? OUTCOMES.inactive_job_failed : OUTCOMES.error;
            await Promise.allSettled([
                notifySheet({
                    inboundCallId,
                    outboundCallId: callId,
                    isJobCreated: false,
                    jobNumber: '',
                    outcome: errOutcome,
                    terminal: true,
                    locationStatus: rejectedForInactive ? 'inactive' : ''
                }),
                sendJobEmail('job_not_created', {
                    reasonCode: rejectedForInactive ? 'inactive_location_rejected' : 'internal_error',
                    reasonLabel: rejectedForInactive ? 'ServiceTrade Rejected the Inactive Location' : 'Job Creation Error',
                    reasonMessage: errOutcome,
                    locationStatus: rejectedForInactive ? 'inactive' : 'active'
                }),
                alertInternal(createErr.message || String(createErr))
            ]);
            return sendErrorResponse(res, createErr.message || 'Job creation failed', 500);
        }

        if (jobResult.status === 'no_match') {
            // The expected end of the unmatched-address path, not an anomaly: the gate
            // dialled anyway, the technician was told the address is not on file, and
            // they said yes. There is still no locationId to create a job against, so
            // this ends the chain and asks a human for the one thing only a human can
            // do. Their consent is recorded in the outcome trail and the email.
            console.error(`[retell-outbound] tech approved but no confident location match for call ${callId} (agent ${configAgentId})${dialledUnmatched ? ' — dialled with the address flagged as not on file' : ''}`);
            await Promise.allSettled([
                notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.no_match, terminal: true }),
                sendJobEmail('job_not_created', {
                    reasonCode: 'no_matches',
                    reasonLabel: 'Technician Approved — No Location On File',
                    reasonMessage: OUTCOMES.no_match,
                    locationStatus: 'none'
                })
            ]);
            return sendSuccessResponse(
                res,
                { status: 'no_match', call_id: callId, tech_approved: true },
                'Technician approved, but the address is on no ServiceTrade location — create the job manually',
                200
            );
        }

        const job = jobResult.job || {};
        const jobNumber = job.jobNumber || '';
        // The status resolved from the ADDRESS at job time wins over the pre-flight
        // verdict — it is the location the job was actually created against.
        const createdInactive = jobResult.locationStatus === 'inactive';
        console.log(`[retell-outbound] job created for call ${callId}: location ${jobResult.matchedLocationName} (tier ${jobResult.matchTier}, status ${jobResult.locationStatus}), job_number ${jobNumber}`);
        await Promise.allSettled([
            notifySheet({
                inboundCallId,
                outboundCallId: callId,
                isJobCreated: true,
                jobNumber,
                outcome: createdInactive ? OUTCOMES.created_inactive : OUTCOMES.created,
                terminal: true,
                locationStatus: jobResult.locationStatus || 'active'
            }),
            sendJobEmail('job_created', {
                jobId: job.jobId,
                jobUri: job.jobUri,
                jobNumber,
                locationStatus: jobResult.locationStatus || 'active',
                locationName: jobResult.matchedLocationName || '',
                matchedAddress: jobResult.matchedAddress || ''
            })
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
            // terminal: true, matching every other error branch. Omitting it defaulted to
            // false, which left the escalation chain live in the sheet after an
            // unexpected throw — the row kept dialling with no result ever landing.
            notifySheet({ inboundCallId, outboundCallId: callId, isJobCreated: false, jobNumber: '', outcome: OUTCOMES.error, terminal: true }),
            sendJobEmail('job_not_created', { reasonCode: 'internal_error', reasonLabel: 'Job Creation Error', reasonMessage: OUTCOMES.error }),
            alertInternal(error.message || String(error))
        ]);
        return sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
