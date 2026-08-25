const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadWithMocks, REPO } = require('./harness');

const OUTBOUND_AGENT = 'agent_c4123a0589c456c9f19e369340';

// ---------------------------------------------------------------- phone handling

test('normalizePhone compares on the last ten digits', () => {
    const { normalizePhone } = require(path.join(REPO, 'src/services/locationPhoneIndex'));
    assert.strictEqual(normalizePhone('+14169012663'), '4169012663');
    assert.strictEqual(normalizePhone('(416) 901-2663'), '4169012663');
    assert.strictEqual(normalizePhone('416-901-2663'), '4169012663');
    assert.strictEqual(normalizePhone('14169012663'), '4169012663');
    assert.strictEqual(
        normalizePhone('+14169012663'),
        normalizePhone('(416) 901-2663'),
        'E.164 and the ServiceTrade storage format must compare equal'
    );
});

test('normalizePhone strips extensions before taking the last ten digits', () => {
    const { normalizePhone } = require(path.join(REPO, 'src/utils/phone'));

    // Every one of these is a real stored value from servicetrade_locations. Reducing to
    // digits FIRST glues the extension on and slice(-10) then reads the wrong ten: the
    // first case used to normalize to '4082300450', a different and possibly real number.
    assert.strictEqual(normalizePhone('416-408-2300 ext 450'), '4164082300');
    assert.strictEqual(normalizePhone('905-374-4446 ext. 4306'), '9053744446');
    assert.strictEqual(normalizePhone('(416) 360-0599 ext. 202'), '4163600599');
    assert.strictEqual(normalizePhone('(416) 360-0599 ext.202'), '4163600599');
    assert.strictEqual(normalizePhone('416 555 1234 ext 9999'), '4165551234');
    assert.strictEqual(normalizePhone('4165551234x99'), '4165551234');
    assert.strictEqual(normalizePhone('4165551234 extension 7'), '4165551234');

    // An extension-bearing number and its plain form must compare equal, or the same
    // site reached two ways looks like two different callers.
    assert.strictEqual(
        normalizePhone('416-408-2300 ext 450'),
        normalizePhone('+14164082300')
    );

    // A bare 'ext' contributes no digits, so there is nothing to strip.
    assert.strictEqual(normalizePhone('416-555-1234 ext'), '4165551234');
    assert.strictEqual(normalizePhone(''), '');
    assert.strictEqual(normalizePhone(null), '');
});

test('the phone index indexes all four phone fields and refuses ambiguous numbers', () => {
    const { _buildIndex } = require(path.join(REPO, 'src/services/locationPhoneIndex'));
    const index = _buildIndex([
        { id: 1, name: 'Site A', status: 'active', phoneNumber: '(437) 990-5605', address: { street: '1 A St' } },
        { id: 2, name: 'Site B', status: 'inactive', primaryContact: { mobile: '905-251-8526' }, address: {} },
        { id: 3, name: 'HQ One', status: 'active', phoneNumber: '416-402-2601', address: {} },
        { id: 4, name: 'HQ Two', status: 'active', phoneNumber: '(416) 402-2601', address: {} }
    ]);

    assert.strictEqual(index.get('4379905605').length, 1);
    assert.strictEqual(index.get('9052518526')[0].locationStatus, 'inactive',
        'a location whose only number is primaryContact.mobile must still be indexed');
    assert.strictEqual(index.get('4164022601').length, 2, 'a shared number maps to both locations');
});

// ------------------------------------------------------- phone-first short-circuit

