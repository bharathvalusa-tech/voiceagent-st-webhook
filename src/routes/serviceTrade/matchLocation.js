const express = require('express');
const router = express.Router();
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const { matchLocationFromCallContext } = require('../../services/contextJobService');

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
 * - agent_id (or inbound_agent_id), else falls back to ST_CONTEXT_DEFAULT_AGENT_ID
 * - one of from_number / service_address (needed to match a location)
 *
 * Optional: customer_name, location_name, company_name
 *
 * Always responds 200 with { matched: boolean, locationId, locationName, tier }.
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

        const agent_id = pick('agent_id', 'inbound_agent_id') || process.env.ST_CONTEXT_DEFAULT_AGENT_ID;
        const customer_name = pick('customer_name', 'caller_name', 'name');
        const service_address = pick('service_address', 'customer_address', 'address');
        const from_number = pick('from_number', 'caller_phone', 'phone');
        const location_name = pick('location_name');
        const company_name = pick('company_name');

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
        return sendSuccessResponse(
            res,
            {
                matched,
                locationId: matched ? outcome.locationId : null,
                locationName: matched ? outcome.locationName : null,
                tier: matched ? outcome.tier : null
            },
            matched ? 'Confident location match found' : 'No confident location match',
            200
        );
    } catch (error) {
        console.error('Error in st-match-location route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
