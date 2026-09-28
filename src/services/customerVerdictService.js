const { normalizePhone } = require('../utils/phone');

/**
 * Was this caller verified against ServiceTrade, and which location did that verdict name?
 *
 * WHY THIS EXISTS. `/webhook/retell` used to answer both questions from one place: the
 * post-call analyser's `is_existing_customer` boolean. On call_a20a1973331d6d375307e080089
 * (2026-09-26, Braconier) the pre-greeting lookup had already verified Steve Rupp of
 * Centennial Realty Advisors and returned `st_customer_verified: "true"` with
 * `st_needs_location: "true"` and two candidate sites. The agent never ran the branch that
 * picks one, so nothing mid-call re-asserted the verdict, and the analyser — reading only a
 * transcript in which no lookup tool appears — wrote `is_existing_customer: false`. The job
 * gate took that at face value and no work order was created for a live sewer overflow.
 *
 * THE POST-CALL CONTACT SEARCH ALWAYS RUNS. For an allowlisted agent this module asks
 * ServiceTrade again, by caller ID, on every call — whatever the variables Retell handed
 * back say, true or false or nothing at all. Those variables are a snapshot taken before the
 * caller spoke, written by a lookup that may have been ambiguous, by an agent that may have
 * skipped its branches, or by an analyser that inferred from a transcript. The search is the
 * only source that is current at the moment the job is created, and it is the one that
 * catches a caller added to ServiceTrade between the call and this webhook.
 *
 * WHAT EACH SOURCE IS ALLOWED TO DECIDE:
 *
 *   verified   Any source may assert TRUE, and one true is enough. Only the live search may
 *              say FALSE, and only when nothing else asserted true — a caller verified
 *              mid-call on a DIFFERENT number they stated (Branch 3 of the prompt) will not
 *              be found by a caller-ID search, and must not be refused for it.
 *   locationId First non-empty of: caller_details, the `st_customer` responses in the
 *              transcript, the pre-greeting variables, the live search. The mid-call values
 *              come first because those are what the caller heard read back.
 *
 * RESOLVING AN AMBIGUOUS ACCOUNT. When the search reports the account has several sites and
 * names none, it runs a SECOND time with the service address captured on the call, which is
 * the fuzzy match the agent should have made in-call. That pass may only ADD a location id;
 * its verdict is discarded, because an address that fails to match is a location problem and
 * never evidence that the contact is not a customer.
 *
 * `verified: null` means no source had evidence either way, and the caller keeps whatever
 * behaviour it had before this module existed — for Adaptive, which sets none of these
 * variables and is not on the allowlist, that is every call.
 *
 * A LOOKUP OUTAGE IS NOT A REFUSAL. The search speaks only when the mechanism worked
 * (`st_lookup_ok`). ServiceTrade being down leaves `verified` as whatever the call itself
 * said, never `false`.
 */

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0']);

const asBool = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
        return null;
    }
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (TRUE_WORDS.has(v)) return true;
        if (FALSE_WORDS.has(v)) return false;
    }
    return null;
};

// A ServiceTrade location id is digits. The agent has been seen putting a company name, an
// agent version and a literal `{{st_location_id}}` into id-shaped fields, and POST /job with
// any of those fails the whole job rather than the one field.
const asLocationId = (value) => {
    const id = String(value ?? '').trim();
    return /^\d+$/.test(id) ? id : '';
};

const firstObject = (...candidates) => candidates.find((c) => c && typeof c === 'object') || {};

const firstNonEmpty = (...values) => values.map((v) => String(v ?? '').trim()).find(Boolean) || '';

/**
 * Every `st_customer` response in the transcript, not just the last one.
 *
 * `collected_dynamic_variables` keeps only the most recent response per tool, so a third
 * lookup that came back `no_contact_match` erases a second that verified the account. The
 * transcript keeps them all. A verified response carrying a location id beats a verified
 * response without one — same rule as `resolve_st_verdict` in `api/braconier.py:151`.
 */
const scanToolResults = (call) => {
    const entries = Array.isArray(call?.transcript_with_tool_calls) ? call.transcript_with_tool_calls : [];
    let best = null;

    for (const entry of entries) {
        if (!entry || entry.role !== 'tool_call_result') continue;

        let payload;
        try {
            payload = JSON.parse(entry.content);
        } catch (error) {
            continue;
        }

        // `/st-verify-customer` answers through sendSuccessResponse, so the variables sit
        // under `data`. A tool wired to return them flat is read too.
        const data = firstObject(payload?.data, payload);
        if (asBool(data.st_customer_verified) !== true) continue;

        if (!best || (!best.locationId && asLocationId(data.st_location_id))) {
            best = { locationId: asLocationId(data.st_location_id) };
        }
    }

    return best;
};

/**
 * The live ServiceTrade contact search, plus the address pass when the account is ambiguous.
 *
 * @returns {Promise<{verified: boolean|null, locationId: string, ok: boolean, reason: string}>}
 */
