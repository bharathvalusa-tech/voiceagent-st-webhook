const express = require('express');
const router = express.Router();
const { sendSuccessResponse } = require('../../utils/responseHelper');
const {
    matchSpokenAddress,
    matchSpokenCompany,
    findLocationById,
    narrowByCompany
} = require('../../services/addressMatchService');

/**
 * POST /st-match-address
 *
 * Retell custom tool. The agent calls it once the caller has spoken a service address,
 * and again after the street / city / postal re-ask.
 *
 * WHY A TOOL AND NOT THE INBOUND WEBHOOK: /st-inbound-lookup fires once, before the agent
 * speaks, so it cannot see an address the caller has not given yet. The phone lookup runs
 * there; the spoken-address match has to run here.
 *
 * Payload tolerance matches /st-match-location: fields may arrive at the body root or
 * nested under `args` (sometimes as a JSON string), because Retell's tool config differs
 * per agent — `args_at_root` is true on After Hours and false on Office Hours for the same
 * endpoint (docs/session.md §9).
 *
 * Accepts either a whole address or the re-ask components:
 *   { address: "150 Thornbury Court, East Gwillimbury, ON" }
 *   { street: "150 Thornbury Court", city: "East Gwillimbury", state: "ON", postal_code: "L9N 0M8" }
 *
 * TWO SHAPES, ONE ROUTE.
 *
 *   WITHOUT `agent_id` — the original behaviour, unchanged to the byte. One configured
 *   sync tenant, booleans for `address_found` and `ambiguous`, a number for
 *   `candidate_count`, and the original messages. `tests/addressMatch.test.js` pins all
 *   of it and none of those expectations move.
 *
 *   WITH `agent_id` — Braconier's two-ask flow. Scoped to that tenant's sites, and every
 *   value ships as a STRING because Retell renders an absent dynamic variable as a
 *   literal {{mustache}} while "" renders as nothing. Same rule /st-verify-customer
 *   follows.
 *
 * THE TWO ASKS. One site matched: the agent reads that address back and asks whether it is
 * under the company we hold. Several matched: the agent reads NOTHING and asks for the
 * company, which comes back here as `company` to narrow them. If the company fails,
 * `st_address_stage` says `combined` and the agent asks for the address in parts — the
 * last ask. A second miss is `terminal`.
 *
 * READ ONE ADDRESS, NEVER A LIST. A single matched address is one the caller just gave us,
 * so reading it back tells them nothing new. A list of candidates is other customers'
 * addresses read to someone we have not identified, which is why only counts leave here.
 *
 * ALWAYS answers 200 with a spoken-language `message` the agent can act on. A tool that
 * errors mid-call leaves Clara with nothing to say, so failure is reported as "no match"
 * rather than as an HTTP error — the caller is then asked for the address, which is
 * exactly what would have happened anyway.
 */

// Every key ships on every Braconier response, for the mustache reason above.
const baseVars = () => ({
    address_found: 'false',
    reason: '',
    // 'company'  — ask which company, read nothing aloud
    // 'parts'    — ask the address one part at a time; this is the last ask
    // 'terminal' — stop, go to Step D. Nothing may ask again
    // ''         — the first ask, nothing special
    st_address_stage: '',
    // The whole sentence to say, already shaped for one match or several, so the prompt
    // never has to count matches itself.
    st_company_question: '',
    st_location_id: '',
    st_location_name: '',
    st_company_id: '',
    st_company_name: '',
    st_matched_address: '',
    street: '',
    city: '',
    state: '',
    postal_code: '',
    match_score: '',
    candidate_count: '',
    distinct_company_count: ''
});

const distinctCompanies = (candidates) =>
    new Set(
        (candidates || [])
            .map((c) => String(c.companyName || '').trim().toLowerCase())
            .filter(Boolean)
    ).size;