// The real matcher, with ServiceTrade stubbed and every search counted, so a test can
// assert which searches DID NOT run.
const phoneFirstMatcher = ({ contacts = [], locations = [], indexHit = null, indexHits = null }) => {
    const calls = { searchContacts: [], otherSearches: 0, getAllLocations: 0 };
    const svc = loadWithMocks(
        path.join(REPO, 'src/services/customerMatchingService'),
        {
            './serviceTradeService': {
                searchContacts: async (_t, query) => { calls.searchContacts.push(query); return contacts; },
                // Every non-phone search the fan-out can reach, counted together as
                // `otherSearches`: the point of the short-circuit is that NONE of them
                // runs when the phone already identifies one location.
                searchLocations: async () => { calls.otherSearches += 1; return locations; },
                searchLocationsByAddress: async () => { calls.otherSearches += 1; return locations; },
                searchLocationsByName: async () => { calls.otherSearches += 1; return locations; },
                searchLocationsByCompanyIds: async () => { calls.otherSearches += 1; return locations; },
                searchCompaniesByName: async () => { calls.otherSearches += 1; return []; },
                getAllLocations: async () => { calls.getAllLocations += 1; return locations; }
            },
            './locationPhoneIndex': {
                normalizePhone: require(path.join(REPO, 'src/utils/phone')).normalizePhone,
                lookupByPhone: async () => indexHit,
                // The short-circuit corroborates against EVERY location whose own line
                // carries the number, ambiguity included — a contact-derived hit on one
                // location must not settle while the same number is two other sites'
                // main line. Defaults to the single indexHit when not set explicitly.
                lookupAllByPhone: async () => (indexHits || (indexHit ? [indexHit] : []))
            }
        }
    );
    return { svc, calls };
};

// Same harness, but the location index throws — the short-circuit must decline to
// settle rather than trusting contact search on its own.
const loadIndexFailingMatcher = () => {
    const calls = { searchContacts: [], otherSearches: 0, getAllLocations: 0 };
    const svc = loadWithMocks(
        path.join(REPO, 'src/services/customerMatchingService'),
        {
            './serviceTradeService': {
                searchContacts: async (_t, q) => { calls.searchContacts.push(q); return [contactOn([6398701])]; },
                searchLocations: async () => { calls.otherSearches += 1; return []; },
                searchLocationsByAddress: async () => { calls.otherSearches += 1; return []; },
                searchLocationsByName: async () => { calls.otherSearches += 1; return []; },
                searchLocationsByCompanyIds: async () => { calls.otherSearches += 1; return []; },
                searchCompaniesByName: async () => { calls.otherSearches += 1; return []; },
                getAllLocations: async () => { calls.getAllLocations += 1; return []; }
            },
            './locationPhoneIndex': {
                normalizePhone: require(path.join(REPO, 'src/utils/phone')).normalizePhone,
                lookupByPhone: async () => null,
                lookupAllByPhone: async () => { throw new Error('index unavailable'); }
            }
        }
    );
    return { svc, calls };
};

const contactOn = (locationIds, phone = '(416) 901-2663') => ({
    id: 7, firstName: 'A', lastName: 'B', phone,
    locations: locationIds.map((id) => ({
        id, name: `Site ${id}`, status: 'active',
        address: { street: `${id} Main St`, city: 'Toronto', state: 'ON', postalCode: 'M1M1M1' },
        company: { id: 900, name: 'Co' }
    }))
});

test('a phone on exactly one location settles the match and skips every other search', async () => {
    const { svc, calls } = phoneFirstMatcher({ contacts: [contactOn([6398701])] });

    const candidates = await svc.findCustomerWithConfidence('tok', {
        phone: '+14169012663',
        // Deliberately supplied and deliberately ignored — a unique phone needs no
        // corroboration, and the address-direct filter must not get the chance to
        // discard the phone match in favour of a fuzzy address hit elsewhere.
        address: '999 Somewhere Else Rd',
        name: 'Someone',
        companyName: 'Some Co'
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].tier, 1);
    assert.strictEqual(candidates[0].tierReason, 'phone_match_single_location');
    assert.strictEqual(candidates[0].locationId, 6398701);
    assert.strictEqual(candidates[0].phoneExact, true);
    assert.deepStrictEqual(calls.searchContacts, ['4169012663'],
        'exactly one contact search, on the TEN-DIGIT form');
    assert.strictEqual(calls.otherSearches, 0, 'no address/name/company search may run');
});

test('an extension-bearing stored number still settles on the phone', async () => {
    const { svc, calls } = phoneFirstMatcher({
        contacts: [contactOn([6398702], '416-408-2300 ext 450')]
    });

    const candidates = await svc.findCustomerWithConfidence('tok', { phone: '+14164082300' });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].tierReason, 'phone_match_single_location');
    assert.deepStrictEqual(calls.searchContacts, ['4164082300']);
});

