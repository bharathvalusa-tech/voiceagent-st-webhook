const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadWithMocks, REPO } = require('./harness');

/**
 * The location the CALLER confirmed out loud, carried from the inbound call to the job.
 *
 * /st-inbound-lookup reads the address back and the caller says yes. Re-deriving a
 * location from the transcribed address afterwards can only agree with that or contradict
 * it, and a contradiction sends the van somewhere the caller never named.
 *
 * What is asserted here is the pair of rules that makes it safe to trust: a confirmed id
 * SKIPS the matcher entirely, and a confirmed id can never LOSE a dispatch the matcher
 * would have won.
 */

const loadContextJobService = ({ location = null, throws = false, candidates = [] } = {}) => {
    const calls = { getLocationById: [], findCustomer: 0, createJob: [] };
    const service = loadWithMocks(path.join(REPO, 'src/services/contextJobService'), {
        '../controllers/serviceTradeController': {
            getAuthToken: async () => 'PHPSESSID-TEST',
            createJob: async (payload) => { calls.createJob.push(payload); return { id: 1, number: 'J-1' }; }
        },
        './customerMatchingService': {
            findCustomerWithConfidence: async () => { calls.findCustomer += 1; return candidates; }
        },
        './serviceTradeService': {
            getLocationById: async (token, id) => {
                calls.getLocationById.push(id);
                if (throws) throw new Error('ServiceTrade 500');
                return location;
            }
        }
    });
    return { service, calls };
};

const LIVE_LOCATION = {
    id: 6398701,
    name: '2213256 Ontario Ltd.',
    status: 'active',
    address: { street: '9 Elmcrest Rd.', city: 'Georgetown', state: 'ON', postalCode: 'L7G 4R8' }
};

test('a confirmed location id settles the verdict without running the matcher', async () => {
    const { service, calls } = loadContextJobService({ location: LIVE_LOCATION });

    const outcome = await service.matchLocationFromCallContext({
        agent_id: 'agent_c4123a0589c456c9f19e369340',
        service_address: 'somewhere the transcript garbled',
        location_id: '6398701'
    });

    assert.equal(outcome.status, 'matched');
    assert.equal(outcome.locationId, 6398701);
    assert.equal(outcome.tier, 1);
    assert.equal(outcome.locationStatus, 'active');
    assert.equal(outcome.matchedAddress, '9 Elmcrest Rd., Georgetown, ON, L7G 4R8');
    assert.deepEqual(calls.getLocationById, ['6398701']);
    assert.equal(calls.findCustomer, 0, 'the garbled address must not get a second opinion');
});

test('an inactive confirmed location still resolves, flagged', async () => {
    // Deactivation is ServiceTrade bookkeeping, not a judgement about the emergency.
    // The technician is dialled and told; their answer decides the job.
    const { service } = loadContextJobService({
        location: { ...LIVE_LOCATION, status: 'inactive' }
    });

    const outcome = await service.matchLocationFromCallContext({
        agent_id: 'agent_c4123a0589c456c9f19e369340',
        location_id: '6398701'
    });

    assert.equal(outcome.status, 'matched');
    assert.equal(outcome.locationStatus, 'inactive');
});

test('a confirmed id that cannot be read falls back to the matcher, it does not fail', async () => {
    // A ServiceTrade blip on this one read must not cost a dispatch that address matching
    // would have won on its own.
    const { service, calls } = loadContextJobService({
        throws: true,
        candidates: [{ tier: 1, locationId: 55, locationName: 'Matched The Hard Way', locationStatus: 'active', address: {} }]
    });

    const outcome = await service.matchLocationFromCallContext({
        agent_id: 'agent_c4123a0589c456c9f19e369340',
        service_address: '31 Larkspur Road, Toronto',
        location_id: '6398701'
    });

    assert.equal(outcome.status, 'matched');
    assert.equal(outcome.locationId, 55);
    assert.equal(calls.findCustomer, 1, 'the matcher ran after the confirmed read failed');
});

