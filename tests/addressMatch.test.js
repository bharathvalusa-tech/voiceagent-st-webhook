const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadWithMocks, REPO } = require('./harness');

const {
    matchAgainstRows,
    rowAddress,
    MATCH_THRESHOLD,
    DECISIVE_MARGIN
} = require(path.join(REPO, 'src/services/addressMatchService'));

// Synthetic rows shaped like real servicetrade_locations rows. The SHAPES are what
// matter — three suites on one street, one street twice — not the street names.
const row = (over = {}) => ({
    servicetrade_id: 6398685,
    name: 'Residence(31 Larkspur Rd.)',
    status: 'active',
    street: '31 Larkspur Road',
    city: 'Toronto',
    state: 'ON',
    postal_code: 'M5R 2L4',
    ...over
});

const SUITES_ON_ONE_STREET = [
    row({ servicetrade_id: 1, name: 'Suite 605', street: '410 Kingsway Boulevard Suite 605', postal_code: 'M5V 1R9' }),
    row({ servicetrade_id: 2, name: 'Suite 400', street: '410 Kingsway Boulevard, Suite #400', postal_code: 'M5V1R9' }),
    row({ servicetrade_id: 3, name: 'Suite 100', street: '410 Kingsway Boulevard, Suite #100', postal_code: 'M5V 1R9' })
];

// ------------------------------------------------------------------ scoring

test('an exact address resolves to its own row', () => {
    const rows = [row(), row({ servicetrade_id: 7069786, street: '22 Riverbend Street', postal_code: 'M5E 1Z8' })];
    const result = matchAgainstRows(rowAddress(rows[0]), rows);

    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.location.locationId, 6398685);
});

test('an abbreviated street still matches the expanded record', () => {
    // The fuzzy pass that did not exist before: ServiceTrade's `search=` misses this.
    const rows = [row({ servicetrade_id: 2412959312296641, street: '4100 Riverbend Street', postal_code: 'M2N 0G3' })];
    const result = matchAgainstRows('4100 Riverbend St Toronto', rows);

    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.location.locationId, 2412959312296641);
});

test('a caller who omits city and postal code still matches', () => {
    const result = matchAgainstRows('31 Larkspur Road', [row()]);
    assert.strictEqual(result.matched, true);
});

test('an unknown address returns no match, not a best guess', () => {
    const result = matchAgainstRows('999 Nowhere Boulevard, Springfield', [row()]);

    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.reason, 'no_candidate_above_threshold');
});

test('a different house number on the same street is disqualified', () => {
    // Two house numbers on one street are two buildings, however well the street
    // scores. Without the house-number guard the street similarity carries it.
    const rows = [row({ servicetrade_id: 11, street: '150 Thornbury Court', city: 'East Gwillimbury', postal_code: 'L9N 0M8' })];
    const result = matchAgainstRows('152 Thornbury Court, East Gwillimbury, ON', rows);

    assert.strictEqual(result.matched, false);
});

test('a caller who leads with the unit still matches', () => {
    // People say "Unit 117, 260 Maple Hollow" as often as the other way round. Taking the
    // first number in the string read 117 as the house number and disqualified the row.
    const rows = [row({ servicetrade_id: 117, street: '260 Maple Hollow Square, Unit 117' })];

    for (const spoken of [
        '260 Maple Hollow Square Unit 117 Toronto',
        'Unit 117, 260 Maple Hollow Square, Toronto',
        'Suite 117 260 Maple Hollow Square Toronto',
        'Apt 117, 260 Maple Hollow Square, Toronto'
    ]) {
        const result = matchAgainstRows(spoken, rows);
        assert.strictEqual(result.matched, true, `should match: ${spoken}`);
        assert.strictEqual(result.location.locationId, 117);
    }

    // Street and unit alone, with no city at all, still scores below the threshold —
    // and should. The house-number guard no longer rejects it, but there is genuinely
    // little to go on. Lowering MATCH_THRESHOLD to catch this is not worth it: 0.72 is
    // what gives 0 wrong locations across all 395 rows.
    assert.strictEqual(matchAgainstRows('Apt 117 260 Maple Hollow Square', rows).matched, false);
});

test('a unit number never stands in for the house number', () => {
    // The guard must still reject a genuinely different building, so stripping units
    // cannot become "ignore all numbers".
    const rows = [row({ servicetrade_id: 260, street: '260 Maple Hollow Square' })];
    const result = matchAgainstRows('270 Maple Hollow Square, Unit 260', rows);

    assert.strictEqual(result.matched, false, '270 is not 260, whatever the unit says');
});

// ------------------------------------------------------------------ ambiguity

