const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadWithMocks, REPO } = require('./harness');

/**
 * POST /st-verify-customer — the customer gate for Braconier after-hours dispatch.
 *
 * The route is loaded with `express` replaced by a stub whose Router() records the handler,
 * so the handler can be invoked directly with a fake req/res. ServiceTrade is stubbed at
 * globalThis.fetch, which is also how the URL is asserted — the search term reaching
 * ServiceTrade is the thing that broke in production, so it is checked explicitly.
 */

let handler = null;

const expressStub = () => {
    const stub = () => {};
    stub.Router = () => ({
        post: (routePath, fn) => { if (routePath === '/st-verify-customer') handler = fn; }
    });
    return stub;
};

const loadRoute = (getAuthToken = async () => 'PHPSESSID-TEST') => {
    handler = null;
    loadWithMocks(path.join(REPO, 'src/routes/serviceTrade/verifyCustomer'), {
        express: expressStub(),
        '../../controllers/serviceTradeController': { getAuthToken }
    });
    assert.ok(handler, 'route handler was not captured');
    return handler;
};

// Captures the URL so the search term can be asserted, and replies with `body`.
const stubFetch = (body, { ok = true, raw = null } = {}) => {
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        return {
            ok,
            status: ok ? 200 : 500,
            statusText: ok ? 'OK' : 'Server Error',
            text: async () => (raw !== null ? raw : JSON.stringify(body))
        };
    };
    return calls;
};

const invoke = async ({ body = {}, query = {} } = {}) => {
    let captured = null;
    const res = {
        status(code) { this._code = code; return this; },
        json(payload) { captured = { code: this._code, ...payload }; return this; }
    };
    await handler({ body, query }, res);
    return captured;
};

const QUERY = { from_number: '+13038758807', agent_id: 'agent_41010d0d8c1f46cf1d9dfcddbf' };

// ---- fixtures ---------------------------------------------------------------

// The live record from the shared curl, verbatim in shape.
const contact = (over = {}) => ({
    id: 1857926091590849,
    firstName: 'BRAD ', lastName: 'JACKSON',
    phoneNumber: '', mobile: '303-875-8807', alternatePhone: '',
    email: 'bljackson007@aol.com', type: 'on-site', status: 'public',
    location: 1495451569699008, company: 1491402832315521,
    locations: [1495451569699008], companies: [],
    ...over
});

const location = (over = {}) => ({
    id: 1495451569699008, name: 'POSITIVEAPPROACH', status: 'active',
    address: '1495451569699008_11',
    addressStreet: '115 STRONG STREET', addressCity: 'BRIGHTON',
    addressState: 'CO', addressPostalCode: '80601',
    company: 1491402832315521,
    ...over
});

const company = (over = {}) => ({
    id: 1491402832315521, name: 'POSITIVE APPROACH', status: 'active',
    customer: true, vendor: false, partsVendor: false, managingAccountId: null,
    ...over
});

const sideloaded = ({ contacts, locations, companies, totalRecords } = {}) => ({
    meta: { page: 1, totalPages: 1, limit: 100, totalRecords: totalRecords ?? 1 },
    data: {
        contacts: contacts || [contact()],
        locations: locations || [location()],
        addresses: [{ id: '1495451569699008_11', street: '115 STRONG STREET', city: 'BRIGHTON', state: 'CO', postalCode: '80601' }],
        companies: companies || [company()]
    }
});

// The same record as the documented (non-sideloaded) endpoint returns it.
const documented = () => ({
    data: {
        totalRecords: 1,
        contacts: [{
            id: 1857926091590849,
            firstName: 'BRAD ', lastName: 'JACKSON',
            phoneNumber: '', mobile: '303-875-8807',
            email: 'bljackson007@aol.com', status: 'public',
            company: { id: 1491402832315521, name: 'POSITIVE APPROACH', status: 'active', customer: true },
            locations: [{
                id: 1495451569699008, name: 'POSITIVEAPPROACH', status: 'active',
                address: { street: '115 STRONG STREET', city: 'BRIGHTON', state: 'CO', postalCode: '80601' },
                company: { id: 1491402832315521 }
            }]
        }]
    }
});