test('an ambiguous phone does NOT settle and falls through to the other searches', async () => {
    // 19 of the 110 distinct numbers on the live account sit on more than one location.
    const { svc, calls } = phoneFirstMatcher({ contacts: [contactOn([111, 222])] });

    const candidates = await svc.findCustomerWithConfidence('tok', {
        phone: '+14169012663',
        address: '111 Main St, Toronto, ON'
    });

    assert.ok(!candidates.some((c) => c.tierReason === 'phone_match_single_location'),
        'a number on two locations identifies neither');
    assert.ok(calls.otherSearches > 0, 'the address path must still run');
    assert.strictEqual(calls.searchContacts.filter((q) => q === '4169012663').length, 1,
        'the phone fetch is reused, not repeated, in the fan-out');
});

test('a contact-unique phone does NOT settle when other locations share the line', async () => {
    // The live case that caught this: 416-755-9518 is on a contact at
    // "Greenwin(2223 Eglinton Ave. E)" and is ALSO the main line of two further Greenwin
    // sites. Contact search alone sees one location and looks unique. searchByPhone only
    // consults the location index when contact search comes back empty, so without an
    // explicit corroboration step the short-circuit would settle on the contact's site
    // and skip the address search that used to correct it.
    const { svc, calls } = phoneFirstMatcher({
        contacts: [contactOn([518647497086337], '(416) 755-9518')],
        indexHits: [
            { locationId: 782066335447681, locationName: 'Greenwin(104 Bidewell)', locationStatus: 'active', address: {} },
            { locationId: 769495202794625, locationName: 'Greenwin(2225 Eglinton)', locationStatus: 'inactive', address: {} }
        ]
    });

    const candidates = await svc.findCustomerWithConfidence('tok', {
        phone: '+14167559518',
        address: '2223 Eglinton Ave. E'
    });

    // Asserted via `otherSearches`, not tierReason: the fan-out's own tier logic emits
    // `phone_match_single_location` too, so only "did the other searches run" tells the
    // short-circuit apart from the full path.
    assert.ok(calls.otherSearches > 0,
        'three candidate locations across the two sources must not settle — the address search must run');
    assert.ok(candidates.length > 0, 'the fan-out still produces candidates');
});

test('an index failure defers to the full search instead of settling', async () => {
    // A confident single match must never be manufactured out of a missing corroboration
    // source — losing the index has to make the matcher MORE cautious, not less.
    const { svc, calls } = loadIndexFailingMatcher();

    const candidates = await svc.findCustomerWithConfidence('tok', {
        phone: '+14169012663',
        address: '1 A St'
    });

    assert.ok(calls.otherSearches > 0,
        'no short-circuit while the index is unavailable — the fan-out runs instead');
    assert.ok(candidates.length > 0, 'and it still returns what contact search found');
});

test('a location-only phone reaches Tier 1 through the index, with no contact at all', async () => {
    // The case locationPhoneIndex exists for: the site's only number is its own main
    // line, which /contact?search= structurally cannot see. buildCandidate has to fall
    // back to location.phoneNumber or phoneExact stays false and Tier 1 is unreachable.
    const { svc } = phoneFirstMatcher({
        contacts: [],
        indexHit: {
            locationId: 6404579, locationName: 'Main Line Site', locationStatus: 'active',
            address: { street: '5 Main St', city: 'Toronto', state: 'ON', postalCode: 'M1M1M1' },
            matchedAddress: '5 Main St, Toronto, ON, M1M1M1'
        }
    });

    const candidates = await svc.findCustomerWithConfidence('tok', { phone: '+14379905605' });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].tier, 1);
    assert.strictEqual(candidates[0].locationId, 6404579);
    assert.strictEqual(candidates[0].contactId, null, 'no contact was involved');
});

