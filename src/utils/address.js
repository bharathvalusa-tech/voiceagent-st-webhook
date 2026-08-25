/**
 * Address string matching — normalisation, fuzzy similarity, and the query shapes used
 * to compare a spoken address against a stored one.
 *
 * Pure string work, no I/O and no dependencies. It lives here rather than in
 * customerMatchingService so a route can compare addresses without pulling in the
 * ServiceTrade client, the phone index and the Supabase client behind it.
 */

const normalizeText = (text) =>
    (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const tokenSimilarity = (a, b) => {
    const aTokens = new Set(normalizeText(a).split(' ').filter(Boolean));
    const bTokens = new Set(normalizeText(b).split(' ').filter(Boolean));
    if (aTokens.size === 0 || bTokens.size === 0) return 0;
    const intersection = new Set([...aTokens].filter((token) => bTokens.has(token)));
    const union = new Set([...aTokens, ...bTokens]);
    return intersection.size / union.size;
};

const bigramSimilarity = (a, b) => {
    const aNorm = normalizeText(a);
    const bNorm = normalizeText(b);
    if (aNorm.length < 2 || bNorm.length < 2) return 0;
    const aBigrams = new Map();
    for (let i = 0; i < aNorm.length - 1; i += 1) {
        const bigram = aNorm.slice(i, i + 2);
        aBigrams.set(bigram, (aBigrams.get(bigram) || 0) + 1);
    }
    let intersection = 0;
    for (let i = 0; i < bNorm.length - 1; i += 1) {
        const bigram = bNorm.slice(i, i + 2);
        const count = aBigrams.get(bigram) || 0;
        if (count > 0) {
            intersection += 1;
            aBigrams.set(bigram, count - 1);
        }
    }
    const total = (aNorm.length - 1) + (bNorm.length - 1);
    return total === 0 ? 0 : (2 * intersection) / total;
};

const fuzzySimilarity = (a, b) => Math.max(tokenSimilarity(a, b), bigramSimilarity(a, b));

const STREET_SUFFIX_TOKENS = new Set([
    'street', 'st', 'avenue', 'ave', 'road', 'rd', 'drive', 'dr', 'boulevard', 'blvd',
    'lane', 'ln', 'court', 'ct', 'circle', 'cir', 'parkway', 'pkwy', 'terrace', 'ter',
    'place', 'pl', 'way', 'highway', 'hwy'
]);

const UNIT_TOKENS = new Set([
    'unit', 'suite', 'ste', 'apt', 'apartment', 'floor', 'fl', 'building', 'bldg'
]);

const DIRECTIONAL_TOKENS = new Set([
    'n', 's', 'e', 'w', 'north', 'south', 'east', 'west'
]);

const dedupeStrings = (values) => [...new Set(values.filter(Boolean))];

const buildAddressSearchQueries = (address) => {
    if (!address) return [];

    const rawAddress = String(address).trim();
    if (!rawAddress) return [];

    const [streetSegment] = rawAddress.split(',').map((segment) => segment.trim()).filter(Boolean);
    const normalizedStreetTokens = normalizeText(streetSegment || rawAddress).split(' ').filter(Boolean);

    const houseNumberIndex = normalizedStreetTokens.findIndex((token) => /^\d+[a-z]?$/i.test(token));
    if (houseNumberIndex === -1) {
        return dedupeStrings([streetSegment, rawAddress]);
    }

    const houseNumber = normalizedStreetTokens[houseNumberIndex];
    const streetTokens = normalizedStreetTokens
        .slice(houseNumberIndex + 1)
        .filter((token) => !UNIT_TOKENS.has(token) && !/^\d+[a-z]?$/i.test(token));

    const suffixIndex = streetTokens.findIndex((token) => STREET_SUFFIX_TOKENS.has(token));
    const coreStreetTokens = (suffixIndex === -1 ? streetTokens : streetTokens.slice(0, suffixIndex)).slice(0, 3);
    const streetTokensWithoutDirectional = coreStreetTokens.filter(
        (token, index) => !(index === 0 && DIRECTIONAL_TOKENS.has(token))
    );

    const shortQueries = [];
    if (coreStreetTokens.length > 0) {
        shortQueries.push(`${houseNumber} ${coreStreetTokens.join(' ')}`);
    }
    if (streetTokensWithoutDirectional.length > 0) {
        shortQueries.push(`${houseNumber} ${streetTokensWithoutDirectional.join(' ')}`);
    }

    return dedupeStrings([
        ...shortQueries,
        streetSegment,
        rawAddress
    ]);
};

const hasAddressQueryMatch = (leftAddress, rightAddress) => {
    const leftQueries = new Set(buildAddressSearchQueries(leftAddress).map((query) => normalizeText(query)));
    const rightQueries = new Set(buildAddressSearchQueries(rightAddress).map((query) => normalizeText(query)));

    if (leftQueries.size === 0 || rightQueries.size === 0) {
        return false;
    }

    return [...leftQueries].some((query) => rightQueries.has(query));
};

const addressSimilarity = (a, b) => {
    const aNorm = normalizeText(a);
    const bNorm = normalizeText(b);
    if (!aNorm || !bNorm) return 0;
    if (aNorm === bNorm) return 1;
    if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return 0.9;
    return fuzzySimilarity(aNorm, bNorm);
};

module.exports = {
    normalizeText,
    tokenSimilarity,
    bigramSimilarity,
    fuzzySimilarity,
    dedupeStrings,
    buildAddressSearchQueries,
    hasAddressQueryMatch,
    addressSimilarity,
    STREET_SUFFIX_TOKENS,
    UNIT_TOKENS,
    DIRECTIONAL_TOKENS
};