test('an id ServiceTrade does not know falls back too', async () => {
    const { service, calls } = loadContextJobService({ location: null, candidates: [] });

    const outcome = await service.matchLocationFromCallContext({
        agent_id: 'agent_c4123a0589c456c9f19e369340',
        service_address: 'nowhere',
        location_id: '999'
    });

    assert.equal(outcome.status, 'no_match');
    assert.equal(calls.findCustomer, 1);
});

test('no confirmed id means the matcher runs exactly as it did before', async () => {
    const { service, calls } = loadContextJobService({
        candidates: [{ tier: 1, locationId: 55, locationName: 'Matched The Hard Way', locationStatus: 'active', address: {} }]
    });

    const outcome = await service.matchLocationFromCallContext({
        agent_id: 'agent_c4123a0589c456c9f19e369340',
        service_address: '31 Larkspur Road, Toronto'
    });

    assert.equal(outcome.locationId, 55);
    assert.deepEqual(calls.getLocationById, [], 'nothing to look up');
    assert.equal(calls.findCustomer, 1);
});

test('the job is created against the confirmed location', async () => {
    const { service, calls } = loadContextJobService({ location: LIVE_LOCATION });

    const result = await service.createJobFromCallContext({
        agent_id: 'agent_c4123a0589c456c9f19e369340',
        customer_name: 'Dana Reyes',
        from_number: '+19056710220',
        call_summary: 'no heat',
        location_id: '6398701'
    });

    assert.equal(result.status, 'created');
    assert.equal(result.matchedLocationId, 6398701);
    assert.equal(calls.createJob.length, 1);
    assert.equal(calls.createJob[0].locationId, 6398701);
    assert.equal(calls.findCustomer, 0);
});

// ---- the route that GAS calls -------------------------------------------------

const loadMatchRoute = (outcome) => {
    let handler = null;
    const expressStub = () => {
        const stub = () => {};
        stub.Router = () => ({ post: (_p, fn) => { handler = fn; } });
        return stub;
    };
    const seen = [];
    loadWithMocks(path.join(REPO, 'src/routes/serviceTrade/matchLocation'), {
        express: expressStub(),
        '../../services/contextJobService': {
            matchLocationFromCallContext: async (fields) => { seen.push(fields); return outcome; }
        },
        '../../services/escalationStore': { openEscalationChain: async () => {} }
    });
    assert.ok(handler, 'route handler was not captured');
    return { handler, seen };
};

const invokeMatch = async (handler, body) => {
    let captured = null;
    const res = {
        status(code) { this._code = code; return this; },
        json(payload) { captured = { code: this._code, ...payload }; return this; }
    };
    await handler({ body }, res);
    return captured;
};

test('/st-match-location accepts a confirmed location id with nothing else', async () => {
    // GAS has the id from the sheet. Rejecting it for arriving without the weaker inputs
    // the matcher would have needed would throw away the strongest one there is.
    const { handler, seen } = loadMatchRoute({
        status: 'matched', locationId: 6398701, locationName: 'Site', tier: 1,
        locationStatus: 'active', matchedAddress: '9 Elmcrest Rd.'
    });

    const result = await invokeMatch(handler, {
        agent_id: 'agent_c4123a0589c456c9f19e369340',
        location_id: '6398701'
    });

    assert.equal(result.code, 200);
    assert.equal(result.data.status, 'matched');
    assert.equal(result.data.locationId, 6398701);
    assert.equal(seen[0].location_id, '6398701');
});

test('/st-match-location still refuses a payload with no way to match at all', async () => {
    const { handler } = loadMatchRoute({ status: 'no_match' });
    const result = await invokeMatch(handler, { agent_id: 'agent_c4123a0589c456c9f19e369340' });
    assert.equal(result.code, 400);
});

test('/st-match-location reads the id under every name GAS might send it', async () => {
    for (const key of ['location_id', 'st_location_id', 'confirmed_location_id']) {
        const { handler, seen } = loadMatchRoute({
            status: 'matched', locationId: 1, locationName: '', tier: 1,
            locationStatus: 'active', matchedAddress: ''
        });
        await invokeMatch(handler, { agent_id: 'agent_x', [key]: '6398701' });
        assert.equal(seen[0].location_id, '6398701', key);
    }
});