const runSearch = async ({ verify, agentId, phone, spokenLocation }) => {
    const unavailable = { verified: null, locationId: '', ok: false, reason: 'unavailable' };

    let vars;
    try {
        const result = await verify({ agentId, rawTerm: phone, spokenLocation: '', attempt: 1 });
        vars = firstObject(result?.vars);
    } catch (error) {
        return unavailable;
    }

    if (asBool(vars.st_lookup_ok) === false) return unavailable;

    const verified = asBool(vars.st_customer_verified);
    const reason = String(vars.st_customer_reason || '');
    if (verified === null) return unavailable;

    // `location_unresolved` on THIS pass means one thing only: the contact matched, their
    // company carries ServiceTrade's `customer` flag, and the account has no service location
    // on file. `resolveCustomer` reports that as unverified because the IN-CALL path needs
    // Clara to stop talking about dispatch — but the question this gate asks is "is this a
    // customer", and ServiceTrade just said yes. Blocking the job on it would also contradict
    // the standing decision that a location we cannot match is dispatched anyway rather than
    // being terminal (CLAUDE.md, reversed 2026-08-24). The location question is answered
    // downstream by address matching, which is where it belongs.
    //
    // Only pass 1 reaches here and pass 1 sends no spoken_location, so this reason cannot be
    // the OTHER `location_unresolved` — a spoken address that matched nothing.
    if (verified === false && reason === 'location_unresolved') {
        return { verified: true, locationId: '', ok: true, reason };
    }

    // Every other false stands, and `company_not_customer` in particular. That is Braconier's
    // own rule — after hours they dispatch for accounts they already service — decided on the
    // ServiceTrade company's `customer` flag rather than on anything a model inferred. A
    // contact existing is not the same as that contact being a customer.
    if (verified === false) {
        return { verified: false, locationId: '', ok: true, reason };
    }

    let locationId = asLocationId(vars.st_location_id);

    // Verified, but the account has several sites and the first pass named none. Ask again
    // with the address the call actually captured — the fuzzy match the agent skipped.
    if (!locationId && asBool(vars.st_needs_location) === true && spokenLocation) {
        try {
            const second = await verify({ agentId, rawTerm: phone, spokenLocation, attempt: 1 });
            const secondVars = firstObject(second?.vars);
            // Only an id, never a verdict: matchAgainstRows returning no decisive winner
            // makes this response read `st_customer_verified: "false"`, and that is a
            // statement about the address, not about the contact.
            if (asBool(secondVars.st_customer_verified) === true) {
                locationId = asLocationId(secondVars.st_location_id);
            }
        } catch (error) {
            // The account is still verified. Job creation falls back to address matching.
        }
    }

    return { verified: true, locationId, ok: true, reason };
};

/**
 * @param {object}   input
 * @param {object}   input.call            the webhook's `call` object
 * @param {object}   input.dynamicVars     collected_dynamic_variables, already merged
 * @param {string}   input.agentId         the agent the webhook arrived for
 * @param {boolean}  input.allowLookup     may this agent drive a live ServiceTrade search
 * @param {string}   input.spokenLocation  the service address captured on the call
 * @param {Function} input.verify          resolveCustomer, injectable for tests
 * @returns {Promise<{verified: boolean|null, locationId: string, source: string, searched: boolean}>}
 */
async function resolveCustomerVerdict({ call, dynamicVars, agentId, allowLookup, spokenLocation, verify }) {
    const collected = firstObject(dynamicVars);
    const preGreeting = firstObject(call?.retell_llm_dynamic_variables);

    // 1. caller_details. The prompt's own bridge: the agent copies the lookup's answer into
    //    dynamic variables the moment verification succeeds, so it survives a dropped call.
    //    Only `true` is read — the tool is never called on a failed lookup, so a false here
    //    is an absence dressed as a verdict.
    const storedVerified = asBool(collected.customerVerified ?? collected.isExistingCustomer) === true;

    // 2. The lookup responses themselves.
    const fromTool = scanToolResults(call);

    // 3. The pre-greeting webhook. This is the source that would have saved
    //    call_a20a1973331d6d375307e080089: it held `st_customer_verified: "true"` for the
    //    whole call and nothing on the job path had ever read it.
    const preGreetingVerified = asBool(preGreeting.st_customer_verified) === true;

    const callSource = storedVerified ? 'caller_details'
        : fromTool ? 'st_customer_tool_result'
            : preGreetingVerified ? 'inbound_lookup_variables'
                : '';

    const callVerified = Boolean(callSource);
    const callLocationId = firstNonEmpty(
        storedVerified ? asLocationId(collected.locationId || collected.st_location_id) : '',
        fromTool ? fromTool.locationId : '',
        preGreetingVerified ? asLocationId(preGreeting.st_location_id) : ''
    );

    // 4. The live search. Unconditional for an allowlisted agent — see the header. It is the
    //    only source that is current, and the only one that can supply a location id when
    //    the agent never resolved one on the call.
    const phone = normalizePhone(call?.from_number || call?.fromNumber || '');
    const canSearch = Boolean(allowLookup) && typeof verify === 'function' && phone.length === 10;

    if (!canSearch) {
        return {
            verified: callVerified ? true : null,
            locationId: callLocationId,
            source: callSource || 'none',
            searched: false
        };
    }

    const search = await runSearch({ verify, agentId, phone, spokenLocation });

    const verified = callVerified ? true : search.verified;
    const locationId = firstNonEmpty(callLocationId, search.locationId);

    // What actually decided, so a log line says which of the five it was.
    const source = callVerified
        ? (locationId && locationId === search.locationId && !callLocationId
            ? `${callSource}+post_call_search_location`
            : callSource)
        : search.ok
            ? 'post_call_search'
            : 'post_call_search_unavailable';

    return { verified: verified ?? null, locationId, source, searched: true };
}

module.exports = { resolveCustomerVerdict, asLocationId };
