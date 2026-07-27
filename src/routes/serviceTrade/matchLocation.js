const express = require('express');
const router = express.Router();
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const { matchLocationFromCallContext } = require('../../services/contextJobService');
const emailNotificationService = require('../../services/emailNotificationService');
const supabaseService = require('../../services/supabaseService');

/**
 * POST /st-match-location
 *
 * Pre-flight location check for the Adaptive escalation flow. Given raw call
 * context, resolves whether a CONFIDENT ServiceTrade location match exists —
 * WITHOUT creating a job. The GAS escalation loop calls this before placing the
 * first outbound dispatch call, so we never bother the on-call technician for an
 * address that would only fail job creation afterwards.
 *
 * Uses the exact same matcher (matchLocationFromCallContext) that the post-call
 * job creation uses, so this verdict and the eventual create verdict can't drift.
 *
 * Required:
 * - agent_id (or inbound_agent_id) — the ServiceTrade config owner. For Adaptive the
 *   GAS gate passes the OUTBOUND dispatch agent id (CONFIG.RETELL_AGENT_ID) so this
 *   resolves the same row the post-call job creation will use. No global default.
 * - one of from_number / service_address (needed to match a location)
 *
 * Optional: customer_name, location_name, company_name
 *
 * Always responds 200 with:
 *   { status: 'matched' | 'inactive' | 'none',
 *     matched: boolean,                 // true only when status==='matched'
 *     locationId, locationName,         // set for 'matched' and 'inactive'
 *     tier,                             // set for 'matched'
 *     inactiveLocationName,             // set for 'inactive' (the deactivated location's name)
 *     matchedAddress }                  // set for 'inactive' (constructed street/city/state/postal)
 * On 'inactive' the route also fires a best-effort job-fail email (non-blocking).
 */
router.post('/st-match-location', async (req, res) => {
    try {
        // Same payload-shape tolerance as /st-create-job-from-context: fields may
        // arrive at the body root or nested under `args` (occasionally a JSON
        // string), with a few name aliases. Flatten and read via aliases.
        const body = req.body || {};
        let nested = body.args;
        if (typeof nested === 'string') {
            try { nested = JSON.parse(nested); } catch (e) { nested = null; }
        }
        const src = { ...body, ...(nested && typeof nested === 'object' ? nested : {}) };

        const pick = (...keys) => {
            for (const key of keys) {
                const value = src[key];
                if (value !== undefined && value !== null && String(value).trim() !== '') {
                    return value;
                }
            }
            return undefined;
        };

        const agent_id = pick('agent_id', 'inbound_agent_id');
        const customer_name = pick('customer_name', 'caller_name', 'name');
        const service_address = pick('service_address', 'customer_address', 'address');
        const from_number = pick('from_number', 'caller_phone', 'phone');
        const location_name = pick('location_name');
        const company_name = pick('company_name');
        const call_id = pick('call_id', 'inbound_call_id');

        console.log('st-match-location received', {
            payloadKeys: Object.keys(src),
            hasAgentId: Boolean(agent_id),
            fromNumber: from_number || null,
            hasServiceAddress: Boolean(service_address)
        });

        if (!agent_id) {
            return sendErrorResponse(res, 'agent_id (or inbound_agent_id) is required', 400);
        }
        if (!from_number && !service_address) {
            return sendErrorResponse(res, 'from_number or service_address is required', 400);
        }

        const outcome = await matchLocationFromCallContext({
            agent_id,
            customer_name,
            service_address,
            from_number,
            location_name,
            company_name
        });

        const matched = outcome.status === 'matched';
        const inactive = outcome.status === 'inactive_match';

        // Inactive-location hit: the address is a KNOWN-but-deactivated location.
        // Never create a job / escalate — fire the job-fail email (gated by
        // send_job_fail_email) so the client + internal CC are alerted. Fire-and-forget:
        // this endpoint sits on the GAS escalation gate (called synchronously before the
        // first dispatch call), so we must NOT block the verdict on Supabase/SendGrid.
        // The detached promise handles its own errors and never rejects the request.
        if (inactive) {
            Promise.resolve()
                .then(async () => {
                    const rows = await supabaseService.getServiceTradeToken(agent_id);
                    const settings = (rows && rows[0]) || {};
                    await emailNotificationService.sendJobNotification({
                        settings,
                        outcome: 'job_not_created',
                        details: {
                            agentId: agent_id,
                            callId: call_id || '',
                            customerName: customer_name,
                            callerPhone: from_number,
                            serviceAddress: service_address,
                            priority: 'Emergency',
                            reasonCode: 'inactive_location',
                            reasonLabel: 'Address Inactive in ServiceTrade',
                            reasonMessage: `The service address matches a location marked INACTIVE in ServiceTrade${outcome.locationName ? ` ("${outcome.locationName}")` : ''}. No job or dispatch — manual follow-up required.`,
                            topCandidates: []
                        }
                    });
                })
                .catch((e) => console.error('st-match-location: inactive job-fail email failed:', e.message || e));
        }

        const status = matched ? 'matched' : (inactive ? 'inactive' : 'none');
        return sendSuccessResponse(
            res,
            {
                status,
                matched,
                locationId: (matched || inactive) ? (outcome.locationId || null) : null,
                locationName: (matched || inactive) ? (outcome.locationName || null) : null,
                tier: matched ? outcome.tier : null,
                inactiveLocationName: inactive ? (outcome.locationName || null) : null,
                matchedAddress: inactive ? (outcome.matchedAddress || null) : null
            },
            matched
                ? 'Confident location match found'
                : (inactive
                    ? 'Address matches an INACTIVE ServiceTrade location — job/dispatch blocked'
                    : 'No confident location match'),
            200
        );
    } catch (error) {
        console.error('Error in st-match-location route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
