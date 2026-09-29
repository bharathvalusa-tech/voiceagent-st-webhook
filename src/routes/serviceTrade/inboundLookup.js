const express = require('express');
const router = express.Router();
const config = require('../../config/environment');
const { getAuthToken } = require('../../controllers/serviceTradeController');
const locationPhoneIndex = require('../../services/locationPhoneIndex');
const { searchContacts, spokenAddress } = require('../../services/contactSearchService');

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
// ~800ms; the sideloaded contact search measures ~60ms and runs alongside it, not after.
// This only ever trips on a genuine ServiceTrade stall.
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
    // Who is calling, when ServiceTrade knows. The phone index has no field for any of
    // these — they come from the contact search that now runs alongside it — so before
    // this they were blank on every call and the agent had to ask for a name it held.
    st_contact_id: '',
    st_contact_name: '',
    st_company_id: '',
    st_company_name: '',
    // Set when the caller's number sits on SEVERAL locations — the number identifies the
    // account but not the building, and guessing sends a van to the wrong one.
    //
    // THERE IS NO IN-CALL TOOL ON THIS PATH. Adaptive resolves entirely in this response;
    // `/st-verify-customer` is Braconier's route and Adaptive agents do not call it. The
    // options exist so the agent can ask a SHARPER question — "is this the Ridgeway site
    // or the Maple one?" instead of "what is the full address?" — and the caller's answer
    // travels out as the service address exactly as a spoken one would, to be matched
    // after the call. Nothing here resolves a location id.
    //
    // Before this, an ambiguous number was discarded as a plain no-match and the agent
    // asked for the address from scratch with no idea it already held the candidates.
    st_needs_location: 'false',
    st_location_options: '',
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

const respond = (res, dynamicVariables) => res.status(200).json({
    call_inbound: { dynamic_variables: dynamicVariables }
});

const withDeadline = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('lookup deadline exceeded')), ms))
]);

// A location-phone-index hit in the {street, city, state, postal_code} row shape the
// contact search already produces, so one dedupe and one spoken-address helper serve both.
const indexHitToRow = (hit) => {
    const a = hit.address || {};
    return {
        servicetrade_id: hit.locationId,
        name: hit.locationName || '',
        status: hit.locationStatus || 'active',
        street: a.street || '',
        city: a.city || '',
        state: a.state || '',
        postal_code: a.postalCode || '',
        // Only used when a location carries no parsed address at all. The index builds
        // `matchedAddress` from the same four parts, so this can differ from them only
        // when `address` is missing entirely — and then it is the one thing left to say.
        fallbackAddress: hit.matchedAddress || ''
    };
};

// The four parts as the agent reads them, or whatever the index could give us.
const speak = (loc) => spokenAddress(loc) || loc.fallbackAddress || '';

/**
 * Resolve a caller's number to a location AND to whoever ServiceTrade has on that number.
 *
 * PRECEDENCE: CONTACT SEARCH WINS, THE LOCATION TABLE IS THE FALLBACK.
 *
 * A ten-digit hit on `/contact?search=` is a person on the account, and the locations that
 * contact is attached to are the sites they actually call about. When that yields a
 * location the search is over — the index is not consulted for a second opinion, and
 * cannot overturn it.
 *
 * The index runs only when contact search produced no location at all. That is the case it
 * exists for: `Location.phoneNumber` is a site's own main line and lives on the location,
 * not on any contact, so a caller ringing their own front desk is invisible to
 * `/contact?search=` no matter how the query is shaped (locationPhoneIndex.js:9-14).
 *
 * KNOWN TRADE-OFF, CHOSEN DELIBERATELY. A number on ONE contact resolves even when the
 * same number is also the main line of other sites — the contact's location wins and the
 * others are never seen. customerMatchingService.js:554-562 refuses exactly that shape at
 * job-matching time, and this route now disagrees with it on purpose: this verdict is
 * advisory, spoken back to the caller for confirmation, and the authoritative match still
 * runs after the call.
 *
 * BOTH REQUESTS STILL FIRE IN PARALLEL. The index answer is usually discarded, but it is
 * one cached map lookup once warm, and waiting for the contact search to fail first would
 * put a cold rebuild (~800ms) in series with it inside a 4s deadline on a ringing phone.
 *
 * Contact identity is independent of all of the above: when contact search names the
 * caller, that name ships even if the location came from the index.
 *
 * Neither source can take the other down: each failure is caught and logged, and whatever
 * did resolve is still returned.
 *
 * @returns {Promise<{locations, contact, contactsFound, indexHits, sources}>}
 */