test('a phone that cannot yield ten digits does not trigger the short-circuit', async () => {
    // The short-circuit is gated on a full ten digits, because ten digits is the
    // comparison key. A partial number goes through the ordinary fan-out instead,
    // where the address still gets a say.
    //
    // Asserted via `otherSearches`, not via tierReason: the fan-out's own tier logic
    // can also label a candidate `phone_match_single_location`, so only "did the other
    // searches run" separates the two paths.
    const { svc, calls } = phoneFirstMatcher({ contacts: [contactOn([6398701], '12345')] });

    await svc.findCustomerWithConfidence('tok', { phone: '12345', address: '1 A St' });

    assert.ok(calls.otherSearches > 0, 'the fan-out must run for a partial number');
});

// ---------------------------------------------------------------- location matching

const matcherWith = (candidates) => loadWithMocks(
    path.join(REPO, 'src/services/contextJobService'),
    {
        '../controllers/serviceTradeController': {
            getAuthToken: async () => 'token',
            createJob: async (payload) => ({ jobId: 99, jobNumber: '49942168', payload })
        },
        './customerMatchingService': { findCustomerWithConfidence: async () => candidates }
    }
);

const candidate = (over = {}) => ({
    tier: 1, locationId: 6398701, locationName: '2213256 Ontario Ltd.', locationStatus: 'active',
    address: { street: '71 Todd Rd.', city: 'Georgetown', state: 'ON', postalCode: 'L7G 4R8' },
    ...over
});

test('an inactive location now MATCHES instead of being excluded', async () => {
    const svc = matcherWith([candidate({ locationStatus: 'inactive' })]);
    const result = await svc.matchLocationFromCallContext({ agent_id: OUTBOUND_AGENT, service_address: '71 Todd Rd.' });

    assert.strictEqual(result.status, 'matched');
    assert.strictEqual(result.locationStatus, 'inactive');
    assert.strictEqual(result.locationId, 6398701);
    assert.strictEqual(result.matchedAddress, '71 Todd Rd., Georgetown, ON, L7G 4R8');
});

test('an active location still wins over an inactive one', async () => {
    const svc = matcherWith([
        candidate({ locationId: 111, locationStatus: 'inactive' }),
        candidate({ locationId: 222, locationStatus: 'active' })
    ]);
    const result = await svc.matchLocationFromCallContext({ agent_id: OUTBOUND_AGENT, service_address: 'x' });

    assert.strictEqual(result.locationId, 222);
    assert.strictEqual(result.locationStatus, 'active');
});

test('a job IS created on an inactive location, and tagged in ServiceTrade', async () => {
    const svc = matcherWith([candidate({ locationStatus: 'inactive' })]);
    const result = await svc.createJobFromCallContext({
        agent_id: OUTBOUND_AGENT, service_address: '71 Todd Rd.',
        customer_name: 'Carlo', call_summary: 'no heat'
    });

    assert.strictEqual(result.status, 'created');
    assert.strictEqual(result.locationStatus, 'inactive');
    assert.strictEqual(result.matchedLocationId, 6398701);
    assert.match(result.job.payload.description, /\[INACTIVE LOCATION\]/);
    assert.strictEqual(result.job.payload.locationId, 6398701, 'locationId is passed exactly as for an active location');
});

test('an active location gets no inactive tag in the job description', async () => {
    const svc = matcherWith([candidate()]);
    const result = await svc.createJobFromCallContext({ agent_id: OUTBOUND_AGENT, service_address: 'x', call_summary: 'no heat' });
    assert.ok(!result.job.payload.description.includes('INACTIVE'));
    assert.strictEqual(result.locationStatus, 'active');
});

test('no candidates still means no_match', async () => {
    const svc = matcherWith([]);
    const result = await svc.matchLocationFromCallContext({ agent_id: OUTBOUND_AGENT, service_address: 'nowhere' });
    assert.strictEqual(result.status, 'no_match');
});

// ---------------------------------------------------------------- client email

const composeWith = (details, outcome = 'job_created') => {
    const sent = [];
    const svc = loadWithMocks(path.join(REPO, 'src/services/emailNotificationService'), {
        '@sendgrid/mail': { setApiKey() {}, send: async (m) => { sent.push(m); return [{ statusCode: 202 }]; } },
        '../config/environment': {
            ...require(path.join(REPO, 'src/config/environment')),
            sendgridApiKey: 'SG.test'
        }
    });
    return svc.sendJobNotification({
        settings: { emailto: 'client@example.com', send_job_email: true, send_job_fail_email: true },
        outcome,
        details
    }).then(() => sent[0]);
};