const twoLocations = () => sideloaded({
    contacts: [contact({ locations: [1495451569699008, 2000000000000001] })],
    locations: [
        location(),
        location({
            id: 2000000000000001, name: 'POSITIVE APPROACH WAREHOUSE', address: null,
            addressStreet: '4820 NOME STREET', addressCity: 'DENVER',
            addressState: 'CO', addressPostalCode: '80239'
        })
    ]
});

// ---- tests ------------------------------------------------------------------

test('a customer with one location verifies and comes back for read-back', async () => {
    loadRoute();
    stubFetch(sideloaded());
    const r = await invoke({ query: QUERY, body: { attempt: 1 } });

    assert.equal(r.code, 200);
    assert.equal(r.data.st_customer_verified, 'true');
    assert.equal(r.data.st_customer_reason, 'needs_confirmation');
    assert.equal(r.data.st_needs_confirmation, 'true');
    assert.equal(r.data.st_contact_name, 'Brad Jackson', 'ALL CAPS and the trailing space are cleaned for TTS');
    assert.equal(r.data.st_company_name, 'Positive Approach');
    assert.equal(r.data.st_location_id, '1495451569699008');
    assert.equal(r.data.st_location_address, '115 STRONG STREET, BRIGHTON, CO, 80601');
});

test('the company customer flag is the gate, not the presence of a contact', async () => {
    loadRoute();
    stubFetch(sideloaded({ companies: [company({ customer: false })] }));
    const r = await invoke({ query: QUERY, body: { attempt: 1 } });

    assert.equal(r.code, 200);
    assert.equal(r.data.st_customer_verified, 'false');
    assert.equal(r.data.st_customer_reason, 'company_not_customer');
    assert.equal(r.data.st_retry_allowed, 'true', 'attempt 1 earns one retry');
});

test('the retry is offered once and only once', async () => {
    loadRoute();
    stubFetch(sideloaded({ contacts: [], locations: [], companies: [], totalRecords: 0 }));
    const first = await invoke({ query: QUERY, body: { attempt: 1 } });
    assert.equal(first.data.st_customer_reason, 'no_contact_match');
    assert.equal(first.data.st_retry_allowed, 'true');

    const second = await invoke({ query: QUERY, body: { attempt: 2, search: '7205551234' } });
    assert.equal(second.data.st_retry_allowed, 'false', 'attempt 2 is terminal');
    assert.equal(second.data.st_customer_verified, 'false');
});

test('both response shapes produce the same verdict', async () => {
    loadRoute();
    stubFetch(sideloaded());
    const a = await invoke({ query: QUERY, body: { attempt: 1 } });

    loadRoute();
    stubFetch(documented());
    const b = await invoke({ query: QUERY, body: { attempt: 1 } });

    for (const key of ['st_customer_verified', 'st_customer_reason', 'st_contact_name',
        'st_company_name', 'st_location_id', 'st_location_address']) {
        assert.equal(a.data[key], b.data[key], `${key} differs between the two shapes`);
    }
});

test('more than one location asks the caller, and does not guess', async () => {
    loadRoute();
    stubFetch(twoLocations());
    const r = await invoke({ query: QUERY, body: { attempt: 1 } });

    assert.equal(r.data.st_needs_location, 'true');
    assert.equal(r.data.st_customer_reason, 'needs_location');
    assert.equal(r.data.st_location_id, '', 'no location may be chosen before the caller names one');
    assert.match(r.data.st_location_options, /STRONG STREET/);
    assert.match(r.data.st_location_options, /NOME STREET/);
});

