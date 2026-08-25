const express = require('express');
const router = express.Router();
const config = require('../../config/environment');
const { getAuthToken } = require('../../controllers/serviceTradeController');
const locationPhoneIndex = require('../../services/locationPhoneIndex');
const serviceTradeService = require('../../services/serviceTradeService');

/**
 * POST /st-inbound-lookup
 *
 * Retell's inbound-call webhook. Fires the moment a call arrives, BEFORE the agent
 * speaks, and whatever we return becomes dynamic variables on that call.
 *
 * Configured PER PHONE NUMBER in the Retell dashboard, not on the agent — none of the
 * Adaptive agent configs carries a webhook key except the outbound one.
 *
 * Retell sends:
 *   { event: 'call_inbound',
 *     call_inbound: { agent_id, agent_version, from_number, to_number, custom_sip_headers } }
 *
 * Retell expects, within 10s (3 retries, then the call falls through to the configured
 * agent):
 *   { call_inbound: { dynamic_variables: { ... } } }
 *
 * ADVISORY ONLY. This never rejects a call and never gates anything. An inactive
 * location is dispatched like any other — the flag exists so the technician is told and
 * the office can review, not to turn anyone away. The authoritative location verdict is
 * still the address-derived one resolved at job time.
 *
 * FAIL-OPEN in every failure mode: unknown agent, missing token, ServiceTrade down,
 * slow lookup. All of them return 200 with `st_lookup_ok: "false"` and empty fields, so
 * the agent simply behaves as it does today.
 */

// Well inside Retell's 10s budget. A warm index lookup is ~0ms and a cold rebuild
// ~800ms, so this only ever trips on a genuine ServiceTrade stall.
const LOOKUP_DEADLINE_MS = 4000;

const emptyVars = (reason) => ({
    st_lookup_ok: 'false',
    st_lookup_reason: reason,
    st_location_found: 'false',
    st_location_status: 'unknown',
    st_location_serviceable: 'false',
    st_location_id: '',
    st_location_name: '',
    st_location_address: '',
    // The address the agent SPEAKS back when the caller's number identified their site,
    // as street, city, state, postal code. Empty means we could not identify it, and
    // empty is the only "no" — there is deliberately no sentinel word to check for,
    // because the outcome trail already records whether an address was found.
    //
    // Empty is safe to leave in a prompt: Retell treats "" as a real value and renders
    // nothing. An ABSENT variable is what renders as a literal {{mustache}}, which is why
    // this belongs in emptyVars and not only on the success path.
    address_match: ''
});

// Street, city, state, postal code — the four parts the agent reads aloud. Blank parts
// are dropped rather than producing a trailing comma; four of the 395 mirrored Adaptive
// locations carry no postal code.
const formatSpokenAddress = (address) => {
    const a = address || {};
    return [a.street, a.city, a.state, a.postalCode]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(', ');
};

const respond = (res, dynamicVariables) => res.status(200).json({
    call_inbound: { dynamic_variables: dynamicVariables }
});

const withDeadline = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('lookup deadline exceeded')), ms))
]);

/**
 * Resolve a caller's number to a location.
 *
 * Location table first: one cached request covers every location, including the sites
 * whose only number is their own main line — which /contact?search= structurally cannot
 * see, because that field lives on the location and not on any contact.
 *
 * Contact search second, for a caller whose number is on a contact record but on no
 * location. Queried with the ten-digit form: ServiceTrade returns zero results for an
 * E.164 string.
 */
async function resolveLocation(authToken, phone) {
    const indexed = await locationPhoneIndex.lookupByPhone(
        authToken, phone, authToken, config.inboundLookupStAgentId
    );
    if (indexed) return { ...indexed, source: 'location_phone_index' };

    const tenDigits = locationPhoneIndex.normalizePhone(phone);
    if (tenDigits.length !== 10) return null;

    const contacts = await serviceTradeService.searchContacts(authToken, tenDigits);
    for (const contact of contacts) {
        const phones = [contact.phone, contact.mobile, contact.alternatePhone].filter(Boolean);
        if (!phones.some((p) => locationPhoneIndex.normalizePhone(p) === tenDigits)) continue;

        const locations = Array.isArray(contact.locations) ? contact.locations : [];
        // A catch-all contact spread over dozens of sites identifies none of them.
        if (locations.length !== 1) continue;

        const location = locations[0];
        const a = location.address || {};
        return {
            locationId: location.id,
            locationName: location.name || '',
            locationStatus: location.status || null,
            address: location.address || null,
            matchedAddress: [a.street, a.city, a.state, a.postalCode].filter(Boolean).join(', ').trim(),
            source: 'contact_search'
        };
    }
    return null;
}

router.post('/st-inbound-lookup', async (req, res) => {
    const body = req.body || {};
    const inbound = body.call_inbound || {};
    const agentId = inbound.agent_id || '';
    const fromNumber = inbound.from_number || '';

    try {
        if (body.event && body.event !== 'call_inbound') {
            return respond(res, emptyVars('unsupported_event'));
        }

        // Same allowlist pattern as /st-escalation-complete: this route resolves against
        // one tenant's ServiceTrade account, so only that tenant's agents may drive it.
        if (!config.inboundLookupAgentIds.includes(agentId)) {
            console.log(`[st-inbound-lookup] agent ${agentId} not enabled — returning empty variables`);
            return respond(res, emptyVars('agent_not_enabled'));
        }

        if (!fromNumber) {
            return respond(res, emptyVars('no_from_number'));
        }

        const result = await withDeadline((async () => {
            const authToken = await getAuthToken(config.inboundLookupStAgentId);
            return resolveLocation(authToken, fromNumber);
        })(), LOOKUP_DEADLINE_MS);

        if (!result) {
            console.log(`[st-inbound-lookup] ${fromNumber} → no confident location`);
            return respond(res, {
                ...emptyVars('no_match'),
                st_lookup_ok: 'true'
            });
        }

        const status = result.locationStatus || 'active';
        // Rebuild from the address parts rather than reusing matchedAddress, so the four
        // components are in the order the agent speaks them and nothing else can creep in.
        // Falls back to matchedAddress if a location somehow carries no parsed address.
        const spokenAddress = formatSpokenAddress(result.address) || (result.matchedAddress || '');
        console.log(`[st-inbound-lookup] ${fromNumber} → location ${result.locationId} "${result.locationName}" (${status}, via ${result.source}), speaking "${spokenAddress}"`);

        return respond(res, {
            st_lookup_ok: 'true',
            st_lookup_reason: result.source,
            st_location_found: 'true',
            st_location_status: status,
            // Serviceable is about the ServiceTrade record, not about whether we will
            // help — an inactive site is still dispatched and still gets a job.
            st_location_serviceable: status === 'active' ? 'true' : 'false',
            st_location_id: String(result.locationId || ''),
            st_location_name: result.locationName || '',
            st_location_address: result.matchedAddress || '',
            address_match: spokenAddress
        });
    } catch (error) {
        console.error(`[st-inbound-lookup] failing open for ${fromNumber}: ${error.message || error}`);
        return respond(res, emptyVars('lookup_error'));
    }
});

module.exports = router;
