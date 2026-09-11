const express = require('express');
const router = express.Router();
const { sendSuccessResponse } = require('../../utils/responseHelper');
const { getAuthToken } = require('../../controllers/serviceTradeController');
const { matchAgainstRows } = require('../../services/addressMatchService');
const { normalizePhone } = require('../../utils/phone');

/**
 * POST /st-verify-customer
 *
 * Answers ONE question the existing /st-customer cannot: *is this caller a customer*.
 * /st-customer answers "is this a contact" — there is no customer filter anywhere in
 * getCustomerByPhone — so it would verify a vendor, a prospect or a closed account.
 * The verdict here is the ServiceTrade company's own `customer` flag.
 *
 * WHY THE IDENTITY VALUES COME FROM THE QUERY STRING, NOT THE MODEL.
 * The old tool asked the LLM to fill in `call.from_number` and `call.agent_id`. On
 * call_47f627768c0c44e091d84c12ad8 it sent `{"agent_id":"62","from_number":"+1"}` — the
 * agent VERSION it had seen two turns earlier in the agent_swap response, and a bare
 * country code — because neither real value was rendered anywhere it could read. Retell
 * substitutes dynamic variables into custom-function URLs, so both now arrive as query
 * params and the model fills in neither:
 *
 *   POST /st-verify-customer?from_number={{user_number}}&agent_id=agent_41010d...
 *
 * NEVER 4xx ON A BAD INPUT. A tool that errors mid-call leaves Clara with nothing to
 * say — the 400 above is exactly why she improvised her way past a failed lookup and
 * asked the caller for details ServiceTrade had already returned. Every outcome is a
 * 200 carrying a spoken-language `message` and a machine-readable reason.
 */

// ServiceTrade's search is one fuzzy field. It takes a phone number, a contact name or an
// email; we use the phone. `_sideload` pulls the related entities into the same response
// object, so contact + companies + locations + addresses arrive in ONE request instead of
// a second round trip or getLocations()'s full-account page-by-page scan (minutes, on a
// live emergency call). `status=public,private` returns contacts of both statuses.
const SIDELOAD = 'contact.locations,contact.companies,location.company';
const CONTACT_STATUS = 'public,private';
const SERVICETRADE_BASE = 'https://api.servicetrade.com/api';

// Comfortably inside a caller's patience, and far above the ~60ms this search measures at.
const LOOKUP_TIMEOUT_MS = 8000;

const REASONS = {
    verified: 'verified',
    needsConfirmation: 'needs_confirmation',
    needsLocation: 'needs_location',
    locationUnresolved: 'location_unresolved',
    noContactMatch: 'no_contact_match',
    companyNotCustomer: 'company_not_customer',
    needsPhone: 'needs_phone',
    lookupError: 'lookup_error'
};

/**
 * Retell's tool config differs per agent: args arrive at the body root on some, nested
 * under `args` on others, and sometimes `args` is a JSON string. Same tolerance as
 * matchAddress.js:31-37.
 */
const readArgs = (body) => {
    const root = body || {};
    let nested = root.args;
    if (typeof nested === 'string') {
        try { nested = JSON.parse(nested); } catch (e) { nested = null; }
    }
    return { ...root, ...(nested && typeof nested === 'object' ? nested : {}) };
};

const pick = (src, ...keys) => {
    for (const key of keys) {
        const value = src[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value).trim();
        }
    }
    return '';
};

// ServiceTrade stores names as typed, which for this account means ALL CAPS with stray
// whitespace ("BRAD ", "POSITIVE APPROACH"). Clara speaks these aloud, so they are cleaned
// on the way out rather than at every call site.
const toSpokenName = (value) => String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

// The four parts, in the order Clara speaks them. Blank parts are dropped rather than
// producing a doubled comma.
const spokenAddress = (loc) => [loc.street, loc.city, loc.state, loc.postal_code]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');

/**
 * Resolve either response shape into one internal object.
 *
 * `_sideload` and `status` are outside ServiceTrade's published contract, and the shapes
 * differ materially — `contact.company` is a bare int here and an embedded object in the
 * documented response, locations are top-level and referenced by id here but nested
 * there, and pagination sits in `meta` rather than `data`. Reading the sideloaded shape
 * directly would mean a silent removal of the parameter becomes a runtime type error
 * mid-call. Both shapes normalize through here instead, so switching to the documented
 * endpoint is a config change rather than a rewrite.
 *
 * Location rows come out in the {street, city, state, postal_code} shape that
 * addressMatchService.matchAgainstRows already consumes — that is deliberate, so the
 * fuzzy matcher needs no adapter of its own.
 */
