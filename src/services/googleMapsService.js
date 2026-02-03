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

const validateAddress = async (rawAddress) => {
    const addressQuery = buildAddressQuery(rawAddress);
    if (!addressQuery) {
        return null;
    }

    if (!config.googleMapsKey) {
        throw new Error('Missing GOOGLE_MAPS_KEY for address validation');
    }

    const url = `${GOOGLE_MAPS_ENDPOINT}?address=${encodeURIComponent(addressQuery)}&key=${config.googleMapsKey}`;
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

module.exports = { validateAddress, buildAddressQuery };
