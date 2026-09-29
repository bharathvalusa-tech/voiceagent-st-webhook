const { createJob, getAuthToken } = require('../controllers/serviceTradeController');
const { findCustomerWithConfidence } = require('./customerMatchingService');
const serviceTradeService = require('./serviceTradeService');

/**
 * The location the CALLER confirmed out loud, resolved straight from its id.
 *
 * WHY IT SHORT-CIRCUITS THE MATCHER. /st-inbound-lookup and /st-verify-customer read the
 * address back to the caller and the caller said yes. Re-deriving a location from a
 * transcribed address afterwards can only ever agree with that or contradict it, and a
 * contradiction sends the van somewhere the caller never named. Braconier already works
 * this way (retell.js:1037-1056); this is the same rule on the Adaptive path.
 *
 * WHY IT STILL COSTS A REQUEST. The gate and the job both need `status` — an inactive
 * site is dispatched but flagged everywhere (matchLocation.js:15-19) — and the id alone
 * does not carry it. GET /location/{id} is one read and this path runs once per escalation.
 *
 * Returns null when the id is unusable or the read fails, and the caller falls back to the
 * full matcher. A confirmed id must never be able to LOSE a dispatch that address matching
 * would have won.
 */
async function resolveConfirmedLocation(authToken, locationId) {
    const id = String(locationId || '').trim();
    if (!id) return null;

    try {
        const location = await serviceTradeService.getLocationById(authToken, id);
        if (!location || !location.id) {
            console.warn(`[context-job] confirmed location ${id} not found — falling back to matching`);
            return null;
        }

        const a = location.address || {};
        return {
            status: 'matched',
            locationId: location.id,
            locationName: location.name || '',
            tier: 1,
            tierReason: 'location confirmed by the caller during the call',
            locationStatus: location.status === 'inactive' ? 'inactive' : 'active',
            matchedAddress: [a.street, a.city, a.state, a.postalCode]
                .map((part) => String(part || '').trim())
                .filter(Boolean)
                .join(', ')
        };
    } catch (error) {
        console.error(`[context-job] confirmed location ${id} lookup failed: ${error.message || error} — falling back to matching`);
        return null;
    }
}

/**
 * Resolve a confident ServiceTrade location from raw call context — WITHOUT
 * creating a job. Shared by createJobFromCallContext (below) and the match-only
 * POST /st-match-location route, so a pre-flight gate and the eventual job
 * creation can never disagree about whether a location matches.
 *
 * The lookup runs under the ORIGINAL inbound agent's ServiceTrade config, so
 * `agent_id` must be that inbound agent's id (the outbound dispatch agent has
 * no config of its own).
 *
 * @param {Object} fields
 * @param {string} fields.agent_id        inbound agent id owning the ST token/config (required)
 * @param {string} [fields.customer_name]
 * @param {string} [fields.service_address]
 * @param {string} [fields.from_number]
 * @param {string} [fields.location_name]
 * @param {string} [fields.company_name]
 * @param {string} [fields.location_id]   ServiceTrade location id the caller confirmed on
 *                                        the inbound call; short-circuits the matcher
 * @returns {Promise<{status:'matched', locationId:*, locationName:*, tier:*,
 *                    locationStatus:'active'|'inactive', matchedAddress:string}
 *                   | {status:'no_match'}>}
 * Throws only on unexpected errors (auth/network); the caller decides how to surface those.
 */