test('a decisive spoken location resolves it', async () => {
    loadRoute();
    stubFetch(twoLocations());
    const r = await invoke({ query: QUERY, body: { attempt: 1, spoken_location: '4820 Nome Street, Denver' } });

    assert.equal(r.data.st_customer_verified, 'true');
    assert.equal(r.data.st_customer_reason, 'verified');
    assert.equal(r.data.st_location_id, '2000000000000001');
});

test('a vague spoken location ends the call — one attempt, no re-ask', async () => {
    loadRoute();
    stubFetch(twoLocations());
    const r = await invoke({ query: QUERY, body: { attempt: 1, spoken_location: 'the other one' } });

    assert.equal(r.data.st_customer_verified, 'false');
    assert.equal(r.data.st_customer_reason, 'location_unresolved');
    assert.equal(r.data.st_retry_allowed, 'false', 'a failed location match never earns another try');
    assert.equal(r.data.st_location_id, '');
});

test('every phone format reduces to the same ten-digit search term', async () => {
    for (const input of ['+13038758807', '3038758807', '(303) 875-8807', '303-875-8807 ext 450']) {
        loadRoute();
        const calls = stubFetch(sideloaded());
        await invoke({ query: { ...QUERY, from_number: input }, body: { attempt: 1 } });
        assert.equal(calls.length, 1);
        assert.match(calls[0], /[?&]search=3038758807(&|$)/, `${input} did not reduce to ten digits`);
    }
});

test('"+1" is a 200 asking for a number, not the 400 that broke the live call', async () => {
    for (const bad of ['+1', '', '8758807']) {
        loadRoute();
        const calls = stubFetch(sideloaded());
        const r = await invoke({ query: { ...QUERY, from_number: bad }, body: { attempt: 1 } });

        assert.equal(r.code, 200, `${JSON.stringify(bad)} must never produce a 4xx`);
        assert.equal(r.data.st_customer_reason, 'needs_phone');
        assert.equal(r.data.st_retry_allowed, 'true');
        assert.equal(calls.length, 0, 'an unusable number must not reach ServiceTrade');
    }
});

test('an empty upstream body is a lookup error, never a refusal', async () => {
    loadRoute();
    stubFetch(null, { raw: '' });
    const r = await invoke({ query: QUERY, body: { attempt: 1 } });

    assert.equal(r.code, 200);
    assert.equal(r.data.st_customer_reason, 'lookup_error',
        'an outage must stay distinguishable from "not a customer" — the gate refuses on one and not the other');
    assert.equal(r.data.st_retry_allowed, 'false');
});

test('a ServiceTrade 500 is a lookup error too', async () => {
    loadRoute();
    stubFetch(null, { ok: false, raw: '' });
    const r = await invoke({ query: QUERY, body: { attempt: 1 } });
    assert.equal(r.data.st_customer_reason, 'lookup_error');
});

test('a missing ServiceTrade token does not refuse the caller', async () => {
    loadRoute(async () => { throw new Error('No ServiceTrade token found for this agent'); });
    stubFetch(sideloaded());
    const r = await invoke({ query: QUERY, body: { attempt: 1 } });
    assert.equal(r.data.st_customer_reason, 'lookup_error');
});

test('the sideloaded query carries _sideload and both contact statuses', async () => {
    loadRoute();
    const calls = stubFetch(sideloaded());
    await invoke({ query: QUERY, body: { attempt: 1 } });

    const url = decodeURIComponent(calls[0]);
    assert.match(url, /_sideload=contact\.locations,contact\.companies,location\.company/);
    assert.match(url, /status=public,private/);
    assert.match(url, /^https:\/\/api\.servicetrade\.com\/api\/contact\?/);
});

test('args nested under a JSON-string `args` are read the same as at the root', async () => {
    loadRoute();
    stubFetch(twoLocations());
    const r = await invoke({
        query: QUERY,
        body: { args: JSON.stringify({ attempt: 1, spoken_location: '4820 Nome Street, Denver' }) }
    });
    assert.equal(r.data.st_location_id, '2000000000000001');
});
