const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');
const { loadWithMocks, REPO } = require('./harness');

/**
 * Every /st-match-address request from the Braconier calls of 2026-10-16 to 2026-10-18,
 * replayed through the REAL route and the REAL matcher, in the order the agent sent them.
 *
 * The arguments are copied from each call's transcript_with_tool_calls (Retell
 * GET /v2/get-call). The rows are the live Braconier mirror cut down to what these calls
 * touch: every site at 1801 California Street, every Guard and Grace and TAG RESTAURANT
 * site, and the companies a misheard name could wrongly land on. Against the full
 * 4,849-row mirror the same requests give the same answers.
 */
const ROWS = require('./fixtures/braconier-replay-rows.json');
const AGENT = 'agent_41010d0d8c1f46cf1d9dfcddbf';
const GUARD_AND_GRACE_ACTIVE = '1495451106949312';
const GUARD_AND_GRACE_INACTIVE = '1947444808635137';
// CLARA AI, 4925 Avalon Ridge Pkwy — where a customer's unlisted site is filed.
const STAND_IN = '2776463860629889';

async function replayApp() {
    const service = loadWithMocks(path.join(REPO, 'src/services/addressMatchService'), {
        './supabaseService': { getLocationsForAgent: async () => ROWS },
        '../config/environment': { locationSyncAgentIds: [AGENT], unlistedSiteLocationIds: { [AGENT]: STAND_IN } }
    });
    const router = loadWithMocks(path.join(REPO, 'src/routes/serviceTrade/matchAddress'), {
        '../../services/addressMatchService': service
    });
    const app = express();
    app.use(express.json());
    app.use('/', router);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const ask = async (args) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/st-match-address?agent_id=${AGENT}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args)
        });
        return (await res.json()).data;
    };
    return { ask, close: () => server.close() };
}

const quiet = (t) => {
    const log = console.log;
    t.before(() => { console.log = () => {}; });
    t.after(() => { console.log = log; });
};

// ------------------------------------------------ call_ea34e0ada… "Cardan Grace", 04:05 UTC

test('call_ea34e0ada: Guard and Grace is found on the FIRST ask now', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        // Was: company_not_found -> parts. "Cardan Grace Restaurant" scored 0.44 with the
        // word "Restaurant" in it; without it, 0.64.
        const first = await app.ask({ location: '1801 California Street, Denver, CO', company: 'Cardan Grace Restaurant' });
        assert.strictEqual(first.address_found, 'true');
        assert.strictEqual(first.st_location_id, GUARD_AND_GRACE_ACTIVE, 'the ACTIVE duplicate');
        assert.strictEqual(first.st_company_name, 'Guard and Grace');
    } finally { app.close(); }
});

test('call_ea34e0ada: the later asks resolve too, and to the active site', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        // Was: company_not_found. The caller said more than the stored name.
        const extra = await app.ask({ company: 'Guard and Grace Restaurant' });
        assert.strictEqual(extra.address_found, 'true');
        assert.strictEqual(extra.st_location_id, GUARD_AND_GRACE_ACTIVE);

        // Was: company_needs_location, "which address?" — for two rows of ONE site.
        const exact = await app.ask({ company: 'Guard and Grace' });
        assert.strictEqual(exact.address_found, 'true');
        assert.strictEqual(exact.st_location_id, GUARD_AND_GRACE_ACTIVE);

        // Was: matched the INACTIVE row 1947444808635137, which the job was then booked on.
        const both = await app.ask({ location: '1801 California Street, Denver, CO', company: 'Guard and Grace' });
        assert.strictEqual(both.st_location_id, GUARD_AND_GRACE_ACTIVE);
    } finally { app.close(); }
});

test('call_ea34e0ada: the confirm turn marks the caller verified', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        // The id the live call confirmed. Still a real site, so still accepted.
        const confirm = await app.ask({ location_id: GUARD_AND_GRACE_INACTIVE });
        assert.strictEqual(confirm.address_found, 'true');
        assert.strictEqual(confirm.st_customer_verified, 'true');
    } finally { app.close(); }
});

