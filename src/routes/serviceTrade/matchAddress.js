const express = require('express');
const router = express.Router();
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const { matchSpokenAddress } = require('../../services/addressMatchService');

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
 * Accepts either a whole address or the three re-ask components:
 *   { address: "150 Thornbury Court, East Gwillimbury, ON" }
 *   { street: "150 Thornbury Court", city: "East Gwillimbury", state: "ON", postal_code: "L9N 0M8" }
 *
 * ALWAYS answers 200 with a spoken-language `message` the agent can act on. A tool that
 * errors mid-call leaves Clara with nothing to say, so failure is reported as "no match"
 * rather than as an HTTP error — the caller is then asked for the address, which is
 * exactly what would have happened anyway.
 */
router.post('/st-match-address', async (req, res) => {
    try {
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
                    return String(value).trim();
                }
            }
            return '';
        };

        // A whole address if we were given one, otherwise assemble the components.
        const whole = pick('address', 'service_address', 'spoken_address', 'full_address');
        const street = pick('street', 'address_line1', 'street_address');
        const city = pick('city');
        const state = pick('state', 'province');
        const postal = pick('postal_code', 'postalCode', 'zip', 'postal');

        const spoken = whole || [street, city, state, postal].filter(Boolean).join(', ');

        console.log('st-match-address received', {
            payloadKeys: Object.keys(src),
            hasWholeAddress: Boolean(whole),
            components: { street: Boolean(street), city: Boolean(city), state: Boolean(state), postal: Boolean(postal) },
            spoken
        });

        if (!spoken) {
            return sendSuccessResponse(
                res,
                { address_found: false, reason: 'no_address_given' },
                'No address was provided. Ask the caller for the service address.',
                200
            );
        }

        const result = await matchSpokenAddress(spoken);

        if (!result.matched) {
            // Ambiguity is reported as its own reason so the agent can ask a narrowing
            // question rather than repeating the whole address ask.
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
    } catch (error) {
        // Fail soft, for the reason in the header comment: the agent must always have a
        // next line, and "ask for the address" is a safe one.
        console.error('Error in st-match-address route:', error);
        return sendSuccessResponse(
            res,
            { address_found: false, reason: 'lookup_error' },
            'Could not check the address. Ask the caller to confirm the service address.',
            200
        );
    }
});

module.exports = router;
