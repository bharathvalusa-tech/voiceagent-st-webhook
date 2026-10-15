const config = require('../config/environment');
const supabaseService = require('./supabaseService');
const {
    normalizeText,
    fuzzySimilarity,
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

// Most sites a caller is ever offered or narrowed between. A phone caller cannot hold a
// longer list, and an uncapped candidate set is a disclosure as much as it is unusable.
// Matrix pins the same number for the same reason — "the limit is the caller's working
// memory, not a CRM's shape" (SiteResolutionService.java, MAX_OFFERED).
const MAX_OFFERED = 4;

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

// The company a mirrored row belongs to.
//
// The flat columns do not carry it, but `raw_response` is the untouched GET /location
// payload and that always nests `company: { id, name, status }` — verified on 400 sampled
// Braconier rows, 400 of 400. supabaseService.getLocationsForAgent already selects the
// column, so this costs no extra query and no schema change.
//
// It matters because the caller is asked "is that under <company>?", and a matched site
// with no company name leaves the agent nothing to ask.
const rowCompany = (row) => {
    const company = row && row.raw_response && row.raw_response.company;
    return {
        companyId: company && company.id !== undefined && company.id !== null
            ? String(company.id)
            : '',
        companyName: company && company.name ? String(company.name) : ''
    };
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
                postalCode: best.row.postal_code || '',
                ...rowCompany(best.row)
            }
        };
    }

    // Two rows can be the SAME site duplicated, in which case the tie is not real.
    if (runnerUp && best.score - runnerUp.score < DECISIVE_MARGIN
        && String(runnerUp.row.servicetrade_id) !== String(best.row.servicetrade_id)) {
        return {
            matched: false,
            reason: 'ambiguous',
            // Rounded like every other branch. These two were raw floats while
            // matched/matched_exact rounded to three places, so the same score read
            // differently depending on which branch produced it.
            score: Number(best.score.toFixed(3)),
            runnerUp: Number(runnerUp.score.toFixed(3)),
            // Capped at MAX_OFFERED because a caller cannot hold a longer list, and
            // because an uncapped set is a disclosure. The route never speaks these —
            // it reports counts only. They exist so the COMPANY can narrow them.
            candidates: scored.slice(0, MAX_OFFERED).map((entry) => ({
                locationId: entry.row.servicetrade_id,
                locationName: entry.row.name || '',
                address: entry.candidate,
                score: Number(entry.score.toFixed(3)),
                ...rowCompany(entry.row)
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
            postalCode: best.row.postal_code || '',
            ...rowCompany(best.row)
        }
    };
}

// A stated company name is worth searching only once it could identify anybody. Below
// four characters a fuzzy compare matches most of the book, and the agent then reads a
// stranger's name back. Matrix pins the same floor for the same reason.
const MIN_COMPANY_CHARS = 4;

// The established company-name threshold. Not a new number: `companySimilarity >= 0.6`
// is already what decides a company match on the post-call path
// (src/routes/webhook/retell.js:219), so the live path and this one agree.
const COMPANY_MATCH_THRESHOLD = 0.6;

/**
 * Narrow several tied sites down to one, using the company the caller named.
 *
 * Two layers, both already in the codebase, and deliberately no third:
 *   1. exact, after normalisation — the same test customerMatchingService uses;
 *   2. fuzzySimilarity, the better of token-Jaccard and bigram-Dice, at 0.6.
 *
 * The LLM disambiguator (gptDisambiguationService) is NOT called here. It returns null
 * without an OpenAI key, so a flow that leaned on it would quietly stop narrowing in any
 * environment missing that key. These two layers have to be enough on their own.
 *
 * Returns the single winning candidate, or null. A tie between two candidates scoring
 * alike is NOT a winner — the same refusal the address matcher makes, for the same
 * reason.
 *
 * @param {Array}  candidates  the `candidates` array from an `ambiguous` result
 * @param {string} statedCompany  what the caller called their company
 */
function narrowByCompany(candidates, statedCompany) {
    const stated = String(statedCompany || '').trim();
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return { matched: false, reason: 'no_candidates' };
    }
    if (normalizeText(stated).replace(/\s/g, '').length < MIN_COMPANY_CHARS) {
        return { matched: false, reason: 'company_too_short' };
    }

    const exact = candidates.filter(
        (c) => c.companyName && normalizeText(c.companyName) === normalizeText(stated)
    );
    if (exact.length === 1) {
        return { matched: true, reason: 'company_exact', candidate: exact[0], score: 1 };
    }
    // Several candidates under the SAME company name is not a company problem — the
    // company cannot separate them, so say so rather than picking one by position.
    if (exact.length > 1) {
        return { matched: false, reason: 'company_does_not_separate', candidates: exact };
    }

    const scored = candidates
        .map((c) => ({ candidate: c, score: c.companyName ? fuzzySimilarity(stated, c.companyName) : 0 }))
        .filter((entry) => entry.score >= COMPANY_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { matched: false, reason: 'company_not_found' };

    const [best, runnerUp] = scored;
    if (runnerUp && best.score - runnerUp.score < DECISIVE_MARGIN) {
        const sameCompany = normalizeText(best.candidate.companyName)
            === normalizeText(runnerUp.candidate.companyName);
        return {
            matched: false,
            reason: sameCompany ? 'company_does_not_separate' : 'company_ambiguous',
            candidates: scored.map((e) => e.candidate)
        };
    }

    return {
        matched: true,
        reason: 'company_fuzzy',
        candidate: best.candidate,
        score: Number(best.score.toFixed(3))
    };
}

/**
 * Which tenant's mirrored rows to search.
 *
 * The rows are keyed by the agent the mirror is synced under, while the office-hours and
 * after-hours agents are the ones calling this. Reading the caller's own agent id would
 * find nothing, so the configured sync agent is the source.
 *
 * ONE TENANT, NEVER THE UNION. This used to loop every id in locationSyncAgentIds and
 * score the caller's words against all of them at once. That was harmless only because
 * exactly one tenant was ever configured. The moment a second one is — Braconier's
 * 4,843 sites alongside Adaptive's — a Braconier caller can win a match on an Adaptive
 * site and a technician is dispatched to another company's customer. So `agentId` is
 * now required in substance: an unknown or absent one searches nothing rather than
 * everything.
 *
 * @param {string} spoken   the address as the caller gave it
 * @param {string} agentId  the tenant whose mirror to search; must be a configured sync agent
 */
async function matchSpokenAddress(spoken, agentId) {
    const agentIds = config.locationSyncAgentIds || [];
    if (agentIds.length === 0) return { matched: false, reason: 'no_sync_agent_configured' };

    // Fall back to the single configured tenant ONLY while there is exactly one, so the
    // existing Adaptive caller keeps working unchanged. With several configured, a caller
    // that names no tenant gets nothing — never a scan across all of them.
    const target = String(agentId || '').trim() || (agentIds.length === 1 ? agentIds[0] : '');
    if (!target) return { matched: false, reason: 'no_sync_agent_configured' };
    if (!agentIds.includes(target)) return { matched: false, reason: 'agent_not_synced' };

    const rows = await supabaseService.getLocationsForAgent(target);

    const result = matchAgainstRows(spoken, rows);
    console.log(`[address-match] ${JSON.stringify({
        spoken,
        agentId: target,
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
    narrowByCompany,
    rowAddress,
    rowCompany,
    MATCH_THRESHOLD,
    DECISIVE_MARGIN,
    MAX_OFFERED,
    MIN_COMPANY_CHARS,
    COMPANY_MATCH_THRESHOLD
};