const normalizeContactSearch = (json) => {
    const data = (json && json.data) || {};
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];

    const byId = (rows) => {
        const map = new Map();
        (Array.isArray(rows) ? rows : []).forEach((row) => {
            if (row && row.id !== undefined) map.set(String(row.id), row);
        });
        return map;
    };

    const locationsById = byId(data.locations);
    const companiesById = byId(data.companies);
    const addressesById = byId(data.addresses);
    const sideloaded = locationsById.size > 0 || companiesById.size > 0;

    // A location arrives as an id (sideloaded) or as a whole object (documented).
    const toLocationRow = (entry) => {
        const loc = (entry && typeof entry === 'object')
            ? entry
            : locationsById.get(String(entry));
        if (!loc) return null;

        // Sideloaded locations carry addressStreet/addressCity/...; documented ones nest
        // an address object; and a sideloaded `address` may be an id into data.addresses.
        const addr = (loc.address && typeof loc.address === 'object')
            ? loc.address
            : addressesById.get(String(loc.address)) || {};

        return {
            servicetrade_id: loc.id,
            name: loc.name || '',
            status: loc.status || 'active',
            street: loc.addressStreet || addr.street || '',
            city: loc.addressCity || addr.city || '',
            state: loc.addressState || addr.state || '',
            postal_code: loc.addressPostalCode || addr.postalCode || '',
            companyId: loc.company && typeof loc.company === 'object'
                ? loc.company.id
                : loc.company
        };
    };

    const normalized = contacts.map((contact) => {
        const locations = (Array.isArray(contact.locations) ? contact.locations : [])
            .map(toLocationRow)
            .filter(Boolean);

        // On the shared live record `contact.companies` is [] while `contact.company` is
        // populated — the company is derived THROUGH the location, not directly assigned.
        // Reading companies[] would have returned nothing.
        const companyRef = contact.company
            || (locations.length > 0 ? locations[0].companyId : null);
        const company = (companyRef && typeof companyRef === 'object')
            ? companyRef
            : companiesById.get(String(companyRef)) || null;

        return {
            contactId: contact.id,
            contactName: toSpokenName(`${contact.firstName || ''} ${contact.lastName || ''}`),
            email: contact.email || '',
            companyId: company ? company.id : null,
            companyName: company ? toSpokenName(company.name) : '',
            // The whole point of this route. `customer` is ServiceTrade's own flag; the
            // documented shape omits it unless sideloaded, which is why that case falls
            // back to null (unknown) rather than false (rejected).
            companyIsCustomer: company && typeof company.customer === 'boolean'
                ? company.customer
                : null,
            companyStatus: company ? company.status : null,
            locations
        };
    });

    return {
        shape: sideloaded ? 'sideloaded' : 'documented',
        totalRecords: (json && json.meta && json.meta.totalRecords) !== undefined
            ? json.meta.totalRecords
            : (data.totalRecords !== undefined ? data.totalRecords : contacts.length),
        contacts: normalized
    };
};

const fetchContactSearch = async (authToken, term) => {
    const url = `${SERVICETRADE_BASE}/contact`
        + `?search=${encodeURIComponent(term)}`
        + `&_sideload=${encodeURIComponent(SIDELOAD)}`
        + '&limit=100&page=1'
        + `&status=${encodeURIComponent(CONTACT_STATUS)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Cookie: `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
        }

        // Guarded for the same reason getContacts now is: an empty body reaching .json()
        // throws "Unexpected end of JSON input", which is indistinguishable from "no match"
        // by the time it reaches the caller.
        const text = await response.text();
        if (!text) throw new Error('ServiceTrade returned an empty body');
        return JSON.parse(text);
    } finally {
        clearTimeout(timeout);
    }
};

