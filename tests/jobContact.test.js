const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadWithMocks, REPO } = require('./harness');

/**
 * The primary contact on a ServiceTrade job.
 *
 * All three behaviours here come from one production failure, 2026-09-24. An emergency at
 * "300 Bloor Street East" matched location 1280601711187393 (DEL(300, Bellagio, TSCC #1483)),
 * the technician approved it, and ServiceTrade threw the job away:
 *
 *   400 {"messages":{"validation":{"primaryContactId":{"invalidModel":"'1431973455298817' is not valid"}}}}
 *
 * Contact 1431973455298817 is real — it just belongs to TSCC #2744, a different building run
 * by the same property manager behind the same phone number. The location comes from the
 * service address and the contact from a phone search, and nothing compared the two.
 *
 * Numbers below are the live values, recorded against api.servicetrade.com the same day.
 */

const AGENT = 'agent_c4123a0589c456c9f19e369340';
const JOB_LOCATION = 1280601711187393;   // DEL(300, Bellagio, TSCC #1483)
const OTHER_LOCATION = 772226987897409;  // DEL(576 - Minto - TSCC #2744)
const WRONG_CONTACT = 1431973455298817;  // Jamie Morillo, at OTHER_LOCATION
const RIGHT_CONTACT = 1686639871757633;  // Robert, at JOB_LOCATION
const LOCATION_CONTACT = 1487285450816833; // Dini Calkin, primary contact of JOB_LOCATION

// ------------------------------------------------------------------ contact search

const withFetch = async (handler, run) => {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    try {
        return await run();
    } finally {
        globalThis.fetch = original;
    }
};

const jsonOk = (body) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body)
});

test('getContacts searches the national 10-digit number, URL-encoded', async () => {
    const svc = require(path.join(REPO, 'src/services/serviceTradeService'));
    const urls = [];

    await withFetch(
        async (url) => { urls.push(url); return jsonOk({ data: { contacts: [] } }); },
        () => svc.getContacts('tok', '+14163233172')
    );

    // The bug: `?search=${phoneNumber}` un-encoded put a raw '+' in the query string, which
    // decodes to a space server-side. Verified live — '+14163233172' and '14163233172' both
    // return 0 contacts, '4163233172' returns the right person.
    assert.ok(urls[0].endsWith('/contact?search=4163233172'), `unexpected URL: ${urls[0]}`);
    assert.ok(!urls[0].includes('+'), 'a raw + reaches the API as a space and matches nobody');
});

test('getContacts leaves a non-phone search term alone', async () => {
    const svc = require(path.join(REPO, 'src/services/serviceTradeService'));
    const urls = [];

    await withFetch(
        async (url) => { urls.push(url); return jsonOk({ data: { contacts: [] } }); },
        () => svc.getContacts('tok', 'Jamie Morillo')
    );

    // normalizePhone would reduce a name to '', so only a real 10-digit result is used.
    assert.ok(urls[0].endsWith('/contact?search=Jamie%20Morillo'), `unexpected URL: ${urls[0]}`);
});

// ------------------------------------------------------------------ createJob retry

const REJECTION = JSON.stringify({
    messages: {
        error: ['Malformed data'],
        validation: { primaryContactId: { invalidModel: `'${WRONG_CONTACT}' is not valid` } }
    }
});

const postResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 400 ? 'Bad Request' : 'OK',
    text: async () => body
});

test('createJob retries without primaryContactId when ServiceTrade rejects the contact', async () => {
    const svc = require(path.join(REPO, 'src/services/serviceTradeService'));
    const payloads = [];

    const job = await withFetch(
        async (url, options) => {
            payloads.push(JSON.parse(options.body));
            return payloads.length === 1
                ? postResponse(400, REJECTION)
                : postResponse(200, JSON.stringify({ data: { job: { id: 777, number: '49942168' } } }));
        },
        () => svc.createJob('tok', JOB_LOCATION, {
            description: 'no domestic hot water',
            primaryContactId: WRONG_CONTACT
        })
    );

    assert.strictEqual(payloads.length, 2, 'the rejection must be retried, not thrown');
    assert.strictEqual(payloads[0].primaryContactId, WRONG_CONTACT);
    assert.ok(!('primaryContactId' in payloads[1]), 'the retry must drop the contact');
    assert.strictEqual(payloads[1].locationId, JOB_LOCATION, 'everything else is unchanged');
    assert.strictEqual(payloads[1].description, 'no domestic hot water');
    assert.strictEqual(job.id, 777, 'the job is created — a contact is enrichment, not the job');
});