const baseDetails = {
    customerName: 'Carlo Henry', callerPhone: '+14169012663',
    serviceAddress: '71 Todd Rd., Georgetown, ON', callSummary: 'No heat',
    priority: 'Emergency', timestamp: Date.now(), jobNumber: '49942168'
};

test('a job created on an inactive location is flagged in the subject and the body', async () => {
    const mail = await composeWith({ ...baseDetails, locationStatus: 'inactive', locationName: '2213256 Ontario Ltd.' });

    assert.match(mail.subject, /^\[Inactive Location\] New Service Request Logged/, `subject: ${mail.subject}`);
    assert.match(mail.html, /Inactive ServiceTrade Location/);
    assert.match(mail.text, /marked INACTIVE in ServiceTrade/);
    assert.match(mail.text, /49942168/, 'the job number is still reported');
});

test('a decline on an inactive location is flagged on the failure email too', async () => {
    const mail = await composeWith({
        ...baseDetails, jobNumber: '', locationStatus: 'inactive',
        reasonLabel: 'Technician Declined (Inactive Location)',
        reasonMessage: 'no job — tech declined (INACTIVE ServiceTrade location)'
    }, 'job_not_created');

    assert.match(mail.subject, /^\[Inactive Location\] Service Request Needs Review/, `subject: ${mail.subject}`);
    assert.match(mail.html, /Inactive ServiceTrade Location/);
});

test('an active location produces no inactive flag anywhere', async () => {
    const mail = await composeWith({ ...baseDetails, locationStatus: 'active' });
    assert.ok(!mail.subject.includes('Inactive'), `subject: ${mail.subject}`);
    assert.ok(!mail.html.includes('Inactive ServiceTrade Location'));
});

test('a tenant with no locationStatus at all is untouched', async () => {
    const mail = await composeWith(baseDetails);
    assert.match(mail.subject, /^New Service Request Logged/);
    assert.ok(!mail.html.includes('Inactive ServiceTrade Location'));
});

// ---------------------------------------------------------------- inbound lookup

const inboundApp = async (mocks) => {
    const router = loadWithMocks(path.join(REPO, 'src/routes/serviceTrade/inboundLookup'), mocks);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    return { port: server.address().port, close: () => server.close() };
};

