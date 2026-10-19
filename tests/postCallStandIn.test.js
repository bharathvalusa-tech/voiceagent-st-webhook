const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');
const { loadWithMocks, REPO } = require('./harness');

/**
 * POST /webhook/retell, call_analyzed, for a verified caller whose address matches no site
 * we trust. Before: "Only tier 3 matches found - manual review needed", no job — while the
 * Apps Script had already rung the technician (call_2a4ba2fff98fbc9e4c3e87e2a49). After: the
 * job goes on the tenant's stand-in site with the company and the caller's address first.
 */
const BRACONIER = 'agent_41010d0d8c1f46cf1d9dfcddbf';
const STAND_IN = '2776463860629889';

// Shaped like call_2a4ba2fff…: caller ID on file as Clara Ai (two sites, none chosen), the
// caller named Allison Perkins and an address no site matches.
const callFor = (overrides = {}) => ({
    call_id: `call_test_${Math.random().toString(36).slice(2)}`,
    agent_id: BRACONIER,
    call_type: 'phone_call',
    from_number: '+14155201480',
    duration_ms: 121395,
    retell_llm_dynamic_variables: {
        st_lookup_ok: 'true', st_customer_verified: 'true', st_customer_reason: 'needs_location',
        st_needs_location: 'true', st_company_name: 'Clara Ai', st_company_id: '2776463859696001',
        st_location_id: ''
    },
    collected_dynamic_variables: { serviceLineId: '450', serviceLineName: 'Plumbing' },
    transcript_with_tool_calls: [],
    call_analysis: {
        custom_analysis_data: {
            customerName: 'Allison Perkins', company_name: 'Allison Perkins',
            serviceAddress: '3600 South Gilvin Street, Englewood',
            issue_description: 'Floor drain backing up', is_emergency: true,
            emergency_type: 'Plumbing', intake_complete: true, is_existing_customer: false
        }
    },
    ...overrides
});

const TIER3 = [
    { tier: 3, locationId: 1495451524856000, locationName: 'ACPASSETMANAGEMENT,L', companyName: 'PARAMOUNT PROPERTY', tierReason: 'no_strong_match' },
    { tier: 3, locationId: 1495446033660096, locationName: 'AOSMITH', companyName: 'A O SMITH WPC', tierReason: 'no_strong_match' }
];

async function run(call, { candidates = TIER3, standIn = STAND_IN } = {}) {
    delete process.env.API_GATEWAY_URL;
    const jobs = [];
    const notices = [];
    const background = [];
    const realConfig = require(path.join(REPO, 'src/config/environment'));
    const { houseNumberOf, buildAddressQuery } = require(path.join(REPO, 'src/services/googleMapsService'));

    const router = loadWithMocks(path.join(REPO, 'src/routes/webhook/retell'), {
        '@vercel/functions': { waitUntil: (p) => background.push(p) },
        '../../services/retellService': { getCall: async () => call },
        '../../services/googleMapsService': { validateAddress: async () => null, buildAddressQuery, houseNumberOf },
        '../../services/customerMatchingService': { findCustomerWithConfidence: async () => candidates },
        '../../controllers/serviceTradeController': {
            createJob: async (data) => { jobs.push(data); return { jobId: 999, jobNumber: 'T-1' }; }
        },
        '../../services/emailNotificationService': {
            sendJobNotification: async (n) => { notices.push(n); return { skipped: true }; },
            isSessionAuthError: () => false,
            sendInternalAlert: async () => {}
        },
        '../../services/gptDisambiguationService': { disambiguateLocations: async () => null },
        '../../services/supabaseService': {
            getServiceTradeToken: async () => [{ agent_id: BRACONIER, auth_token: 'x', Name: 'Braconier' }],
            getJobConfig: async () => ({ create_emergency_jobs: true, create_non_emergency_jobs: false }),
            getLocationsForAgent: async () => []
        },
        '../serviceTrade/verifyCustomer': {
            resolveCustomer: async () => ({ st_lookup_ok: 'true', st_customer_verified: 'true', st_location_id: '' }),
            verifyAgentIds: new Set()
        },
        '../../config/environment': {
            ...realConfig,
            unlistedSiteLocationIds: standIn ? { [BRACONIER]: standIn } : {}
        }
    });

    const app = express();
    app.use(express.json());
    app.use('/', router);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const log = console.log; const err = console.error;
    console.log = () => {}; console.error = () => {};
    try {
        await fetch(`http://127.0.0.1:${server.address().port}/retell`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'call_analyzed', call })
        });
        await Promise.all(background);
    } finally {
        console.log = log; console.error = err;
        server.close();
    }
    return { jobs, notices };
}

test('call_2a4ba2fff: a verified caller with only weak guesses gets a job on the stand-in', async () => {
    const { jobs } = await run(callFor());
    assert.strictEqual(jobs.length, 1, 'a job is created instead of manual review');
    assert.strictEqual(String(jobs[0].locationId), STAND_IN);
    assert.match(jobs[0].description, /SITE NOT ON FILE - customer: Clara Ai \(company 2776463859696001\)/);
    assert.match(jobs[0].description, /service address given by caller: 3600 South Gilvin Street, Englewood/);
    assert.match(jobs[0].description, /Caller named the company as: Allison Perkins/);
});

test('no candidates at all: the verified caller still gets the stand-in', async () => {
    const { jobs } = await run(callFor(), { candidates: [] });
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(String(jobs[0].locationId), STAND_IN);
});

test('an address with no house number never books the stand-in', async () => {
    const call = callFor();
    call.call_analysis.custom_analysis_data.serviceAddress = 'Englewood';
    const { jobs } = await run(call);
    assert.strictEqual(jobs.length, 0);
});

test('a tenant with no stand-in keeps manual review', async () => {
    const { jobs, notices } = await run(callFor(), { standIn: null });
    assert.strictEqual(jobs.length, 0);
    assert.ok(notices.some((n) => n.details?.reasonCode === 'low_confidence_matches'));
});

test('an unverified caller is never booked on the stand-in', async () => {
    const call = callFor({
        from_number: '+15555550123',
        retell_llm_dynamic_variables: { st_lookup_ok: 'true', st_customer_verified: 'false', st_needs_address: 'true' }
    });
    const { jobs } = await run(call);
    assert.strictEqual(jobs.length, 0);
});

test('a strong candidate keeps the old path and never falls back to the stand-in', async () => {
    // Tier 1 means a site we trust. Whatever the existing checks then decide, the stand-in
    // is only for calls where no trusted site exists.
    const strong = [{ tier: 1, locationId: 1495451106949312, locationName: 'Guard and Grace',
        companyName: 'Guard and Grace', address: '1801 California Street, Denver, CO 80202', tierReason: 'phone_exact' }];
    const { jobs } = await run(callFor(), { candidates: strong });
    assert.ok(jobs.every((j) => String(j.locationId) !== STAND_IN));
});
