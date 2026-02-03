const config = require('../config/environment');
const serviceTradeService = require('./serviceTradeService');

const normalizePhone = (phone) => (phone || '').replace(/[^\d]/g, '');
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

const addressSimilarity = (a, b) => {
    const aNorm = normalizeText(a);
    const bNorm = normalizeText(b);
    if (!aNorm || !bNorm) return 0;
    if (aNorm === bNorm) return 1;
    if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return 0.9;
    return fuzzySimilarity(aNorm, bNorm);
};

const buildCandidate = ({ contact, location, source }) => {
    return {
        source,
        contactId: contact?.id || null,
        contactName: contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() : '',
        contactPhone: contact?.phone || contact?.mobile || contact?.alternatePhone || '',
        contactEmail: contact?.email || '',
        locationId: location?.id || null,
        locationName: location?.name || '',
        address: location?.address || null
    };
};

const scoreCandidate = (candidate, searchData) => {
    let score = 0;

    const normalizedSearchPhone = normalizePhone(searchData.phone);
    const normalizedCandidatePhone = normalizePhone(candidate.contactPhone);
    const phoneExact = Boolean(
        normalizedSearchPhone &&
            normalizedCandidatePhone &&
            normalizedSearchPhone === normalizedCandidatePhone
    );
    const phonePartial = Boolean(
        normalizedSearchPhone.slice(-7) &&
            normalizedCandidatePhone.slice(-7) &&
            normalizedSearchPhone.slice(-7) === normalizedCandidatePhone.slice(-7)
    );

    if (phoneExact) {
        score += 40;
    } else if (phonePartial) {
        score += 20;
    }

    let nameSimilarity = 0;
    if (searchData.name && candidate.contactName) {
        nameSimilarity = fuzzySimilarity(searchData.name, candidate.contactName);
        if (normalizeText(searchData.name) === normalizeText(candidate.contactName)) {
            score += 30;
        } else if (nameSimilarity > config.matchingThresholds.fuzzySimilarity) {
            score += 15;
        }
    }

    let addressSimilarityScore = 0;
    if (searchData.address && candidate.address) {
        const candidateAddress = `${candidate.address.street || ''} ${candidate.address.city || ''} ${candidate.address.state || ''} ${candidate.address.postalCode || ''}`.trim();
        addressSimilarityScore = addressSimilarity(searchData.address, candidateAddress);
        if (addressSimilarityScore === 1) {
            score += 30;
        } else if (addressSimilarityScore > config.matchingThresholds.fuzzySimilarity) {
            score += 15;
        }
    }

    let locationSimilarity = 0;
    if (searchData.locationName && candidate.locationName) {
        locationSimilarity = fuzzySimilarity(searchData.locationName, candidate.locationName);
        if (normalizeText(searchData.locationName) === normalizeText(candidate.locationName)) {
            score += 20;
        } else if (locationSimilarity > config.matchingThresholds.fuzzySimilarity) {
            score += 10;
        }
    }

    if (score > 100) {
        score = 100;
    }

    return {
        confidence: score,
        phoneExact,
        phonePartial,
        addressSimilarity: addressSimilarityScore,
        locationSimilarity,
        nameSimilarity
    };
};

const searchByPhone = async (authToken, phone) => {
    const contacts = await serviceTradeService.searchContacts(authToken, phone);
    const normalizedSearch = normalizePhone(phone);
    const candidates = [];

    contacts.forEach((contact) => {
        const phones = [contact.phone, contact.mobile, contact.alternatePhone].filter(Boolean);
        const hasMatch = phones.some((p) => normalizePhone(p) === normalizedSearch);
        if (!hasMatch) return;

        if (Array.isArray(contact.locations) && contact.locations.length > 0) {
            contact.locations.forEach((location) => {
                candidates.push(buildCandidate({ contact, location, source: 'phone' }));
            });
        }
    });

    if (candidates.length > 0) {
        return candidates;
    }

    const locations = await serviceTradeService.getLocations(authToken);
    const locationMatches = locations.filter((location) => {
        const primaryPhone = normalizePhone(location?.primaryContact?.phone || '');
        const locationPhone = normalizePhone(location?.phoneNumber || '');
        return primaryPhone === normalizedSearch || locationPhone === normalizedSearch;
    });

    locationMatches.forEach((location) => {
        candidates.push(
            buildCandidate({
                contact: location.primaryContact || null,
                location,
                source: 'phone'
            })
        );
    });

    return candidates;
};

const searchByName = async (authToken, name) => {
    const contacts = await serviceTradeService.searchContacts(authToken, name);
    const candidates = [];

    contacts.forEach((contact) => {
        if (Array.isArray(contact.locations) && contact.locations.length > 0) {
            contact.locations.forEach((location) => {
                candidates.push(buildCandidate({ contact, location, source: 'name' }));
            });
        }
    });

    return candidates;
};

const searchByLocationName = async (authToken, locationName) => {
    const locations = await serviceTradeService.searchLocationsByName(authToken, locationName);
    return locations.map((location) => buildCandidate({ contact: location.primaryContact || null, location, source: 'location_name' }));
};

const searchByAddress = async (authToken, address) => {
    const locations = await serviceTradeService.searchLocationsByAddress(authToken, address);
    return locations.map((location) => buildCandidate({ contact: location.primaryContact || null, location, source: 'address' }));
};

const findCustomerWithConfidence = async (authToken, searchData) => {
    const tasks = [];
    const taskLabels = [];

    if (searchData.phone) {
        tasks.push(searchByPhone(authToken, searchData.phone));
        taskLabels.push('phone');
    }
    if (searchData.name) {
        tasks.push(searchByName(authToken, searchData.name));
        taskLabels.push('name');
    }
    if (searchData.locationName) {
        tasks.push(searchByLocationName(authToken, searchData.locationName));
        taskLabels.push('location_name');
    }
    if (searchData.address) {
        tasks.push(searchByAddress(authToken, searchData.address));
        taskLabels.push('address');
    }

    const results = await Promise.all(tasks);
    const candidates = results.flat();
    const deduped = new Map();

    candidates.forEach((candidate) => {
        const key = `${candidate.locationId || 'none'}-${candidate.contactId || 'none'}`;
        if (!deduped.has(key)) {
            deduped.set(key, candidate);
        }
    });

    const scoredCandidates = Array.from(deduped.values()).map((candidate) => ({
        ...candidate,
        ...scoreCandidate(candidate, searchData)
    }));

    scoredCandidates.sort((a, b) => {
        const addressSort = (b.addressSimilarity || 0) - (a.addressSimilarity || 0);
        if (addressSort !== 0) return addressSort;

        const locationSort = (b.locationSimilarity || 0) - (a.locationSimilarity || 0);
        if (locationSort !== 0) return locationSort;

        const phoneSort = (b.phoneExact ? 1 : 0) - (a.phoneExact ? 1 : 0);
        if (phoneSort !== 0) return phoneSort;

        return b.confidence - a.confidence;
    });
    return scoredCandidates;
};

module.exports = {
    findCustomerWithConfidence
};
