const express = require('express');
const router = express.Router();
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const { matchLocationFromCallContext } = require('../../services/contextJobService');
const { openEscalationChain } = require('../../services/escalationStore');

/**
 * POST /st-match-location
 *
 * Pre-flight location check for the Adaptive escalation flow. Given raw call
 * context, resolves whether a CONFIDENT ServiceTrade location match exists —
 * WITHOUT creating a job. The GAS escalation loop calls this before placing the
 * first outbound dispatch call.
 *
 * An INACTIVE location is still a match. Deactivation is a ServiceTrade bookkeeping
 * state, not a judgement about whether the emergency is real, so it does not block
 * the dispatch call or the job — it is reported as `status: 'inactive'` and flagged
 * to the technician, the outcome trail and the client email instead. Only 'none'
 * (nothing to create a job against) stops the escalation.
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
 *     matched: boolean,                 // true for BOTH 'matched' and 'inactive' — a
 *                                       // location was resolved and dispatch proceeds
 *     locationId, locationName,         // set whenever a location resolved
 *     locationStatus: 'active'|'inactive',
 *     tier,                             // set whenever a location resolved
 *     inactiveLocationName,             // set for 'inactive' (the deactivated location's name)
 *     matchedAddress }                  // constructed street/city/state/postal
 * The route sends no email on any verdict.
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
            callId: call_id || null,
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

        const found = outcome.status === 'matched';
        const inactive = found && outcome.locationStatus === 'inactive';

        // NOTE: this route sends NO email, on any verdict.
        //
        // It used to fire a job-fail email on an inactive hit, which made it a second
        // entry point into the notification service. GAS notifies
        // POST /st-escalation-complete when the row reaches a terminal state, and the
        // escalation email has exactly one trigger — escalation_complete = true — and
        // exactly one sender. This endpoint's only job is the verdict.

        const status = inactive ? 'inactive' : (found ? 'matched' : 'none');

        // Open the dashboard's escalation record. This gate is the last thing that runs
        // before the first dial and only for a row that is genuinely escalating, so it is
        // also the honest answer to "did an escalation happen at all". Awaited so a
        // dispatch call can never be recorded before the chain it belongs to; it swallows
        // its own failures, so it cannot hold up or fail the verdict.
        await openEscalationChain({
            agentId: agent_id,
            inboundCallId: call_id,
            locationStatus: found ? (outcome.locationStatus || 'active') : 'none'
        });

        return sendSuccessResponse(
            res,
            {
                status,
                // `matched` means "a location was resolved and dispatch should proceed".
                // An inactive location resolves and dispatches, so it is true here too —
                // the distinction lives in `status` / `locationStatus`.
                matched: found,
                locationId: found ? (outcome.locationId || null) : null,
                locationName: found ? (outcome.locationName || null) : null,
                locationStatus: found ? (outcome.locationStatus || 'active') : null,
                tier: found ? outcome.tier : null,
                inactiveLocationName: inactive ? (outcome.locationName || null) : null,
                matchedAddress: found ? (outcome.matchedAddress || null) : null
            },
            inactive
                ? 'Matches an INACTIVE ServiceTrade location — dispatch proceeds, flagged for office review'
                : (found ? 'Confident location match found' : 'No confident location match'),
            200
        );
    } catch (error) {
        console.error('Error in st-match-location route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
