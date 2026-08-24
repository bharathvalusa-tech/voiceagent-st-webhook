const express = require('express');
const router = express.Router();
const config = require('../../config/environment');
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const emailNotificationService = require('../../services/emailNotificationService');
const supabaseService = require('../../services/supabaseService');

/**
 * POST /st-escalation-complete
 *
 * The single entry point for the Adaptive Climate consolidated client email.
 *
 * The Apps Script owns escalation state, so it decides WHEN an emergency is over —
 * it POSTs here once a row reaches escalation_complete = true AND has stopped
 * changing (i.e. no job_update is still in flight). This service owns HOW the email
 * is sent: recipients and the send/fail toggles come from the agent's Supabase
 * `servicetrade_tokens` row, exactly like every other job email.
 *
 * That split is why the Apps Script no longer talks to SendGrid for client mail, and
 * why /st-match-location no longer emails directly — one trigger, one email.
 *
 * Scoped by config.escalationEmailAgentIds. Tenants whose jobs are created on the
 * inbound post-call path must not reach this route; they email through their own.
 *
 * Always responds 200 (except on an unexpected throw) so the Apps Script never
 * retries a decision this service has already made.
 */

// Call ids whose client email has already been SENT by this instance.
//
// The Apps Script guards this too (`client_email_sent_<callId>` in ScriptProperties),
// but only once it has seen a 200. If SendGrid succeeds and the HTTP response is lost in
// transit, the guard is never set, the Apps Script backstop retries, and the client gets
// a second email. This closes that window on a warm instance.
//
// Recorded ONLY after a successful send. Recording on entry would be worse than nothing:
// a genuine SendGrid failure returns 500 so the Apps Script retries, and a pre-recorded
// id would swallow that retry and lose the email entirely.
const emailedCalls = new Map();
const EMAIL_DEDUPE_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of emailedCalls) {
        if (now - ts > EMAIL_DEDUPE_TTL_MS) emailedCalls.delete(id);
    }
}, 60 * 1000).unref();

// reason -> the reasonLabel/reasonMessage pair rendered in the failure email.
// Wording tracks the OUTCOMES strings in routes/webhook/retellOutbound.js so the
// sheet trail and the email never describe the same event differently.
const REASONS = {
    created: {
        label: 'Job Created',
        message: 'The technician approved the job and it was created in ServiceTrade.'
    },
    manual_review: {
        label: 'Manual Review Needed',
        message: 'A technician was reached but no ServiceTrade job was created — manual follow-up required.'
    },
    exhausted: {
        label: 'No Technician Reached',
        message: 'Every contact in the escalation chain was called and nobody answered — manual follow-up required.'
    },
    no_location_match: {
        label: 'No Location Match',
        message: 'The service address could not be matched to a ServiceTrade location, so no dispatch call was placed.'
    },
    inactive_location: {
        label: 'Inactive ServiceTrade Location',
        message: 'The service address matches a location marked INACTIVE in ServiceTrade. Dispatch went ahead and the technician was told on the call — please review the location record.'
    },
    no_address: {
        label: 'No Service Address',
        message: 'The call ended before a service address was captured, so no dispatch call was placed.'
    }
};

router.post('/st-escalation-complete', async (req, res) => {
    try {
        const body = req.body || {};

        const agentId = body.agent_id || body.agentId || '';
        const callId = body.inbound_call_id || body.call_id || '';
        const reason = String(body.reason || 'manual_review');
        const isJobCreated = body.is_job_created === true || body.is_job_created === 'true';
        const jobResultMissing = body.job_result_missing === true || body.job_result_missing === 'true';
        // Sheet column AD. Drives the [Inactive Location] subject prefix and the flag card
        // on both templates — an inactive location no longer blocks anything, so this is
        // the only thing that makes it visible.
        const locationStatus = String(body.location_status || '').trim().toLowerCase();

        console.log('st-escalation-complete received', {
            agentId,
            callId,
            reason,
            isJobCreated,
            jobResultMissing,
            locationStatus
        });

        if (!agentId) {
            return sendErrorResponse(res, 'agent_id is required', 400);
        }

        // Separation of concerns: this route serves the escalation flow only.
        if (!config.escalationEmailAgentIds.includes(agentId)) {
            console.log(`[st-escalation-complete] agent ${agentId} is not escalation-email enabled — ignoring`);
            return sendSuccessResponse(
                res,
                { status: 'ignored', reason: 'agent_not_enabled', agent_id: agentId },
                'Agent is not enabled for escalation emails',
                200
            );
        }

        if (callId && emailedCalls.has(callId)) {
            console.log(`[st-escalation-complete] ${callId} already emailed by this instance — ignoring`);
            return sendSuccessResponse(
                res,
                { status: 'duplicate', call_id: callId },
                'Escalation email already sent for this call',
                200
            );
        }

        const rows = await supabaseService.getServiceTradeToken(agentId);
        const settings = (rows && rows[0]) || {};

        const meta = REASONS[reason] || REASONS.manual_review;

        // The client email is gated inside sendJobNotification by send_job_email, and
        // additionally by send_job_fail_email when the outcome is a failure. Both live
        // on the agent's servicetrade_tokens row, so per-tenant config still rules.
        const result = await emailNotificationService.sendJobNotification({
            settings,
            outcome: isJobCreated ? 'job_created' : 'job_not_created',
            details: {
                agentId,
                callId,
                customerName: body.customer_name,
                callerPhone: body.from_number,
                serviceAddress: body.service_address,
                issueDescription: body.call_summary,
                callSummary: body.call_summary,
                jobNumber: body.job_number || '',
                priority: 'Emergency',
                timestamp: body.timestamp || Date.now(),
                reasonCode: reason,
                reasonLabel: meta.label,
                reasonMessage: meta.message,
                // WS-6: the escalation history. The trail is column AA verbatim; the call
                // ids let the template pull each dispatch call's summary, recording and
                // transcript from Retell.
                outcomeTrail: body.outcome_trail || '',
                escalationCallIds: Array.isArray(body.response_call_ids) ? body.response_call_ids : [],
                locationStatus,
                locationName: body.location_matched_name || '',
                matchedAddress: body.location_matched_address || '',
                topCandidates: []
            }
        });

        // The Apps Script gave up waiting for a job result. The client email still goes
        // (it may lack a job number), but staff need to know the write-back path failed.
        if (jobResultMissing) {
            await emailNotificationService.sendInternalAlert({
                callId,
                agentId,
                companyName: settings.Name,
                errorType: 'Escalation completed without a job result',
                errorMessage: `No job_update was ever received for inbound call ${callId}. The escalation email was sent from the Apps Script backstop, so the outbound webhook write-back may be failing.`
            }).catch((e) => console.error('[st-escalation-complete] internal alert failed:', e.message || e));
        }

        // Recorded only now, after the send actually succeeded. A skipped send
        // (notifications disabled, no recipients) is not recorded either — nothing went
        // out, so a later retry should be allowed to try again.
        if (callId && result && result.sent) emailedCalls.set(callId, Date.now());

        return sendSuccessResponse(
            res,
            { status: 'ok', call_id: callId, email: result },
            'Escalation complete processed',
            200
        );
    } catch (error) {
        console.error('Error in st-escalation-complete route:', error);
        return sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
