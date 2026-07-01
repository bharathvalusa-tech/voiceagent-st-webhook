const express = require('express');
const router = express.Router();
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const { createJob, getAuthToken } = require('../../controllers/serviceTradeController');
const { findCustomerWithConfidence } = require('../../services/customerMatchingService');

/**
 * POST /st-create-job-from-context
 *
 * Creates a ServiceTrade job from raw call context (no pre-resolved locationId).
 * Used by the outbound technician escalation flow (Google Apps Script): once the
 * on-call technician approves a job on the outbound call, the script POSTs the
 * customer context here and we resolve the location + create the job.
 *
 * The job is created under the ORIGINAL inbound agent's ServiceTrade config, so
 * pass that agent's id as `agent_id` (the outbound dispatch agent has no config).
 *
 * Required:
 * - agent_id: inbound agent id that owns the ServiceTrade token + job config
 * - one of from_number / service_address (needed to match a location)
 *
 * Optional: customer_name, service_address, from_number, call_summary, call_id,
 *           location_name, company_name
 */
router.post('/st-create-job-from-context', async (req, res) => {
    try {
        // Retell custom tools deliver this payload in a few shapes depending on how
        // the tool is configured in the dashboard:
        //   - fields at the body root      (args_at_root = true, or a `body` template)
        //   - fields nested under `args`    (args_at_root = false — the Retell default)
        //   - `args` occasionally arrives as a JSON string
        // Field names also differ between the outbound agent and this endpoint
        // (inbound_agent_id -> agent_id, customer_address -> service_address).
        // Flatten everything into one view and read via aliases so any shape works
        // without having to re-import/rewire the agent.
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
        const call_summary = pick('call_summary', 'callSummary');
        const call_id = pick('call_id');
        const location_name = pick('location_name');
        const company_name = pick('company_name');

        console.log('st-create-job-from-context received', {
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

        // Validates/refreshes the stored PHPSESSID and returns a usable token.
        const authToken = await getAuthToken(agent_id);

        const candidates = await findCustomerWithConfidence(authToken, {
            phone: from_number,
            name: customer_name,
            address: service_address,
            locationName: location_name,
            companyName: company_name
        });

        // Pick a confident match: any Tier 1, or a Tier 2 that resolves to a
        // single unambiguous location. Anything less → don't guess, report back.
        let selected = candidates.find((c) => c.tier === 1 && c.locationId);
        if (!selected) {
            const tier2 = candidates.filter((c) => c.tier === 2 && c.locationId);
            const uniqueLocationIds = [...new Set(tier2.map((c) => c.locationId))];
            if (tier2.length > 0 && uniqueLocationIds.length === 1) {
                selected = tier2[0];
            }
        }

        if (!selected) {
            return sendErrorResponse(
                res,
                'No confident location match found for provided context',
                422
            );
        }

        const name = (customer_name || '').trim() || 'Unknown person';
        const phonePart = from_number ? ` (${from_number})` : '';
        const issue = (call_summary || '').trim() || 'emergency service request';
        const description = `[EMERGENCY - TECH APPROVED]: ${name}${phonePart} reported ${issue}`;

        const result = await createJob(
            {
                locationId: selected.locationId,
                description,
                callerPhoneNumber: from_number || null,
                call_id: call_id || null
            },
            agent_id
        );

        return sendSuccessResponse(
            res,
            {
                ...result,
                matchedLocationId: selected.locationId,
                matchedLocationName: selected.locationName,
                matchTier: selected.tier
            },
            'Job created successfully from context',
            201
        );
    } catch (error) {
        console.error('Error in st-create-job-from-context route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
