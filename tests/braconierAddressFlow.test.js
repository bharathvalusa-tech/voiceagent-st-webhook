const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadWithMocks, REPO } = require('./harness');

const {
    matchAgainstRows,
    narrowByCompany,
    rowCompany,
    MAX_OFFERED,
    MIN_COMPANY_CHARS,
    COMPANY_MATCH_THRESHOLD
} = require(path.join(REPO, 'src/services/addressMatchService'));

const BRACONIER = 'agent_41010d0d8c1f46cf1d9dfcddbf';
const ADAPTIVE = 'agent_efbe503faedf1bf516f961979f';

// Rows shaped like real servicetrade_locations rows, including the `raw_response`
// column — that is where the company lives, and the whole company question depends on it.
const row = (over = {}) => {
    const { company, ...rest } = over;
    const base = {
        servicetrade_id: 1,
        name: 'Site',
        status: 'active',
        street: '1617 S Acoma St',
        city: 'Denver',
        state: 'CO',
        postal_code: '80223',
        ...rest
    };
    return {
        ...base,
        raw_response: company === null
            ? {}
            : { company: company || { id: 1491381770298817, name: 'DENVER PUBLIC SCHOOLS', status: 'active' } }
    };
};

// The real shape that drove this work: several sites on one street, under two different
// companies, close enough that the address alone cannot separate them.
const TWO_COMPANIES_ONE_STREET = [
    row({
        servicetrade_id: 11, street: '2285 S Federal Boulevard', postal_code: '80219',
        company: { id: 1491381746953985, name: 'DENVER PUBLIC SCHOOLS', status: 'active' }
    }),
    row({
        servicetrade_id: 22, street: '2285 S Federal Blvd', postal_code: '80219',
        company: { id: 1757485264544961, name: 'MPC CONSTRUCTION', status: 'active' }
    })
];

// ------------------------------------------------------- the company on a row

test('a matched site carries the company from raw_response', () => {
    const rows = [row({ servicetrade_id: 99 })];
    const result = matchAgainstRows('1617 S Acoma St, Denver, CO 80223', rows);

    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.location.companyName, 'DENVER PUBLIC SCHOOLS');
    assert.strictEqual(result.location.companyId, '1491381770298817');
});

test('a row with no company still matches, and reports empty rather than throwing', () => {
    // A site with no company does not stop a job being booked; the agent just confirms
    // the address alone instead of naming a company.
    const rows = [row({ servicetrade_id: 99, company: null })];
    const result = matchAgainstRows('1617 S Acoma St, Denver, CO 80223', rows);

    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.location.companyName, '');
    assert.strictEqual(result.location.companyId, '');
});

test('rowCompany tolerates a missing raw_response entirely', () => {
    assert.deepStrictEqual(rowCompany({}), { companyId: '', companyName: '' });
    assert.deepStrictEqual(rowCompany({ raw_response: null }), { companyId: '', companyName: '' });
});

// ------------------------------------------------------------- the tie branch

test('two sites under different companies come back ambiguous, with the companies attached', () => {
    const result = matchAgainstRows('2285 South Federal Boulevard', TWO_COMPANIES_ONE_STREET);

    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.reason, 'ambiguous');
    const names = result.candidates.map((c) => c.companyName).sort();
    assert.deepStrictEqual(names, ['DENVER PUBLIC SCHOOLS', 'MPC CONSTRUCTION']);
});

test('the ambiguous branch rounds its scores like every other branch', () => {
    // These two were raw floats while matched/matched_exact rounded to three places, so
    // the same score read differently depending on which branch produced it.
    const result = matchAgainstRows('2285 South Federal Boulevard', TWO_COMPANIES_ONE_STREET);

    assert.strictEqual(result.reason, 'ambiguous');
    for (const value of [result.score, result.runnerUp]) {
        assert.strictEqual(value, Number(value.toFixed(3)), `${value} is not rounded to 3 places`);
    }
});

test('the candidate list is capped at MAX_OFFERED', () => {
    const many = Array.from({ length: 9 }, (_, i) => row({
        servicetrade_id: 100 + i,
        street: '410 Kingsway Boulevard',
        postal_code: '80223',
        company: { id: 500 + i, name: `COMPANY ${i}`, status: 'active' }
    }));
    const result = matchAgainstRows('410 Kingsway Boulevard', many);

    assert.strictEqual(result.reason, 'ambiguous');
    assert.strictEqual(result.candidates.length, MAX_OFFERED);
});