// --------------------------------------------- call_459b52daa… Nicholas, "God and Grace"

test('call_459b52daa: the address alone is still ambiguous and asks for the company', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        const first = await app.ask({ location: '1801 California Street, Denver, CO' });
        assert.strictEqual(first.reason, 'ambiguous');
        assert.strictEqual(first.st_address_stage, 'company');
        assert.match(first.st_company_question, /Could you tell me the company name\?/);
    } finally { app.close(); }
});

test('call_459b52daa: "God and Grace" on its own now finds Guard and Grace', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        // Sent without the location, exactly as the live call did. Was: company_not_found,
        // then the caller — a 12-year customer — was refused.
        const said = await app.ask({ company: 'God and Grace' });
        assert.strictEqual(said.address_found, 'true');
        assert.strictEqual(said.st_location_id, GUARD_AND_GRACE_ACTIVE);
        assert.match(said.st_company_question, /belonging to Guard and Grace\. Is that right\?/);
    } finally { app.close(); }
});

test('call_459b52daa: "Tag restaurant group" is a customer with no site here — filed at the stand-in', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        // Alone: TAG RESTAURANT holds many sites, so it asks which one.
        const alone = await app.ask({ company: 'Tag restaurant group' });
        assert.strictEqual(alone.reason, 'company_needs_location');
        assert.strictEqual(alone.distinct_company_count, '1');

        // With the address: none of TAG RESTAURANT's sites is at 1801 California Street.
        // It is still a customer, so the work is filed at the stand-in site under TAG
        // RESTAURANT — never borrowed from Guard and Grace next door.
        const withAddress = await app.ask({ location: '1801 California Street, Denver, CO', company: 'Tag restaurant group' });
        assert.strictEqual(withAddress.st_site_on_file, 'false');
        assert.strictEqual(withAddress.st_location_id, STAND_IN);
        assert.strictEqual(withAddress.st_company_name, 'TAG RESTAURANT');
        assert.strictEqual(withAddress.st_matched_address, '1801 California Street, Denver, CO');
        assert.notStrictEqual(withAddress.st_customer_verified, 'true', 'offered, not yet confirmed');
        assert.match(withAddress.st_company_question, /isn't one of the sites we have on file/);
    } finally { app.close(); }
});

// ------------------------------------------------------- call_817e7aa8… "Garden Grace"

test('call_817e7aa8: "Garden Grace" with the address finds Guard and Grace', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        // 0.56 against Guard and Grace, at most 0.15 against the other twelve companies at
        // 1801 California Street: a clear winner inside that building.
        const parts = await app.ask({ street: '1801 California Street', city: '', state: 'Colorado', postal_code: '', company: 'Garden Grace' });
        assert.strictEqual(parts.address_found, 'true');
        assert.strictEqual(parts.st_location_id, GUARD_AND_GRACE_ACTIVE);
    } finally { app.close(); }
});

test('call_817e7aa8: "Garden Grace" alone still finds nothing — the prompt must resend the address', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        // As the live call sent it. Across the whole book 0.56 is not enough: HILTON GARDEN
        // INN is 0.52. Refusing is right; the fix is the agent sending location again.
        const alone = await app.ask({ company: 'Garden Grace' });
        assert.strictEqual(alone.address_found, 'false');
        assert.strictEqual(alone.st_location_id, '');
    } finally { app.close(); }
});

// ---------------------------------------------------- names that must NOT match anyone

test('a generic or merely similar name does not borrow another customer', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        // 0.65 to PEACE LUTHERAN CHURCH — below the whole-book bar of 0.7.
        assert.strictEqual((await app.ask({ company: 'Grace Church' })).address_found, 'false');
        // Only generic words. Used to substring-match REGO RESTAURANT GROUP.
        const generic = await app.ask({ company: 'Restaurant Group' });
        assert.strictEqual(generic.address_found, 'false');
        assert.strictEqual(generic.reason, 'company_too_generic');
        // Not at 1801 California Street at all.
        const stranger = await app.ask({ location: '1801 California Street, Denver, CO', company: 'Acme Plumbing' });
        assert.strictEqual(stranger.address_found, 'false');
    } finally { app.close(); }
});