// ---------------------------------------------------------------- legacy shape
// Byte-for-byte what this route returned before the Braconier flow existed.
function legacyResponse(res, result) {
    if (!result.matched) {
        const ambiguous = result.reason === 'ambiguous';
        return sendSuccessResponse(
            res,
            {
                address_found: false,
                reason: result.reason,
                ambiguous,
                // Deliberately NOT the candidate addresses. Reading other customers'
                // addresses to a caller is a privacy leak; the agent asks for the unit
                // or postal code instead.
                candidate_count: ambiguous && result.candidates ? result.candidates.length : 0
            },
            ambiguous
                ? 'Several sites share that address. Ask for the unit or suite number, or the postal code.'
                : 'No matching address on file. Ask the caller to confirm the address.',
            200
        );
    }

    const loc = result.location;
    return sendSuccessResponse(
        res,
        {
            address_found: true,
            address: loc.address,
            street: loc.street,
            city: loc.city,
            state: loc.state,
            postal_code: loc.postalCode,
            location_id: String(loc.locationId),
            location_name: loc.locationName,
            location_status: loc.locationStatus,
            match_score: result.score
        },
        `Address matched: ${loc.address}`,
        200
    );
}

// ------------------------------------------------------------- Braconier shape
function matchedResponse(res, loc, score, question, message) {
    return sendSuccessResponse(
        res,
        {
            ...baseVars(),
            address_found: 'true',
            reason: 'matched',
            st_location_id: String(loc.locationId || ''),
            st_location_name: loc.locationName || '',
            st_company_id: loc.companyId || '',
            st_company_name: loc.companyName || '',
            st_matched_address: loc.address || '',
            street: loc.street || '',
            city: loc.city || '',
            state: loc.state || '',
            postal_code: loc.postalCode || '',
            match_score: score === undefined || score === null ? '' : String(score),
            st_company_question: question
        },
        message,
        200
    );
}