const callInbound = (port, agentId, fromNumber) => fetch(`http://127.0.0.1:${port}/st-inbound-lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'call_inbound', call_inbound: { agent_id: agentId, from_number: fromNumber } })
}).then((r) => r.json());

const INBOUND_AGENT = 'agent_efbe503faedf1bf516f961979f';

test('inbound lookup returns Retell-shaped dynamic variables for an inactive location', async () => {
    const app = await inboundApp({
        '../../controllers/serviceTradeController': { getAuthToken: async () => 'tok' },
        '../../services/locationPhoneIndex': {
            // The real helper, not a hand-rolled copy: an inline stub would keep
            // passing after normalizePhone regressed.
            normalizePhone: require(path.join(REPO, 'src/utils/phone')).normalizePhone,
            lookupByPhone: async () => ({
                locationId: 6398701, locationName: '2213256 Ontario Ltd.',
                locationStatus: 'inactive', matchedAddress: '71 Todd Rd., Georgetown, ON, L7G 4R8'
            })
        },
        '../../services/serviceTradeService': { searchContacts: async () => [] }
    });
    try {
        const body = await callInbound(app.port, INBOUND_AGENT, '+19056710220');
        const v = body.call_inbound.dynamic_variables;
        assert.ok(body.call_inbound, 'response must be wrapped in call_inbound');
        assert.strictEqual(v.st_lookup_ok, 'true');
        assert.strictEqual(v.st_location_found, 'true');
        assert.strictEqual(v.st_location_status, 'inactive');
        assert.strictEqual(v.st_location_serviceable, 'false');
        assert.strictEqual(v.st_location_id, '6398701');
        assert.strictEqual(v.st_location_address, '71 Todd Rd., Georgetown, ON, L7G 4R8');
    } finally { app.close(); }
});

test('inbound lookup fails OPEN when ServiceTrade throws', async () => {
    const app = await inboundApp({
        '../../controllers/serviceTradeController': { getAuthToken: async () => { throw new Error('ST down'); } },
        '../../services/locationPhoneIndex': {
            normalizePhone: require(path.join(REPO, 'src/utils/phone')).normalizePhone,
            lookupByPhone: async () => null
        },
        '../../services/serviceTradeService': { searchContacts: async () => [] }
    });
    try {
        const body = await callInbound(app.port, INBOUND_AGENT, '+19056710220');
        const v = body.call_inbound.dynamic_variables;
        assert.strictEqual(v.st_lookup_ok, 'false');
        assert.strictEqual(v.st_location_found, 'false');
        assert.strictEqual(v.st_lookup_reason, 'lookup_error');
        // Present and empty, never absent. An ABSENT dynamic variable renders in the
        // prompt as a literal {{address_match}}, which the agent would then read as a
        // real address; an empty one renders as nothing.
        assert.strictEqual(v.address_match, '');
    } finally { app.close(); }
});

test('address_match is present and empty on every non-match path', async () => {
    const cases = [
        ['agent_not_enabled', 'agent_not_in_the_allowlist', '+19056710220'],
        ['no_from_number', INBOUND_AGENT, '']
    ];
    for (const [expectedReason, agent, from] of cases) {
        const app = await inboundApp({
            '../../controllers/serviceTradeController': { getAuthToken: async () => 'tok' },
            '../../services/locationPhoneIndex': {
                normalizePhone: require(path.join(REPO, 'src/utils/phone')).normalizePhone,
                lookupByPhone: async () => null
            },
            '../../services/serviceTradeService': { searchContacts: async () => [] }
        });
        try {
            const body = await callInbound(app.port, agent, from);
            const v = body.call_inbound.dynamic_variables;
            assert.strictEqual(v.st_lookup_reason, expectedReason);
            assert.strictEqual(v.address_match, '', `address_match must be '' on ${expectedReason}`);
        } finally { app.close(); }
    }
});

test('a resolved caller gets the four spoken address parts, in order', async () => {
    const app = await inboundApp({
        '../../controllers/serviceTradeController': { getAuthToken: async () => 'tok' },
        '../../services/locationPhoneIndex': {
            normalizePhone: require(path.join(REPO, 'src/utils/phone')).normalizePhone,
            lookupByPhone: async () => ({
                locationId: 6398685,
                locationName: 'Residence(57 Admiral Rd.)',
                locationStatus: 'active',
                address: { street: '57 Admiral Road', city: 'Toronto', state: 'ON', postalCode: 'M5R 2L4' },
                matchedAddress: 'ignored — rebuilt from the parts'
            })
        },
        '../../services/serviceTradeService': { searchContacts: async () => [] }
    });
    try {
        const body = await callInbound(app.port, INBOUND_AGENT, '+14169012663');
        const v = body.call_inbound.dynamic_variables;
        assert.strictEqual(v.address_match, '57 Admiral Road, Toronto, ON, M5R 2L4');
    } finally { app.close(); }
});

test('a blank address part is skipped rather than leaving a stray comma', async () => {
    // Four of the 395 mirrored locations carry no postal code.
    const app = await inboundApp({
        '../../controllers/serviceTradeController': { getAuthToken: async () => 'tok' },
        '../../services/locationPhoneIndex': {
            normalizePhone: require(path.join(REPO, 'src/utils/phone')).normalizePhone,
            lookupByPhone: async () => ({
                locationId: 1,
                locationName: 'No postal on file',
                locationStatus: 'active',
                address: { street: '123 Omni Drive', city: 'Toronto', state: 'ON', postalCode: '' },
                matchedAddress: ''
            })
        },
        '../../services/serviceTradeService': { searchContacts: async () => [] }
    });
    try {
        const body = await callInbound(app.port, INBOUND_AGENT, '+14169012663');
        assert.strictEqual(body.call_inbound.dynamic_variables.address_match, '123 Omni Drive, Toronto, ON');
    } finally { app.close(); }
});

test('inbound lookup rejects an agent that is not on the allowlist', async () => {
    const app = await inboundApp({
        '../../controllers/serviceTradeController': { getAuthToken: async () => 'tok' },
        '../../services/locationPhoneIndex': {
            normalizePhone: require(path.join(REPO, 'src/utils/phone')).normalizePhone,
            lookupByPhone: async () => null
        },
        '../../services/serviceTradeService': { searchContacts: async () => [] }
    });
    try {
        const body = await callInbound(app.port, 'agent_someone_else', '+19056710220');
        assert.strictEqual(body.call_inbound.dynamic_variables.st_lookup_reason, 'agent_not_enabled');
    } finally { app.close(); }
});

test('inbound lookup falls back to contact search, and ignores catch-all contacts', async () => {
    const manyLocations = { phone: '905-671-0220', locations: Array.from({ length: 12 }, (_, i) => ({ id: i })) };
    const single = { phone: '905-671-0220', locations: [{ id: 42, name: 'Single Site', status: 'active', address: { street: '1 A St' } }] };

    for (const [label, contacts, expectFound] of [
        ['catch-all contact', [manyLocations], 'false'],
        ['single-location contact', [single], 'true']
    ]) {
        const app = await inboundApp({
            '../../controllers/serviceTradeController': { getAuthToken: async () => 'tok' },
            '../../services/locationPhoneIndex': {
                // The real helper, not a hand-rolled copy: an inline stub would keep
            // passing after normalizePhone regressed.
            normalizePhone: require(path.join(REPO, 'src/utils/phone')).normalizePhone,
                lookupByPhone: async () => null
            },
            '../../services/serviceTradeService': { searchContacts: async () => contacts }
        });
        try {
            const body = await callInbound(app.port, INBOUND_AGENT, '+19056710220');
            assert.strictEqual(body.call_inbound.dynamic_variables.st_location_found, expectFound, label);
        } finally { app.close(); }
    }
});

// ------------------------------------------------ escalation-complete idempotency

test('a repeated escalation-complete does not send a second client email', async () => {
    const sends = [];
    const router = loadWithMocks(path.join(REPO, 'src/routes/serviceTrade/escalationComplete'), {
        '../../services/supabaseService': { getServiceTradeToken: async () => [{ Name: 'Adaptive' }] },
        '../../services/emailNotificationService': {
            sendJobNotification: async (a) => { sends.push(a); return { sent: true }; },
            sendInternalAlert: async () => {}
        }
    });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    const body = {
        agent_id: OUTBOUND_AGENT, inbound_call_id: 'call_dupe_1', reason: 'created',
        is_job_created: true, job_number: '49942168', location_status: 'inactive'
    };
    const call = () => fetch(`http://127.0.0.1:${port}/st-escalation-complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then((r) => r.json());

    try {
        const first = await call();
        const second = await call();
        assert.strictEqual(first.data.status, 'ok');
        assert.strictEqual(second.data.status, 'duplicate');
        assert.strictEqual(sends.length, 1, `expected 1 send, got ${sends.length}`);
        assert.strictEqual(sends[0].details.locationStatus, 'inactive');
    } finally { server.close(); }
});

test('a FAILED send is not cached, so the Apps Script retry still gets through', async () => {
    let attempt = 0;
    const router = loadWithMocks(path.join(REPO, 'src/routes/serviceTrade/escalationComplete'), {
        '../../services/supabaseService': { getServiceTradeToken: async () => [{ Name: 'Adaptive' }] },
        '../../services/emailNotificationService': {
            sendJobNotification: async () => {
                attempt += 1;
                if (attempt === 1) throw new Error('SendGrid 503');
                return { sent: true };
            },
            sendInternalAlert: async () => {}
        }
    });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    const call = () => fetch(`http://127.0.0.1:${port}/st-escalation-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: OUTBOUND_AGENT, inbound_call_id: 'call_retry_1', reason: 'created' })
    });

    try {
        assert.strictEqual((await call()).status, 500, 'a SendGrid failure must surface so GAS retries');
        assert.strictEqual((await call()).status, 200, 'the retry must be allowed through');
        assert.strictEqual(attempt, 2);
    } finally { server.close(); }
});
