const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadWithMocks, REPO } = require('./harness');

// GET /geocode/json, answered from a script. Records every URL asked for.
function load(results) {
    const urls = [];
    global.fetch = async (url) => {
        urls.push(url);
        return { json: async () => ({ status: results.length ? 'OK' : 'ZERO_RESULTS', results }) };
    };
    const svc = loadWithMocks(path.join(REPO, 'src/services/googleMapsService'), {
        '../config/environment': { googleMapsKey: 'test-key' }
    });
    return { svc, urls };
}

const component = (types, long, short = long) => ({ types, long_name: long, short_name: short });
const gilpin = {
    formatted_address: '3600 S Gilpin St, Englewood, CO 80113, USA',
    address_components: [
        component(['street_number'], '3600'), component(['route'], 'South Gilpin Street', 'S Gilpin St'),
        component(['locality'], 'Englewood'), component(['administrative_area_level_1'], 'Colorado', 'CO'),
        component(['postal_code'], '80113'), component(['country'], 'United States', 'US')
    ],
    geometry: { location: { lat: 39.6, lng: -104.9 } }, place_id: 'x'
};
const englewoodNJ = {
    formatted_address: 'Englewood, NJ 07631, USA',
    address_components: [
        component(['locality'], 'Englewood'), component(['administrative_area_level_1'], 'New Jersey', 'NJ'),
        component(['postal_code'], '07631'), component(['country'], 'United States', 'US')
    ],
    geometry: { location: {} }, place_id: 'y'
};

test('the tenant state is sent as a filter when the caller did not say one', async () => {
    const { svc, urls } = load([gilpin]);
    const r = await svc.validateAddress({ line1: '3600 South Gilvin Street, Englewood' }, { state: 'CO' });
    assert.match(urls[0], /components=country%3AUS%7Cadministrative_area%3ACO/);
    assert.strictEqual(r.state, 'CO');
});

test('a state the caller said is not overridden', async () => {
    const { svc, urls } = load([gilpin]);
    await svc.validateAddress({ line1: '3600 S Gilpin St', city: 'Englewood', state: 'NJ' }, { state: 'CO' });
    assert.doesNotMatch(urls[0], /components=/);
});

test('call_2a4ba2fff: a result that dropped the house number is refused', async () => {
    // Englewood, NJ, 07631, with no street — the job search then ran on "Englewood".
    const { svc } = load([englewoodNJ]);
    assert.strictEqual(await svc.validateAddress({ line1: '3600 South Gilvin Street, Englewood' }), null);
});

test('a unit number is not taken for the house number', async () => {
    assert.strictEqual(require(path.join(REPO, 'src/services/googleMapsService')).houseNumberOf('Unit 414, 1801 California Street'), '1801');
});