router.post('/st-match-address', async (req, res) => {
    try {
        const body = req.body || {};
        let nested = body.args;
        if (typeof nested === 'string') {
            try { nested = JSON.parse(nested); } catch (e) { nested = null; }
        }
        const src = { ...body, ...(nested && typeof nested === 'object' ? nested : {}) };
        const query = req.query || {};

        const pick = (...keys) => {
            for (const key of keys) {
                const value = src[key];
                if (value !== undefined && value !== null && String(value).trim() !== '') {
                    return String(value).trim();
                }
            }
            return '';
        };

        // Which tenant's sites to search, and which response shape to answer in. The
        // agent id is baked into the tool's query_params, the same way
        // /st-verify-customer carries it. Absent means the original Adaptive caller.
        const agentId = String(query.agent_id || '').trim() || pick('agent_id');
        const scoped = Boolean(agentId);

        // A whole address if we were given one, otherwise assemble the components.
        // What the caller said about WHERE. An address or a building name — the matcher
        // scores both and takes whichever is better, so the agent does not have to know
        // which kind it heard. `address` stays as an alias so an older prompt keeps working.
        const whole = pick('location', 'address', 'service_address', 'spoken_address', 'full_address');
        const street = pick('street', 'address_line1', 'street_address');
        const city = pick('city');
        const state = pick('state', 'province');
        const postal = pick('postal_code', 'postalCode', 'zip', 'postal');
        const statedCompany = pick('company', 'company_name', 'stated_company');
        const confirmId = pick('location_id', 'locationId', 'site_id');

        const spoken = whole || [street, city, state, postal].filter(Boolean).join(', ');

        console.log('st-match-address received', {
            payloadKeys: Object.keys(src),
            agentId: agentId || null,
            hasWholeAddress: Boolean(whole),
            components: { street: Boolean(street), city: Boolean(city), state: Boolean(state), postal: Boolean(postal) },
            hasCompany: Boolean(statedCompany),
            spoken
        });

        // ---- the caller confirmed a site we offered ---------------------------
        // THE END OF THE FLOW. Every branch above tells the agent to come back here with
        // location_id copied from st_location_id, and until this existed that call fell
        // through to "no address was provided" — so a caller who had just been matched was
        // asked again, matched again, and then read the not-a-customer script. Measured on
        // a live test call.
        //
        // The id is re-read from the mirror rather than trusted: an id the model invented,
        // or lifted from another tenant, must not book a job. Same rule matrix applies to
        // its own confirm turn.
        if (scoped && confirmId) {
            const row = await findLocationById(confirmId, agentId);
            if (row) {
                return matchedResponse(
                    res, row, '', '',
                    'Confirmed. The caller is verified at this site. Call caller_details with '
                    + 'locationId = st_location_id, companyId = st_company_id, companyName = '
                    + 'st_company_name, customerVerified = true, then continue with the '
                    + 'emergency workflow.'
                );
            }
            // Not one of ours. Never book against it.
            return sendSuccessResponse(
                res,
                { ...baseVars(), reason: 'location_id_unknown', st_address_stage: 'parts' },
                'That site id is not one I gave you. Do not use it. Ask for the address one part '
                + 'at a time — street number, then street name, then state, then city, then ZIP.',
                200
            );
        }

        // ---- a company, with no location to go on ----------------------------
        // A company search and nothing more. If they never name one this never runs; if
        // they name one we do not hold, it fails, and that is a real answer.
        if (scoped && statedCompany && !spoken) {
            const byCompany = await matchSpokenCompany(statedCompany, agentId, '');

            if (byCompany.matched) {
                const loc = byCompany.location;
                const question = `I have ${loc.address}, belonging to ${loc.companyName}. Is that right?`;
                return matchedResponse(
                    res, loc, '', question,
                    `That company has one site. Say exactly: "${question}" A yes verifies them — `
                    + 'then call this again with location_id set to st_location_id, copied exactly.'
                );
            }

            if (byCompany.reason === 'company_needs_location') {
                // Several sites under that name. The ADDRESS is what separates them — every
                // site has its own, and they may not. Read none of them aloud.
                const question = 'I have several locations under that company. '
                    + 'Which address is the work at?';
                return sendSuccessResponse(
                    res,
                    {
                        ...baseVars(),
                        reason: byCompany.reason,
                        st_address_stage: 'location',
                        st_company_question: question,
                        candidate_count: String(byCompany.sites),
                        distinct_company_count: String(byCompany.companies)
                    },
                    `That company has ${byCompany.sites} sites. Say exactly: "${question}" Read no `
                    + 'address aloud. Then call this again with location set to what they say, '
                    + 'and company unchanged.',
                    200
                );
            }

            // Not found, or too short to search. Never offer another customer's address.
            return sendSuccessResponse(
                res,
                { ...baseVars(), reason: byCompany.reason, st_address_stage: 'parts' },
                'We hold nothing under that company name. Say so plainly, offer no other company '
                + 'or address, then ask for the address one part at a time — street number, then '
                + 'street name, then state, then city, then ZIP.',
                200
            );
        }

        if (!spoken) {
            return scoped
                ? sendSuccessResponse(
                    res,
                    { ...baseVars(), reason: 'no_address_given' },
                    'Ask: can you give me the address where the work is, or the company name on '
                    + 'the account? Then call this again with location set to an address or a '
                    + 'building name, or company set to a business name.',
                    200
                )
                : sendSuccessResponse(
                    res,
                    { address_found: false, reason: 'no_address_given' },
                    'No address was provided. Ask the caller for the service address.',
                    200
                );
        }

        const result = await matchSpokenAddress(spoken, agentId);

        if (!scoped) return legacyResponse(res, result);

        // ---- they gave a location AND a company -------------------------------
        // Both are the caller's own statement, so both are usable. The company FILTERS
        // what the location found — it is never a second search merged in. If the location
        // found nothing, fall through to the company on its own rather than giving up.
        if (statedCompany && !result.matched && result.reason !== 'ambiguous') {
            const byCompany = await matchSpokenCompany(statedCompany, agentId, spoken);
            if (byCompany.matched) {
                const loc = byCompany.location;
                const question = `I have ${loc.address}. Is that the right address?`;
                return matchedResponse(
                    res, loc, '', question,
                    `The company and the address agree on one site. Say exactly: "${question}" `
                    + 'A yes verifies them — then call this again with location_id set to '
                    + 'st_location_id, copied exactly.'
                );
            }
        }

        // ---- one site matched -------------------------------------------------
        if (result.matched) {
            const loc = result.location;
            // No company on the row is not a failure — the site still books a job. The
            // agent just confirms the address alone rather than naming a company.
            const question = loc.companyName
                ? `I have ${loc.address}. Is that location under ${loc.companyName}?`
                : `I have ${loc.address}. Is that the right address?`;
            return matchedResponse(
                res, loc, result.score, question,
                `One site matched. Say exactly: "${question}" A yes verifies them — then call this `
                + 'again with location_id set to st_location_id, copied exactly. A no means ask '
                + 'for the address one part at a time — street number, then street name, then '
                + 'state, then city, then ZIP.'
            );
        }

        // Step 3 has run once the caller has given the parts. Nothing after it may ask
        // again: its company narrowing is the last question in the flow, and a miss is
        // the end. Without this the ambiguous branch below sent the agent back to
        // 'combined', which asked for the parts again, which tied again — a loop.
        const partsGiven = Boolean(street || city || postal);

        // ---- several sites matched -------------------------------------------
        if (result.reason === 'ambiguous') {
            const candidates = result.candidates || [];
            const companyCount = distinctCompanies(candidates);

            // The caller already named a company; narrow with it rather than re-asking.
            if (statedCompany) {
                const narrowed = narrowByCompany(candidates, statedCompany);
                if (narrowed.matched) {
                    const c = narrowed.candidate;
                    const question = `Are you at ${c.address}?`;
                    return matchedResponse(
                        res,
                        {
                            locationId: c.locationId,
                            locationName: c.locationName,
                            companyId: c.companyId,
                            companyName: c.companyName,
                            address: c.address,
                            street: '', city: '', state: '', postalCode: ''
                        },
                        narrowed.score,
                        question,
                        `The company narrowed it to one site. Say exactly: "${question}" A yes `
                        + 'verifies them — then call this again with location_id set to '
                        + 'st_location_id, copied exactly.'
                    );
                }

                // The company did not separate them, or we hold nothing under that name.
                // Never offer another address either way.
                if (partsGiven) {
                    return sendSuccessResponse(
                        res,
                        {
                            ...baseVars(),
                            reason: narrowed.reason,
                            st_address_stage: 'terminal',
                            candidate_count: String(candidates.length),
                            distinct_company_count: String(companyCount)
                        },
                        'The company did not identify one of these sites, and this was the last '
                        + 'ask. Go to Step D. Do not ask again.',
                        200
                    );
                }
                return sendSuccessResponse(
                    res,
                    {
                        ...baseVars(),
                        reason: narrowed.reason,
                        st_address_stage: 'parts',
                        candidate_count: String(candidates.length),
                        distinct_company_count: String(companyCount)
                    },
                    'That company did not identify one of these sites. Do not name any company or '
                    + 'address. Now ask for the address one part at a time — street number, then '
                    + 'street name, then state, then city, then ZIP — and call this again with '
                    + 'all five.',
                    200
                );
            }

            // First time through: ask which company, and read nothing aloud.
            const question = 'I have several locations under different companies. '
                + 'Could you tell me the company name?';
            return sendSuccessResponse(
                res,
                {
                    ...baseVars(),
                    reason: 'ambiguous',
                    st_address_stage: 'company',
                    st_company_question: question,
                    // Deliberately NOT the candidate addresses. Reading other customers'
                    // addresses to a caller we have not identified is a privacy leak.
                    // Counts only, so the prompt knows whether the company can separate them.
                    candidate_count: String(candidates.length),
                    distinct_company_count: String(companyCount)
                },
                `Several sites match. Say exactly: "${question}" Read no address and no company `
                + 'aloud. Then call this again with company set to what they say.',
                200
            );
        }

        // ---- nothing matched ---------------------------------------------------
        // One more ask, and only one. A second miss ends the flow.
        const alreadyTriedParts = Boolean(street || city || postal);
        if (alreadyTriedParts) {
            return sendSuccessResponse(
                res,
                { ...baseVars(), reason: result.reason, st_address_stage: 'terminal' },
                'No site could be confirmed. Go to Step D and do not ask again.',
                200
            );
        }

        return sendSuccessResponse(
            res,
            { ...baseVars(), reason: result.reason, st_address_stage: 'parts' },
            'No matching address on file. Ask for the address one part at a time — street number, '
            + 'then street name, then state, then city, then ZIP. Wait for each answer. Then call '
            + 'this again with all five.',
            200
        );
    } catch (error) {
        // Fail soft, for the reason in the header comment: the agent must always have a
        // next line, and "ask for the address" is a safe one.
        console.error('Error in st-match-address route:', error);
        const scoped = Boolean(String((req.query || {}).agent_id || '').trim());
        return sendSuccessResponse(
            res,
            scoped
                ? { ...baseVars(), reason: 'lookup_error' }
                : { address_found: false, reason: 'lookup_error' },
            'Could not check the address. Ask the caller to confirm the service address.',
            200
        );
    }
});

module.exports = router;
