const { createJob, getAuthToken } = require('../controllers/serviceTradeController');
const { findCustomerWithConfidence } = require('./customerMatchingService');

/**
 * Resolve a ServiceTrade location from raw call context and create a job.
 *
 * Shared by:
 *  - the (deprecated) POST /st-create-job-from-context route, and
 *  - the outbound post-call webhook handler (POST /webhook/retell-outbound),
 *    which calls this only after the technician approved the job on the call
 *    (servicetrade_job_created === true).
 *
 * The job is created under the ORIGINAL inbound agent's ServiceTrade config, so
 * `agent_id` must be that inbound agent's id (the outbound dispatch agent has
 * no config of its own).
 *
 * @param {Object} fields
 * @param {string} fields.agent_id        inbound agent id owning the ST token/config (required)
 * @param {string} [fields.customer_name]
 * @param {string} [fields.service_address]
 * @param {string} [fields.from_number]
 * @param {string} [fields.call_summary]  verbatim issue text — used as the job description
 * @param {string} [fields.call_id]
 * @param {string} [fields.location_name]
 * @param {string} [fields.company_name]
 * @returns {Promise<{status:'created', job:Object, matchedLocationId:*, matchedLocationName:*, matchTier:*}
 *                   | {status:'no_match'}>}
 * Throws only on unexpected errors (auth/network); the caller decides how to surface those.
 */
async function createJobFromCallContext(fields) {
    const {
        agent_id,
        customer_name,
        service_address,
        from_number,
        call_summary,
        call_id,
        location_name,
        company_name
    } = fields || {};

    if (!agent_id) {
        throw new Error('agent_id is required to create a job from call context');
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

    // Pick a confident match: any Tier 1, or a Tier 2 that resolves to a single
    // unambiguous location. Anything less → don't guess, report no match.
    let selected = candidates.find((c) => c.tier === 1 && c.locationId);
    if (!selected) {
        const tier2 = candidates.filter((c) => c.tier === 2 && c.locationId);
        const uniqueLocationIds = [...new Set(tier2.map((c) => c.locationId))];
        if (tier2.length > 0 && uniqueLocationIds.length === 1) {
            selected = tier2[0];
        }
    }

    if (!selected) {
        return { status: 'no_match' };
    }

    // Preserve the caller's/alarm's issue text verbatim in the job description.
    const name = (customer_name || '').trim() || 'Unknown person';
    const phonePart = from_number ? ` (${from_number})` : '';
    const issue = (call_summary || '').trim() || 'emergency service request';
    const description = `[EMERGENCY - TECH APPROVED]: ${name}${phonePart} reported ${issue}`;

    const job = await createJob(
        {
            locationId: selected.locationId,
            description,
            callerPhoneNumber: from_number || null,
            call_id: call_id || null
        },
        agent_id
    );

    return {
        status: 'created',
        job,
        matchedLocationId: selected.locationId,
        matchedLocationName: selected.locationName,
        matchTier: selected.tier
    };
}

module.exports = { createJobFromCallContext };