// ----------------------------------- calls whose site really is not on file — unchanged

test('call_ef0a75c6 and call_1840e33b: addresses we do not service still end at terminal', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        // Neither 1660 Federal Boulevard nor 1350 West Littleton Boulevard is in the
        // 4,849-row mirror. The refusal on these calls was correct.
        for (const parts of [
            { street: '1660 Federal Boulevard', city: 'Denver', state: 'Colorado', postal_code: '' },
            { street: '1350 West Littleton Boulevard', city: '', state: 'CO', postal_code: '' }
        ]) {
            const res = await app.ask(parts);
            assert.strictEqual(res.address_found, 'false');
            assert.strictEqual(res.st_address_stage, 'terminal');
        }
        // The agent passed the problem description as the location ("Drink leak.") and
        // an empty string. Neither may match a site.
        assert.strictEqual((await app.ask({ location: 'Drink leak.' })).st_address_stage, 'parts');
        assert.strictEqual((await app.ask({ location: '' })).reason, 'no_address_given');
    } finally { app.close(); }
});

// ---------------------------------- a customer's company with the site not on file

test('a known company at an address that is none of its sites is offered the stand-in', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        const offered = await app.ask({ location: '500 Main Street, Denver, CO 80202', company: 'Guard and Grace' });
        assert.strictEqual(offered.address_found, 'true');
        assert.strictEqual(offered.st_site_on_file, 'false');
        assert.strictEqual(offered.st_location_id, STAND_IN);
        assert.strictEqual(offered.st_company_name, 'Guard and Grace');
        assert.strictEqual(offered.st_company_id, '1491387824938433');

        // The same answer by parts.
        const parts = await app.ask({ street: '500 Main Street', city: 'Denver', state: 'CO', postal_code: '80202', company: 'God and Grace' });
        assert.strictEqual(parts.st_site_on_file, 'false');
        assert.strictEqual(parts.st_company_name, 'Guard and Grace');
    } finally { app.close(); }
});

test('confirming the stand-in verifies the caller under THEIR company and address', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        const confirmed = await app.ask({ location_id: STAND_IN, company_id: '1491387824938433', location: '500 Main Street, Denver, CO 80202' });
        assert.strictEqual(confirmed.st_customer_verified, 'true');
        assert.strictEqual(confirmed.st_site_on_file, 'false');
        assert.strictEqual(confirmed.st_location_id, STAND_IN);
        assert.strictEqual(confirmed.st_company_name, 'Guard and Grace');
        assert.strictEqual(confirmed.st_matched_address, '500 Main Street, Denver, CO 80202');
    } finally { app.close(); }
});

test('the stand-in confirm refuses an unknown company, and asks again without an address', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        const invented = await app.ask({ location_id: STAND_IN, company_id: '999', location: '500 Main Street, Denver, CO' });
        assert.strictEqual(invented.reason, 'company_id_unknown');
        assert.notStrictEqual(invented.st_customer_verified, 'true');

        const noAddress = await app.ask({ location_id: STAND_IN, company_id: '1491387824938433' });
        assert.strictEqual(noAddress.reason, 'unlisted_site_needs_address');
        assert.notStrictEqual(noAddress.st_customer_verified, 'true');
    } finally { app.close(); }
});

test('CLARA AI confirming its own site is an ordinary confirm, not an unlisted one', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        const own = await app.ask({ location_id: STAND_IN });
        assert.strictEqual(own.st_customer_verified, 'true');
        assert.strictEqual(own.st_site_on_file, '');
        assert.strictEqual(own.st_company_name, 'CLARA AI');
    } finally { app.close(); }
});

test('a problem description passed as the location never books the stand-in', async (t) => {
    quiet(t);
    const app = await replayApp();
    try {
        const res = await app.ask({ location: 'Drink leak.', company: 'Guard and Grace' });
        assert.notStrictEqual(res.st_site_on_file, 'false');
        assert.notStrictEqual(res.st_location_id, STAND_IN);
    } finally { app.close(); }
});