// ------------------------------------------------------- narrowing by company

const candidatesOf = (rows, spoken) => matchAgainstRows(spoken, rows).candidates;

test('an exact company name picks its site', () => {
    const candidates = candidatesOf(TWO_COMPANIES_ONE_STREET, '2285 South Federal Boulevard');
    const narrowed = narrowByCompany(candidates, 'MPC Construction');

    assert.strictEqual(narrowed.matched, true);
    assert.strictEqual(narrowed.reason, 'company_exact');
    assert.strictEqual(narrowed.candidate.locationId, 22);
});

test('a close company name picks its site above the 0.6 threshold', () => {
    const candidates = candidatesOf(TWO_COMPANIES_ONE_STREET, '2285 South Federal Boulevard');
    const narrowed = narrowByCompany(candidates, 'Denver Public School');

    assert.strictEqual(narrowed.matched, true);
    assert.strictEqual(narrowed.reason, 'company_fuzzy');
    assert.strictEqual(narrowed.candidate.locationId, 11);
    assert.ok(narrowed.score >= COMPANY_MATCH_THRESHOLD);
});

test('a company we hold nothing for is not found, and picks nobody', () => {
    // The live failure this prevents: a caller named a company with zero rows and heard
    // another customer's address read back as theirs.
    const candidates = candidatesOf(TWO_COMPANIES_ONE_STREET, '2285 South Federal Boulevard');
    const narrowed = narrowByCompany(candidates, 'Northgate Marine Welding');

    assert.strictEqual(narrowed.matched, false);
    assert.strictEqual(narrowed.reason, 'company_not_found');
    assert.strictEqual(narrowed.candidate, undefined);
});

test('a company name under the minimum length is never searched', () => {
    const candidates = candidatesOf(TWO_COMPANIES_ONE_STREET, '2285 South Federal Boulevard');
    const narrowed = narrowByCompany(candidates, 'DP');

    assert.strictEqual(narrowed.matched, false);
    assert.strictEqual(narrowed.reason, 'company_too_short');
    assert.ok(MIN_COMPANY_CHARS >= 4);
});

test('two sites under the SAME company name are not separated by the company', () => {
    // Braconier holds three records called DENVER PUBLIC SCHOOLS. Asking the company
    // cannot split them, so say so rather than picking one by position.
    const sameCompany = [
        row({ servicetrade_id: 31, street: '2285 S Federal Boulevard', company: { id: 1, name: 'DENVER PUBLIC SCHOOLS' } }),
        row({ servicetrade_id: 32, street: '2285 S Federal Blvd', company: { id: 2, name: 'DENVER PUBLIC SCHOOLS' } })
    ];
    const candidates = candidatesOf(sameCompany, '2285 South Federal Boulevard');
    const narrowed = narrowByCompany(candidates, 'Denver Public Schools');

    assert.strictEqual(narrowed.matched, false);
    assert.strictEqual(narrowed.reason, 'company_does_not_separate');
});

// --------------------------------------------------- the one-tenant guarantee

const serviceWithTenants = (configured, byAgent) => loadWithMocks(
    path.join(REPO, 'src/services/addressMatchService'),
    {
        '../config/environment': { locationSyncAgentIds: configured },
        './supabaseService': {
            getLocationsForAgent: async (agentId) => byAgent[agentId] || []
        }
    }
);

test('with two tenants configured, only the one passed in is searched', async () => {
    // THE LEAK. This used to union every configured tenant's rows and score them
    // together, so a Braconier caller could win a match on an Adaptive site and a
    // technician would be sent to another company's customer. No human catches this by
    // eye — only this test does.
    const svc = serviceWithTenants([ADAPTIVE, BRACONIER], {
        [ADAPTIVE]: [row({ servicetrade_id: 777, street: '1617 S Acoma St', company: { id: 9, name: 'ADAPTIVE CUSTOMER' } })],
        [BRACONIER]: [row({ servicetrade_id: 888, street: '2285 S Federal Boulevard', company: { id: 8, name: 'DENVER PUBLIC SCHOOLS' } })]
    });

    const asBraconier = await svc.matchSpokenAddress('1617 S Acoma St, Denver, CO 80223', BRACONIER);
    assert.strictEqual(asBraconier.matched, false, 'an Adaptive address must not match for Braconier');

    const asAdaptive = await svc.matchSpokenAddress('1617 S Acoma St, Denver, CO 80223', ADAPTIVE);
    assert.strictEqual(asAdaptive.matched, true);
    assert.strictEqual(asAdaptive.location.locationId, 777);
});

