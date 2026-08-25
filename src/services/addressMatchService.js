const config = require('../config/environment');
const supabaseService = require('./supabaseService');
const {
    normalizeText,
    addressSimilarity,
    hasAddressQueryMatch,
    buildAddressSearchQueries,
    UNIT_TOKENS
} = require('../utils/address');

/**
 * Match a spoken address against the mirrored ServiceTrade locations.
 *
 * WHY THIS EXISTS: nothing fuzzy-matched a spoken address against our own data.
 * `searchByAddress` in customerMatchingService hands query strings to ServiceTrade's
 * `/location?search=` and scores only what the API returns — so when `search=` misses,
 * nothing is scored at all and the caller gets interrogated for components we already
 * hold.
 *
 * WHY LOCAL: the mirror is 395 rows for this account, every one carrying street, city and
 * state. One indexed read beats an API round-trip while an emergency caller waits.
 *
 * WHY IT REFUSES TIES: a score that fits two buildings identifies neither. Sending a
 * technician to the wrong address is worse than asking one more question, so anything
 * ambiguous comes back as no match and the agent re-asks.
 */

// Above this, a row is a candidate at all. Tuned against all 395 mirrored addresses —
// see tests/addressMatch.test.js.
const MATCH_THRESHOLD = 0.72;

// The winner must beat the runner-up by at least this much. Two Northvale towers on the
// same street score within a whisker of each other; that is a re-ask, not a match.
const DECISIVE_MARGIN = 0.08;

// A house number that disagrees is disqualifying, however well the street scores.
// Two different numbers on the same street are two different buildings.
//
// UNIT NUMBERS MUST GO FIRST. Callers lead with the unit as often as not — "Unit 117,
// 260 Maple Hollow Square" — and taking the first number in the string reads 117 as the
// house number, disagrees with 125, and disqualifies the very row the caller named.
const houseNumberOf = (address) => {
    const withoutUnits = normalizeText(address)
        .split(' ')
        .reduce((kept, token, i, tokens) => {
            // Drop a unit word and the number that follows it.
            if (UNIT_TOKENS.has(token)) return kept;
            if (i > 0 && UNIT_TOKENS.has(tokens[i - 1])) return kept;
            return kept.concat(token);
        }, [])
        .join(' ');

    const match = withoutUnits.match(/\b(\d+[a-z]?)\b/);
    return match ? match[1] : null;
};

// One string per row, in the order the agent speaks it.
const rowAddress = (row) => [row.street, row.city, row.state, row.postal_code]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');

const scoreRow = (spoken, row) => {
    const candidate = rowAddress(row);
    if (!candidate) return { score: 0, candidate };

    let score = addressSimilarity(spoken, candidate);

    // An exact street-query hit is stronger evidence than the blended similarity, which
    // gets diluted by city/state/postal text the caller may not have said.
    if (hasAddressQueryMatch(spoken, candidate)) {
        score = Math.max(score, 0.95);
    }

    // Disqualify a different house number outright rather than letting a strong street
    // match carry it.
    const spokenNumber = houseNumberOf(spoken);
    const candidateNumber = houseNumberOf(candidate);
    if (spokenNumber && candidateNumber && spokenNumber !== candidateNumber) {
        return { score: 0, candidate, rejected: 'house_number_mismatch' };
    }

    return { score, candidate };
};

/**
 * @param {string} spoken       the address as the caller gave it, or the re-ask components joined
 * @param {Array}  rows         mirrored location rows
 * @returns {{matched: boolean, reason: string, location?: Object, score?: number, runnerUp?: number}}
 */
function matchAgainstRows(spoken, rows) {
    const query = String(spoken || '').trim();
    if (!query) return { matched: false, reason: 'no_address_given' };
    if (!buildAddressSearchQueries(query).length) return { matched: false, reason: 'unusable_address' };
    if (!rows || rows.length === 0) return { matched: false, reason: 'no_rows_for_agent' };

    const scored = rows
        .map((row) => ({ row, ...scoreRow(query, row) }))
        .filter((entry) => entry.score >= MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { matched: false, reason: 'no_candidate_above_threshold' };

    const [best, runnerUp] = scored;

    // An exact match wins outright, whatever the runner-up scores.
    //
    // Without this rule the margin test is unwinnable on this data. hasAddressQueryMatch
    // floors every row sharing a street shape at 0.95, and the account holds many:
    // 410 Kingsway Boulevard exists as Suite 605, Suite 400 and Suite 100; 141 Wilson
    // Avenue appears under two postal codes; 52 Brookvale Street is recorded three ways.
    // A caller who gives the whole address, unit and all, has told us exactly which one —
    // refusing that to re-ask would be perverse.
    const EXACT = 0.995;
    if (best.score >= EXACT && !(runnerUp && runnerUp.score >= EXACT)) {
        return {
            matched: true,
            reason: 'matched_exact',
            score: Number(best.score.toFixed(3)),
            runnerUp: runnerUp ? Number(runnerUp.score.toFixed(3)) : null,
            location: {
                locationId: best.row.servicetrade_id,
                locationName: best.row.name || '',
                locationStatus: best.row.status || 'active',
                address: best.candidate,
                street: best.row.street || '',
                city: best.row.city || '',
                state: best.row.state || '',
                postalCode: best.row.postal_code || ''
            }
        };
    }

    // Two rows can be the SAME site duplicated, in which case the tie is not real.
    if (runnerUp && best.score - runnerUp.score < DECISIVE_MARGIN
        && String(runnerUp.row.servicetrade_id) !== String(best.row.servicetrade_id)) {
        return {
            matched: false,
            reason: 'ambiguous',
            score: best.score,
            runnerUp: runnerUp.score,
            candidates: scored.slice(0, 3).map((entry) => ({
                locationId: entry.row.servicetrade_id,
                address: entry.candidate,
                score: Number(entry.score.toFixed(3))
            }))
        };
    }

    return {
        matched: true,
        reason: 'matched',
        score: Number(best.score.toFixed(3)),
        runnerUp: runnerUp ? Number(runnerUp.score.toFixed(3)) : null,
        location: {
            locationId: best.row.servicetrade_id,
            locationName: best.row.name || '',
            locationStatus: best.row.status || 'active',
            address: best.candidate,
            street: best.row.street || '',
            city: best.row.city || '',
            state: best.row.state || '',
            postalCode: best.row.postal_code || ''
        }
    };
}

/**
 * Which tenant's mirrored rows to search.
 *
 * The rows are keyed by the agent the mirror is synced under, while the office-hours and
 * after-hours agents are the ones calling this. Reading the caller's own agent id would
 * find nothing, so the configured sync agent is the source.
 */
async function matchSpokenAddress(spoken) {
    const agentIds = config.locationSyncAgentIds || [];
    if (agentIds.length === 0) return { matched: false, reason: 'no_sync_agent_configured' };

    const rows = [];
    for (const agentId of agentIds) {
        rows.push(...await supabaseService.getLocationsForAgent(agentId));
    }

    const result = matchAgainstRows(spoken, rows);
    console.log(`[address-match] ${JSON.stringify({
        spoken,
        rows: rows.length,
        matched: result.matched,
        reason: result.reason,
        score: result.score ?? null,
        runnerUp: result.runnerUp ?? null,
        locationId: result.location ? result.location.locationId : null
    })}`);
    return result;
}

module.exports = {
    matchSpokenAddress,
    matchAgainstRows,
    rowAddress,
    MATCH_THRESHOLD,
    DECISIVE_MARGIN
};