async function resolveLocation(authToken, phone) {
    const tenDigits = locationPhoneIndex.normalizePhone(phone);
    const sources = [];

    const [indexHits, parsed] = await Promise.all([
        locationPhoneIndex
            .lookupAllByPhone(authToken, tenDigits, authToken, config.inboundLookupStAgentId)
            .then((hits) => { sources.push('location_phone_index'); return hits; })
            .catch((error) => {
                console.error(`[st-inbound-lookup] location index unavailable: ${error.message || error}`);
                return [];
            }),

        // ServiceTrade returns zero results for an E.164 string, so the ten-digit form is
        // the only one worth sending; anything shorter is not a number to search on.
        tenDigits.length === 10
            ? searchContacts(authToken, tenDigits)
                .then((result) => { sources.push('contact_search'); return result; })
                .catch((error) => {
                    console.error(`[st-inbound-lookup] contact search failed: ${error.message || error}`);
                    return { contacts: [], shape: 'unavailable', totalRecords: 0 };
                })
            : Promise.resolve({ contacts: [], shape: 'skipped', totalRecords: 0 })
    ]);

    // Who is calling. Independent of where the location ends up coming from.
    //
    // NO SECOND PHONE CHECK. The old code re-compared the caller's digits against
    // contact.phone / mobile / alternatePhone and dropped anything that missed. On the
    // live records `phone` is routinely "" with the number in `mobile`, and a field not on
    // that list of three is invisible — so the check could reject the very record the
    // ten-digit search had just returned for that number. The search term IS the phone.
    const contact = parsed.contacts.length > 0 ? parsed.contacts[0] : null;

    const seen = new Set();
    const collect = (entries) => {
        const rows = [];
        entries.forEach(({ contact: c, loc, source }) => {
            const key = String(loc.servicetrade_id || '');
            if (!key || seen.has(key)) return;
            seen.add(key);
            rows.push({ contact: c, loc, source });
        });
        return rows;
    };

    // 1. Contact search. One person can be recorded twice on the same site, and that is
    //    not two sites, so the dedupe runs before the count is trusted.
    const contactLocations = collect(
        parsed.contacts.flatMap((c) => c.locations.map((loc) => ({ contact: c, loc, source: 'contact_search' })))
    );

    if (contactLocations.length > 0) {
        return {
            locations: contactLocations,
            contact,
            contactsFound: parsed.contacts.length,
            indexHits: indexHits.length,
            sources
        };
    }

    // 2. Nothing from the contact side. Now the index decides.
    //
    //    lookupByPhone rather than the raw hits: it holds the rule that a collision
    //    between one ACTIVE location and deactivated duplicates is a renamed site, not an
    //    ambiguity. The index is already built by this point, so this is a map read.
    let indexLocations = [];
    try {
        const single = await locationPhoneIndex.lookupByPhone(
            authToken, tenDigits, authToken, config.inboundLookupStAgentId
        );
        indexLocations = collect(
            (single ? [single] : indexHits)
                .map((hit) => ({ contact: null, loc: indexHitToRow(hit), source: 'location_phone_index' }))
        );
    } catch (error) {
        console.error(`[st-inbound-lookup] location index fallback failed: ${error.message || error}`);
    }

    return {
        locations: indexLocations,
        contact,
        contactsFound: parsed.contacts.length,
        indexHits: indexHits.length,
        sources
    };
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

        // Both sources failed. Nothing was looked up, so the mechanism itself is down.
        if (result.sources.length === 0) {
            console.error(`[st-inbound-lookup] both sources failed for ${fromNumber}`);
            return respond(res, emptyVars('lookup_error'));
        }

        const identity = {
            st_contact_id: String((result.contact && result.contact.contactId) || ''),
            st_contact_name: (result.contact && result.contact.contactName) || '',
            st_company_id: String((result.contact && result.contact.companyId) || ''),
            st_company_name: (result.contact && result.contact.companyName) || ''
        };

        if (result.locations.length === 0) {
            console.log(`[st-inbound-lookup] ${fromNumber} → no location (contacts ${result.contactsFound}, index ${result.indexHits})`);
            return respond(res, {
                ...emptyVars('no_match'),
                ...identity,
                st_lookup_ok: 'true'
            });
        }

        // The number identifies the account but not the building. Ship the candidates so
        // the agent can ask which one, rather than guessing or discarding them.
        if (result.locations.length > 1) {
            const options = result.locations.map(({ loc }) => speak(loc));
            console.log(`[st-inbound-lookup] ${fromNumber} → ${result.locations.length} locations, asking the caller which`);
            return respond(res, {
                ...emptyVars('ambiguous_location'),
                ...identity,
                st_lookup_ok: 'true',
                st_needs_location: 'true',
                st_location_options: options.join(' | ')
            });
        }

        const { contact, loc, source } = result.locations[0];
        const status = loc.status || 'active';
        const spoken = speak(loc);
        console.log(`[st-inbound-lookup] ${fromNumber} → location ${loc.servicetrade_id} "${loc.name}" (${status}, via ${source}), speaking "${spoken}"`);

        return respond(res, {
            ...emptyVars('matched'),
            ...identity,
            st_lookup_ok: 'true',
            st_lookup_reason: source,
            st_location_found: 'true',
            st_location_status: status,
            // Serviceable is about the ServiceTrade record, not about whether we will
            // help — an inactive site is still dispatched and still gets a job.
            st_location_serviceable: status === 'active' ? 'true' : 'false',
            st_location_id: String(loc.servicetrade_id || ''),
            st_location_name: loc.name || '',
            st_location_address: spoken,
            address_match: spoken
        });
    } catch (error) {
        console.error(`[st-inbound-lookup] failing open for ${fromNumber}: ${error.message || error}`);
        return respond(res, emptyVars('lookup_error'));
    }
});

module.exports = router;
module.exports.resolveLocation = resolveLocation;