test('with two tenants configured, naming no tenant searches nothing', async () => {
    const svc = serviceWithTenants([ADAPTIVE, BRACONIER], {
        [ADAPTIVE]: [row({ servicetrade_id: 777 })],
        [BRACONIER]: [row({ servicetrade_id: 888 })]
    });

    const result = await svc.matchSpokenAddress('1617 S Acoma St, Denver, CO 80223', '');
    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.reason, 'no_sync_agent_configured');
});

test('with one tenant configured, the old no-argument call still works', async () => {
    // Adaptive calls this without an agent id and must behave exactly as before.
    const svc = serviceWithTenants([ADAPTIVE], {
        [ADAPTIVE]: [row({ servicetrade_id: 777 })]
    });

    const result = await svc.matchSpokenAddress('1617 S Acoma St, Denver, CO 80223');
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.location.locationId, 777);
});

test('a tenant that is not in the sync list is refused, not searched', async () => {
    const svc = serviceWithTenants([ADAPTIVE], { [ADAPTIVE]: [row({ servicetrade_id: 777 })] });

    const result = await svc.matchSpokenAddress('1617 S Acoma St', BRACONIER);
    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.reason, 'agent_not_synced');
});

// ------------------------------------------------------------------ the route

const routeApp = async (mocks) => {
    const express = require('express');
    const router = loadWithMocks(path.join(REPO, 'src/routes/serviceTrade/matchAddress'), mocks);
    const app = express();
    app.use(express.json());
    app.use('/', router);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    return { port: server.address().port, close: () => server.close() };
};