async function matchLocationFromCallContext(fields) {
    const {
        agent_id,
        customer_name,
        service_address,
        from_number,
        location_name,
        company_name,
        location_id
    } = fields || {};

    if (!agent_id) {
        throw new Error('agent_id is required to match a location from call context');
    }

    // Validates/refreshes the stored PHPSESSID and returns a usable token.
    const authToken = await getAuthToken(agent_id);

    const confirmed = await resolveConfirmedLocation(authToken, location_id);
    if (confirmed) {
        console.log(`[context-job] using the location confirmed on the call: ${confirmed.locationId} "${confirmed.locationName}" (${confirmed.locationStatus})`);
        return confirmed;
    }

    const candidates = await findCustomerWithConfidence(authToken, {
        phone: from_number,
        name: customer_name,
        address: service_address,
        locationName: location_name,
        companyName: company_name,
        // Lets the phone index fall back to the `servicetrade_locations` mirror when
        // ServiceTrade is unreachable. Config maps this agent to the mirrored rows;
        // without it the fallback cannot tell whose locations to read.
        stAgentId: agent_id
    });

    // Confident-match picker: any Tier 1, or a Tier 2 that resolves to a single
    // unambiguous location. Anything less → no confident match.
    const pickConfident = (cands) => {
        let sel = cands.find((c) => c.tier === 1 && c.locationId);
        if (!sel) {
            const tier2 = cands.filter((c) => c.tier === 2 && c.locationId);
            const uniqueLocationIds = [...new Set(tier2.map((c) => c.locationId))];
            if (tier2.length > 0 && uniqueLocationIds.length === 1) {
                sel = tier2[0];
            }
        }
        return sel || null;
    };

    const formatAddress = (candidate) => {
        const a = (candidate && candidate.address) || {};
        return [a.street, a.city, a.state, a.postalCode].filter(Boolean).join(', ').trim();
    };

    // ACTIVE-preferred: when the same context matches both an active and a deactivated
    // location, the active one wins. Beyond that preference an inactive location is a
    // normal match — `inactive` is a ServiceTrade bookkeeping state, not a statement
    // about whether someone's heating just failed, so it must not stop the dispatch or
    // the job. Callers get `locationStatus` and flag it through to the technician, the
    // outcome trail and the client email instead.
    const activeSelected = pickConfident(candidates.filter((c) => c.locationStatus !== 'inactive'));
    if (activeSelected) {
        return {
            status: 'matched',
            locationId: activeSelected.locationId,
            locationName: activeSelected.locationName,
            tier: activeSelected.tier,
            locationStatus: 'active',
            matchedAddress: formatAddress(activeSelected)
        };
    }

    // No active match, but the address IS a known deactivated location. Same tier logic,
    // same 'matched' verdict — only the status differs.
    const inactiveSelected = pickConfident(candidates.filter((c) => c.locationStatus === 'inactive'));
    if (inactiveSelected) {
        return {
            status: 'matched',
            locationId: inactiveSelected.locationId,
            locationName: inactiveSelected.locationName,
            tier: inactiveSelected.tier,
            locationStatus: 'inactive',
            matchedAddress: formatAddress(inactiveSelected)
        };
    }

    return { status: 'no_match' };
}

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
 * @param {string} [fields.location_id]   location the caller confirmed on the inbound call
 * @returns {Promise<{status:'created', job:Object, matchedLocationId:*, matchedLocationName:*,
 *                    matchTier:*, locationStatus:'active'|'inactive', matchedAddress:string}
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
        company_name,
        location_id
    } = fields || {};

    // Same auth + confident-location resolution the pre-flight gate uses, so the
    // two can never disagree about whether this context matches a location.
    const match = await matchLocationFromCallContext({
        agent_id,
        customer_name,
        service_address,
        from_number,
        location_name,
        company_name,
        location_id
    });

    if (match.status !== 'matched') {
        return { status: 'no_match' };
    }

    const selected = { locationId: match.locationId, locationName: match.locationName, tier: match.tier };
    const isInactive = match.locationStatus === 'inactive';

    // Preserve the caller's/alarm's issue text verbatim in the job description.
    // A deactivated location is tagged in the description too, so the flag is visible
    // inside ServiceTrade itself and not only in our email and sheet.
    const name = (customer_name || '').trim() || 'Unknown person';
    const phonePart = from_number ? ` (${from_number})` : '';
    const issue = (call_summary || '').trim() || 'emergency service request';
    const inactiveTag = isInactive ? '[INACTIVE LOCATION]' : '';
    const description = `[EMERGENCY - TECH APPROVED]${inactiveTag}: ${name}${phonePart} reported ${issue}`;

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
        matchTier: selected.tier,
        locationStatus: match.locationStatus || 'active',
        matchedAddress: match.matchedAddress || ''
    };
}

module.exports = { createJobFromCallContext, matchLocationFromCallContext, resolveConfirmedLocation };