// Empty strings rather than omitted keys: Retell renders an ABSENT dynamic variable as a
// literal {{mustache}} in the prompt, while "" renders as nothing. Every field ships on
// every response for that reason.
const baseVars = () => ({
    st_customer_verified: 'false',
    st_customer_reason: '',
    st_retry_allowed: 'false',
    st_needs_confirmation: 'false',
    st_needs_location: 'false',
    st_contact_id: '',
    st_contact_name: '',
    st_company_id: '',
    st_company_name: '',
    st_location_id: '',
    st_location_name: '',
    st_location_address: '',
    st_location_options: ''
});

const withLocation = (vars, contact, location) => ({
    ...vars,
    st_contact_id: String(contact.contactId || ''),
    st_contact_name: contact.contactName || '',
    st_company_id: String(contact.companyId || ''),
    st_company_name: contact.companyName || '',
    st_location_id: String(location.servicetrade_id || ''),
    st_location_name: location.name || '',
    st_location_address: spokenAddress(location)
});

router.post('/st-verify-customer', async (req, res) => {
    const args = readArgs(req.body);
    const query = req.query || {};

    const agentId = pick(query, 'agent_id') || pick(args, 'agent_id');
    const spokenLocation = pick(args, 'spoken_location', 'location', 'address');
    const attempt = Number(pick(args, 'attempt')) === 2 ? 2 : 1;

    // Pass 1 uses the caller ID Retell substituted into the URL. The retry uses the number
    // the caller stated, which arrives in the body because the model DID have to hear it.
    const rawTerm = pick(args, 'search') || pick(query, 'from_number');

    const reply = (vars, message, log) => {
        console.log(`[st-verify-customer] ${JSON.stringify({
            attempt,
            reason: vars.st_customer_reason,
            verified: vars.st_customer_verified,
            locationId: vars.st_location_id || null,
            ...log
        })}`);
        return sendSuccessResponse(res, vars, message, 200);
    };

    try {
        if (!agentId) {
            return reply(
                { ...baseVars(), st_customer_reason: REASONS.lookupError },
                'The account system is not reachable right now. Continue the call and let the office follow up.',
                { error: 'missing agent_id' }
            );
        }

        // ServiceTrade's search returns nothing for an E.164 string — "+13038758807" finds
        // no one, "3038758807" finds the record. normalizePhone strips extensions FIRST,
        // then punctuation, then the NANP country code, so every inbound format reduces to
        // the same ten digits. Never trust the caller's format; normalize unconditionally.
        const term = normalizePhone(rawTerm);
        if (term.length !== 10) {
            return reply(
                {
                    ...baseVars(),
                    st_customer_reason: REASONS.needsPhone,
                    st_retry_allowed: attempt === 1 ? 'true' : 'false'
                },
                'Ask the caller for the phone number on their account, then call this again with that number as search.',
                { rawTerm, normalized: term }
            );
        }

        const authToken = await getAuthToken(agentId);
        const parsed = normalizeContactSearch(await fetchContactSearch(authToken, term));

        // The verdict. companyIsCustomer === true is the whole gate — not `vendor`, not
        // `managingAccountId`, and no re-comparison of the caller's digits against
        // phoneNumber/mobile/alternatePhone. That last one matters: on the live record
        // phoneNumber is "" and the number sits in `mobile`, so a phoneNumber-only check
        // would reject the very record ServiceTrade just returned for that search.
        const customers = parsed.contacts.filter((c) => c.companyIsCustomer === true);

        if (customers.length === 0) {
            const found = parsed.contacts.length > 0;
            return reply(
                {
                    ...baseVars(),
                    st_customer_reason: found ? REASONS.companyNotCustomer : REASONS.noContactMatch,
                    st_retry_allowed: attempt === 1 ? 'true' : 'false'
                },
                attempt === 1
                    ? 'No customer account matched. Ask once for the phone number on their account, then call this again with that number as search and attempt 2.'
                    : 'No customer account matched. Tell the caller service is only available during normal business hours and end the call.',
                { shape: parsed.shape, totalRecords: parsed.totalRecords, contactsFound: parsed.contacts.length }
            );
        }

        // Locations take priority over addresses: resolve against the location entities,
        // which is what location_extract was already built around. data.addresses[] is only
        // a lookup table for the parts. Union across matched customer contacts, deduped —
        // one person can appear twice on a site, and that is not two sites.
        const seen = new Set();
        const locations = [];
        customers.forEach((contact) => {
            contact.locations.forEach((loc) => {
                const key = String(loc.servicetrade_id);
                if (seen.has(key)) return;
                seen.add(key);
                locations.push({ contact, loc });
            });
        });

        if (locations.length === 0) {
            return reply(
                {
                    ...baseVars(),
                    st_customer_reason: REASONS.locationUnresolved,
                    st_contact_id: String(customers[0].contactId || ''),
                    st_contact_name: customers[0].contactName,
                    st_company_id: String(customers[0].companyId || ''),
                    st_company_name: customers[0].companyName
                },
                'The account has no service location on file. Tell the caller service is only available during normal business hours and end the call.',
                { customers: customers.length }
            );
        }

        // Exactly one — nothing to disambiguate. Clara reads it back for confirmation.
        if (locations.length === 1 && !spokenLocation) {
            const { contact, loc } = locations[0];
            return reply(
                {
                    ...withLocation(baseVars(), contact, loc),
                    st_customer_verified: 'true',
                    st_customer_reason: REASONS.needsConfirmation,
                    st_needs_confirmation: 'true'
                },
                'Confirm the caller is this contact at this company, then confirm the work is at this location.',
                { shape: parsed.shape }
            );
        }

        // More than one, and the caller has not named one yet.
        if (!spokenLocation) {
            return reply(
                {
                    ...baseVars(),
                    st_customer_verified: 'true',
                    st_customer_reason: REASONS.needsLocation,
                    st_needs_location: 'true',
                    st_contact_id: String(locations[0].contact.contactId || ''),
                    st_contact_name: locations[0].contact.contactName,
                    st_company_id: String(locations[0].contact.companyId || ''),
                    st_company_name: locations[0].contact.companyName,
                    st_location_options: locations.map(({ loc }) => spokenAddress(loc)).join(' | ')
                },
                'Ask one open question about which location this is for, then call this again with spoken_location set.',
                { locationCount: locations.length }
            );
        }

        // ONE fuzzy attempt, as specified. matchAgainstRows scores the spoken location
        // against every candidate's street/city/state/postal_code. Its own normalizeText
        // reduces both sides to alphanumerics and spaces, so the four parts joined with
        // spaces and its internal ", " join produce an identical token stream — no
        // separate query string has to be built.
        //
        // Anything short of a decisive winner ends the call. A near-miss is not a
        // tiebreak to re-ask: sending a technician to the wrong building at 2am is worse
        // than telling the caller to ring back in the morning.
        const match = matchAgainstRows(spokenLocation, locations.map(({ loc }) => loc));

        if (!match.matched) {
            return reply(
                {
                    ...baseVars(),
                    st_customer_reason: REASONS.locationUnresolved,
                    st_contact_id: String(locations[0].contact.contactId || ''),
                    st_contact_name: locations[0].contact.contactName,
                    st_company_id: String(locations[0].contact.companyId || ''),
                    st_company_name: locations[0].contact.companyName
                },
                'The location could not be identified. Do not ask again. Tell the caller service is only available during normal business hours and end the call.',
                { spokenLocation, matchReason: match.reason, score: match.score ?? null }
            );
        }

        const winner = locations.find(
            ({ loc }) => String(loc.servicetrade_id) === String(match.location.locationId)
        );

        return reply(
            {
                ...withLocation(baseVars(), winner.contact, winner.loc),
                st_customer_verified: 'true',
                st_customer_reason: REASONS.verified
            },
            'Location confirmed. Continue with the emergency workflow.',
            { spokenLocation, score: match.score, runnerUp: match.runnerUp ?? null }
        );
    } catch (error) {
        // A ServiceTrade outage is NOT a new customer. This reason exists so the prompt can
        // keep collecting and hand off to the office instead of refusing someone who may
        // well be a customer — the distinction the unguarded getContacts used to destroy.
        return reply(
            { ...baseVars(), st_customer_reason: REASONS.lookupError },
            'The account system is not reachable right now. Do not refuse the caller. Keep collecting their details and let the office follow up.',
            { error: error.message || String(error) }
        );
    }
});

module.exports = router;
module.exports.normalizeContactSearch = normalizeContactSearch;
module.exports.toSpokenName = toSpokenName;