test('createJob still throws when the rejection is not about the contact', async () => {
    const svc = require(path.join(REPO, 'src/services/serviceTradeService'));
    let calls = 0;
    const body = JSON.stringify({ messages: { validation: { locationId: { invalidModel: 'nope' } } } });

    await assert.rejects(
        () => withFetch(
            async () => { calls += 1; return postResponse(400, body); },
            () => svc.createJob('tok', JOB_LOCATION, { description: 'x', primaryContactId: RIGHT_CONTACT })
        ),
        /ServiceTrade API error: 400/
    );
    assert.strictEqual(calls, 1, 'a real failure must not be retried into silence');
});

// ------------------------------------------------------------------ contact scoping

const controllerWith = ({ contactLocations, contactId, created = [] }) => loadWithMocks(
    path.join(REPO, 'src/controllers/serviceTradeController'),
    {
        '../services/supabaseService': {
            getServiceTradeToken: async () => ([{ agent_id: AGENT, auth_token: 'tok', Name: 'Adaptive' }]),
            credentialsFingerprint: () => null,
            recordSessionValid: async () => {},
            markAuthFailure: async () => {},
            getJobConfig: async () => ({ create_appointment: false })
        },
        '../services/emailNotificationService': { sendInternalAlert: async () => {} },
        '../services/serviceTradeService': {
            checkSession: async () => ({ valid: true, expired: false, status: 200, reason: null }),
            getContacts: async () => ({
                id: contactId,
                firstName: 'Caller',
                lastName: '',
                phone: '(416) 323-3172',
                email: '',
                locations: contactLocations.map((id) => ({
                    id,
                    name: 'loc ' + id,
                    address: { street: 's', city: 'c', state: 'ON', postalCode: 'p' }
                })),
                company: { id: 999 }
            }),
            getLocationById: async () => ({ id: JOB_LOCATION, primaryContact: { id: LOCATION_CONTACT } }),
            createJob: async (token, locationId, jobData) => {
                created.push(jobData);
                return { id: 777, number: '49942168' };
            },
            updateJob: async () => ({}),
            createAppointment: async () => null,
            createServiceRequest: async () => null
        }
    }
);

test('a caller contact at another building is dropped for the location primary contact', async () => {
    const created = [];
    const controller = controllerWith({
        contactId: WRONG_CONTACT,
        contactLocations: [OTHER_LOCATION],
        created
    });

    await controller.createJob(
        { locationId: JOB_LOCATION, description: 'no hot water', callerPhoneNumber: '+14163233172' },
        AGENT
    );

    assert.strictEqual(created.length, 1);
    assert.notStrictEqual(
        created[0].primaryContactId,
        WRONG_CONTACT,
        'sending a contact from another company is what ServiceTrade rejected outright'
    );
    assert.strictEqual(
        created[0].primaryContactId,
        LOCATION_CONTACT,
        'the location\'s own primary contact is valid by construction'
    );
});

test('a caller contact that does cover the location is kept', async () => {
    const created = [];
    const controller = controllerWith({
        contactId: RIGHT_CONTACT,
        contactLocations: [JOB_LOCATION],
        created
    });

    await controller.createJob(
        { locationId: JOB_LOCATION, description: 'no hot water', callerPhoneNumber: '+14163233172' },
        AGENT
    );

    // The person who actually rang is a better primary contact than the building's default,
    // so the phone lookup still wins whenever it answers with someone at this location.
    assert.strictEqual(created[0].primaryContactId, RIGHT_CONTACT);
});

test('a contact covering several buildings counts if one of them is this job', async () => {
    const created = [];
    const controller = controllerWith({
        contactId: RIGHT_CONTACT,
        contactLocations: [OTHER_LOCATION, JOB_LOCATION],
        created
    });

    await controller.createJob(
        { locationId: JOB_LOCATION, description: 'no hot water', callerPhoneNumber: '+14163233172' },
        AGENT
    );

    assert.strictEqual(created[0].primaryContactId, RIGHT_CONTACT);
});

test('an explicitly supplied primaryContactId is passed through untouched', async () => {
    const created = [];
    const controller = controllerWith({
        contactId: WRONG_CONTACT,
        contactLocations: [OTHER_LOCATION],
        created
    });

    // The scoping check guards the phone LOOKUP. A caller that names a contact has already
    // decided, and the retry in serviceTradeService is what covers it being wrong.
    await controller.createJob(
        {
            locationId: JOB_LOCATION,
            description: 'no hot water',
            callerPhoneNumber: '+14163233172',
            primaryContactId: 12345
        },
        AGENT
    );

    assert.strictEqual(created[0].primaryContactId, 12345);
});