const post = async (port, body, agentId = BRACONIER) => {
    const qs = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : '';
    const res = await fetch(`http://127.0.0.1:${port}/st-match-address${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
};

const realNarrow = narrowByCompany;

test('one match reads the address back and asks the company', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({
                matched: true,
                score: 0.93,
                location: {
                    locationId: 888, locationName: 'ACOMA', locationStatus: 'active',
                    address: '1617 S Acoma St, Denver, CO 80223',
                    street: '1617 S Acoma St', city: 'Denver', state: 'CO', postalCode: '80223',
                    companyId: '1491381770298817', companyName: 'DENVER PUBLIC SCHOOLS'
                }
            })
        }
    });
    try {
        const { body } = await post(app.port, { address: '1617 South Acoma' });
        assert.strictEqual(body.data.address_found, 'true');
        assert.strictEqual(body.data.st_company_name, 'DENVER PUBLIC SCHOOLS');
        assert.strictEqual(body.data.st_location_id, '888');
        assert.match(body.data.st_company_question, /Is that location under DENVER PUBLIC SCHOOLS\?/);
        // The address IS read back — it is the one the caller just gave us.
        assert.match(body.data.st_company_question, /1617 S Acoma St/);
        // A no leads to the parts ask, not a refusal.
        assert.match(body.message, /one part at a time/);
    } finally { app.close(); }
});

test('several matches read nothing aloud and ask for the company', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({
                matched: false, reason: 'ambiguous', score: 0.95, runnerUp: 0.95,
                candidates: [
                    { locationId: 11, address: '2285 S Federal Boulevard, Denver', score: 0.95, companyId: '1', companyName: 'DENVER PUBLIC SCHOOLS' },
                    { locationId: 22, address: '2285 S Federal Blvd, Denver', score: 0.95, companyId: '2', companyName: 'MPC CONSTRUCTION' }
                ]
            })
        }
    });
    try {
        const { body } = await post(app.port, { address: '2285 South Federal' });
        assert.strictEqual(body.data.address_found, 'false');
        assert.strictEqual(body.data.st_address_stage, 'company');
        assert.strictEqual(body.data.candidate_count, '2');
        assert.strictEqual(body.data.distinct_company_count, '2');

        // No address and no company name may leave here — the caller is not identified yet.
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes('2285 S Federal'), 'candidate addresses must not be returned');
        assert.ok(!serialized.includes('MPC CONSTRUCTION'), 'candidate companies must not be returned');
    } finally { app.close(); }
});

test('naming the company narrows it and reads that one address back', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({
                matched: false, reason: 'ambiguous', score: 0.95, runnerUp: 0.95,
                candidates: [
                    { locationId: 11, address: '2285 S Federal Boulevard, Denver', score: 0.95, companyId: '1', companyName: 'DENVER PUBLIC SCHOOLS' },
                    { locationId: 22, address: '2285 S Federal Blvd, Denver', score: 0.95, companyId: '2', companyName: 'MPC CONSTRUCTION' }
                ]
            })
        }
    });
    try {
        const { body } = await post(app.port, { address: '2285 South Federal', company: 'MPC Construction' });
        assert.strictEqual(body.data.address_found, 'true');
        assert.strictEqual(body.data.st_location_id, '22');
        assert.strictEqual(body.data.st_company_name, 'MPC CONSTRUCTION');
        assert.match(body.data.st_company_question, /Are you at 2285 S Federal Blvd, Denver\?/);
        // The id goes back exactly, never spoken.
        assert.match(body.message, /location_id set to st_location_id, copied exactly/);
    } finally { app.close(); }
});

test('a company we hold nothing for goes to the parts ask, offering no address', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({
                matched: false, reason: 'ambiguous', score: 0.95, runnerUp: 0.95,
                candidates: [
                    { locationId: 11, address: '2285 S Federal Boulevard, Denver', score: 0.95, companyId: '1', companyName: 'DENVER PUBLIC SCHOOLS' },
                    { locationId: 22, address: '2285 S Federal Blvd, Denver', score: 0.95, companyId: '2', companyName: 'MPC CONSTRUCTION' }
                ]
            })
        }
    });
    try {
        const { body } = await post(app.port, { address: '2285 South Federal', company: 'Northgate Marine Welding' });
        assert.strictEqual(body.data.address_found, 'false');
        assert.strictEqual(body.data.reason, 'company_not_found');
        assert.strictEqual(body.data.st_address_stage, 'parts');
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes('2285 S Federal'), 'no other address may be offered');
        assert.ok(!serialized.includes('DENVER PUBLIC SCHOOLS'), 'no other company may be named');
    } finally { app.close(); }
});

test('the parts ask joins the components and matches', async () => {
    let seen = null;
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async (spoken) => {
                seen = spoken;
                return {
                    matched: true, score: 0.99,
                    location: {
                        locationId: 55, locationName: 'ACOMA', locationStatus: 'active',
                        address: '1617 S Acoma St, Denver, CO 80223',
                        street: '1617 S Acoma St', city: 'Denver', state: 'CO', postalCode: '80223',
                        companyId: '7', companyName: 'DENVER PUBLIC SCHOOLS'
                    }
                };
            }
        }
    });
    try {
        const { body } = await post(app.port, {
            street: '1617 S Acoma St', city: 'Denver', state: 'CO', postal_code: '80223'
        });
        assert.strictEqual(seen, '1617 S Acoma St, Denver, CO, 80223');
        assert.strictEqual(body.data.address_found, 'true');
        assert.strictEqual(body.data.st_location_id, '55');
    } finally { app.close(); }
});

test('a missed parts ask is terminal — no third ask', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({ matched: false, reason: 'no_candidate_above_threshold' })
        }
    });
    try {
        const { body } = await post(app.port, { street: '9 Nowhere Road', city: 'Denver', postal_code: '80000' });
        assert.strictEqual(body.data.address_found, 'false');
        assert.strictEqual(body.data.st_address_stage, 'terminal');
        assert.match(body.message, /Go to Step D and do not ask again/);
    } finally { app.close(); }
});

test('a first miss on a whole address asks for the parts, not Step D', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({ matched: false, reason: 'no_candidate_above_threshold' })
        }
    });
    try {
        const { body } = await post(app.port, { address: 'the big building' });
        assert.strictEqual(body.data.st_address_stage, 'parts');
    } finally { app.close(); }
});

test('without an agent id the route answers in the original Adaptive shape', async () => {
    // The legacy contract is pinned in tests/addressMatch.test.js and must not move.
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async (spoken) => ({
                matched: true, score: 0.95,
                location: { locationId: 42, locationName: 'Site', locationStatus: 'active', address: spoken, street: '', city: '', state: '', postalCode: '' }
            })
        }
    });
    try {
        const { body } = await post(app.port, { address: '77 Sandpiper Drive' }, '');
        assert.strictEqual(body.data.address_found, true, 'boolean, not a string');
        assert.strictEqual(body.data.address, '77 Sandpiper Drive');
        assert.strictEqual(body.data.st_address_stage, undefined, 'no Braconier keys on the legacy shape');
    } finally { app.close(); }
});

test('every Braconier response ships every key, so no mustache is left unresolved', async () => {
    // Retell renders an ABSENT dynamic variable as a literal {{mustache}} in the prompt.
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({ matched: false, reason: 'no_candidate_above_threshold' })
        }
    });
    try {
        const { body } = await post(app.port, { address: 'nowhere' });
        for (const key of [
            'address_found', 'reason', 'st_address_stage', 'st_company_question',
            'st_location_id', 'st_location_name', 'st_company_id', 'st_company_name',
            'st_matched_address', 'street', 'city', 'state', 'postal_code',
            'match_score', 'candidate_count', 'distinct_company_count'
        ]) {
            assert.ok(key in body.data, `${key} must ship on every response`);
        }
    } finally { app.close(); }
});

test('a thrown error still answers 200 with a next line', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => { throw new Error('supabase down'); }
        }
    });
    try {
        const { status, body } = await post(app.port, { address: '31 Larkspur Road' });
        assert.strictEqual(status, 200);
        assert.strictEqual(body.data.reason, 'lookup_error');
        assert.match(body.message, /Ask the caller to confirm/);
    } finally { app.close(); }
});

test('step 3 is terminal when the company fails to separate the ties', async () => {
    // The loop this closes: a parts call that tied went to the company question, the
    // company missed, and the agent was sent back to the parts ask — which tied again.
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({
                matched: false, reason: 'ambiguous', score: 0.95, runnerUp: 0.95,
                candidates: [
                    { locationId: 11, address: '2285 S Federal Blvd', score: 0.95, companyId: '1', companyName: 'DENVER PUBLIC SCHOOLS' },
                    { locationId: 22, address: '2285 S Federal Boulevard', score: 0.95, companyId: '2', companyName: 'MPC CONSTRUCTION' }
                ]
            })
        }
    });
    try {
        const parts = { street: '2285 S Federal', city: 'Denver', state: 'CO', postal_code: '80219' };
        const first = await post(app.port, parts);
        assert.strictEqual(first.body.data.st_address_stage, 'company', 'the ties ask the company once');

        const second = await post(app.port, { ...parts, company: 'Nothing We Hold' });
        assert.strictEqual(second.body.data.st_address_stage, 'terminal', 'and a miss ends it');
        assert.match(second.body.message, /Do not ask again/);
    } finally { app.close(); }
});

test('before the parts are given, a failed company narrowing asks for them', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({
                matched: false, reason: 'ambiguous', score: 0.95, runnerUp: 0.95,
                candidates: [
                    { locationId: 11, address: '2285 S Federal Blvd', score: 0.95, companyId: '1', companyName: 'DENVER PUBLIC SCHOOLS' },
                    { locationId: 22, address: '2285 S Federal Boulevard', score: 0.95, companyId: '2', companyName: 'MPC CONSTRUCTION' }
                ]
            })
        }
    });
    try {
        const { body } = await post(app.port, { address: '2285 South Federal', company: 'Nothing We Hold' });
        assert.strictEqual(body.data.st_address_stage, 'parts');
        assert.match(body.message, /one part at a time/);
    } finally { app.close(); }
});

test('the parts ask names all five fields in order', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            narrowByCompany: realNarrow,
            matchSpokenAddress: async () => ({ matched: false, reason: 'no_candidate_above_threshold' })
        }
    });
    try {
        const { body } = await post(app.port, { address: 'the big building' });
        assert.strictEqual(body.data.st_address_stage, 'parts');
        assert.match(body.message, /street number, then street name, then state, then city, then ZIP/);
        assert.match(body.message, /Wait for each answer/);
    } finally { app.close(); }
});