test('several suites on one street return ambiguous, so the agent asks', () => {
    const result = matchAgainstRows('410 Kingsway Boulevard Toronto', SUITES_ON_ONE_STREET);

    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.reason, 'ambiguous');
    assert.ok(result.candidates.length >= 2, 'candidates are counted for the agent');
});

test('naming the suite resolves what the street alone could not', () => {
    const result = matchAgainstRows('410 Kingsway Boulevard Suite 605, Toronto, ON, M5V 1R9', SUITES_ON_ONE_STREET);

    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.location.locationId, 1);
});

test('an exact match wins even when a runner-up scores close', () => {
    // hasAddressQueryMatch floors every row sharing a street shape at 0.95, so on this
    // account the margin test alone can never separate suites in one tower. The
    // exact-match rule is what makes a fully-stated address usable.
    const result = matchAgainstRows(rowAddress(SUITES_ON_ONE_STREET[1]), SUITES_ON_ONE_STREET);

    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.reason, 'matched_exact');
    assert.strictEqual(result.location.locationId, 2);
});

test('two rows with the identical address stay ambiguous', () => {
    // Nothing can separate identical strings. 24 of the 395 live rows are duplicates like
    // this, and a re-ask is the only honest answer.
    const rows = [row({ servicetrade_id: 101 }), row({ servicetrade_id: 102 })];
    const result = matchAgainstRows(rowAddress(rows[0]), rows);

    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.reason, 'ambiguous');
});

// ------------------------------------------------------------------ guards

test('empty and unusable input are refused without touching the rows', () => {
    assert.strictEqual(matchAgainstRows('', [row()]).reason, 'no_address_given');
    assert.strictEqual(matchAgainstRows('   ', [row()]).reason, 'no_address_given');
    assert.strictEqual(matchAgainstRows('31 Larkspur Road', []).reason, 'no_rows_for_agent');
});

test('the thresholds are the tuned values', () => {
    // Changing either changes live behaviour: measured over all 395 rows, these give
    // 371 self-resolutions, 0 wrong locations, and 24 ambiguous — all 24 being rows whose
    // address is literally duplicated.
    assert.strictEqual(MATCH_THRESHOLD, 0.72);
    assert.strictEqual(DECISIVE_MARGIN, 0.08);
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

const post = async (port, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/st-match-address`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
};

test('the route reads args nested as a JSON string', async () => {
    // args_at_root is true on After Hours and false on Office Hours for the same endpoint,
    // so both shapes have to work.
    const app = await routeApp({
        '../../services/addressMatchService': {
            matchSpokenAddress: async (spoken) => ({
                matched: true,
                score: 0.95,
                location: { locationId: 42, locationName: 'Site', locationStatus: 'active', address: spoken, street: '', city: '', state: '', postalCode: '' }
            })
        }
    });
    try {
        const { status, body } = await post(app.port, { args: JSON.stringify({ address: '77 Sandpiper Drive Toronto' }) });
        assert.strictEqual(status, 200);
        assert.strictEqual(body.data.address_found, true);
        assert.strictEqual(body.data.address, '77 Sandpiper Drive Toronto');
    } finally { app.close(); }
});

test('the route never leaks candidate addresses to the caller', async () => {
    const app = await routeApp({
        '../../services/addressMatchService': {
            matchSpokenAddress: async () => ({
                matched: false,
                reason: 'ambiguous',
                candidates: [
                    { locationId: 1, address: '410 Kingsway Boulevard Suite 605', score: 0.95 },
                    { locationId: 2, address: '410 Kingsway Boulevard Suite 400', score: 0.95 }
                ]
            })
        }
    });
    try {
        const { body } = await post(app.port, { address: '410 Kingsway Boulevard' });
        assert.strictEqual(body.data.address_found, false);
        assert.strictEqual(body.data.ambiguous, true);
        assert.strictEqual(body.data.candidate_count, 2);
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes('Suite 605'), 'other customers\' addresses must not be returned');
        assert.match(body.message, /unit or suite number, or the postal code/);
    } finally { app.close(); }
});

test('a thrown error still answers 200 with something to say', async () => {
    // A tool that errors mid-call leaves Clara with no next line.
    const app = await routeApp({
        '../../services/addressMatchService': {
            matchSpokenAddress: async () => { throw new Error('supabase down'); }
        }
    });
    try {
        const { status, body } = await post(app.port, { address: '31 Larkspur Road' });
        assert.strictEqual(status, 200);
        assert.strictEqual(body.data.address_found, false);
        assert.strictEqual(body.data.reason, 'lookup_error');
        assert.match(body.message, /Ask the caller to confirm/);
    } finally { app.close(); }
});
