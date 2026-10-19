const config = require('../config/environment');

const GOOGLE_MAPS_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

const getComponent = (components, type, short = false) => {
    const found = components.find((component) => component.types.includes(type));
    if (!found) return '';
    return short ? found.short_name : found.long_name;
};

const buildAddressQuery = (input) => {
    if (!input) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'object') {
        const parts = [
            input.line1 || input.street || input.address1,
            input.city,
            input.state,
            input.postalCode || input.zip
        ].filter(Boolean);
        return parts.join(', ');
    }
    return '';
};

// The first number in what was said, ignoring unit words ("unit 4", "suite 200"). Used to
// refuse a geocode that kept the city and dropped the building.
const houseNumberOf = (text) => {
    const words = String(text || '').toLowerCase().replace(/[^a-z0-9#\s]/g, ' ').split(/\s+/);
    for (let i = 0; i < words.length; i++) {
        if (['unit', 'suite', 'ste', 'apt', '#'].includes(words[i])) { i++; continue; }
        if (/^\d+[a-z]?$/.test(words[i])) return words[i].replace(/[a-z]$/, '');
    }
    return '';
};

/**
 * Geocode a spoken address.
 *
 * `options.state` keeps the search inside the tenant's service area when the caller did not
 * say a state. Without it, "3600 South Gilvin Street, Englewood" — a Denver suburb — came
 * back as "Englewood, NJ, 07631" with no street (call_2a4ba2fff…), and the job search then
 * ran on the word "Englewood".
 *
 * Returns null when the result lost or changed the house number the caller said: a city
 * centroid is not the caller's building, and the raw words are the better search.
 */
const validateAddress = async (rawAddress, options = {}) => {
    const addressQuery = buildAddressQuery(rawAddress);
    if (!addressQuery) {
        return null;
    }

    if (!config.googleMapsKey) {
        throw new Error('Missing GOOGLE_MAPS_KEY for address validation');
    }

    const saidState = typeof rawAddress === 'object' && rawAddress && rawAddress.state;
    const bias = options.state && !saidState
        ? `&components=${encodeURIComponent(`country:US|administrative_area:${options.state}`)}`
        : '';
    const url = `${GOOGLE_MAPS_ENDPOINT}?address=${encodeURIComponent(addressQuery)}${bias}&key=${config.googleMapsKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
        return null;
    }

    const result = data.results[0];
    const components = result.address_components || [];

    const streetNumber = getComponent(components, 'street_number');
    const streetName = getComponent(components, 'route');
    const city = getComponent(components, 'locality') || getComponent(components, 'sublocality');
    const state = getComponent(components, 'administrative_area_level_1', true);
    const postalCode = getComponent(components, 'postal_code');
    const country = getComponent(components, 'country', true);

    const saidNumber = houseNumberOf(typeof rawAddress === 'object' && rawAddress
        ? (rawAddress.line1 || rawAddress.street || rawAddress.address1)
        : rawAddress);
    if (saidNumber && streetNumber !== saidNumber) {
        return null;
    }

    return {
        formatted_address: result.formatted_address,
        street_number: streetNumber,
        street_name: streetName,
        street: `${streetNumber} ${streetName}`.trim(),
        city,
        state,
        postalCode,
        country,
        lat: result.geometry?.location?.lat,
        lng: result.geometry?.location?.lng,
        place_id: result.place_id
    };
};

module.exports = { validateAddress, buildAddressQuery, houseNumberOf };
