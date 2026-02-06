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

const logMatchEvent = (message, context = {}) => {
    console.log(JSON.stringify({ level: 'info', message, ...context }));
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
        companyId: location?.company?.id || null,
        companyName: location?.company?.name || '',
        address: location?.address || null
    };
};

const determineMatchQuality = (candidate, searchData, allCandidates) => {
    // Phone exact match
    const normalizedSearchPhone = normalizePhone(searchData.phone);
    const normalizedCandidatePhone = normalizePhone(candidate.contactPhone);
    const phoneExact = Boolean(
        normalizedSearchPhone &&
            normalizedCandidatePhone &&
            normalizedSearchPhone === normalizedCandidatePhone
    );

    // Location name exact match (case-insensitive, normalized)
    const locationNameExact = Boolean(
        searchData.locationName &&
        candidate.locationName &&
        normalizeText(searchData.locationName) === normalizeText(candidate.locationName)
    );

    // Location name fuzzy match
    const locationNameFuzzy = searchData.locationName && candidate.locationName
        ? fuzzySimilarity(searchData.locationName, candidate.locationName)
        : 0;

    // Company name exact match
    const companyNameExact = Boolean(
        searchData.companyName &&
        candidate.companyName &&
        normalizeText(searchData.companyName) === normalizeText(candidate.companyName)
    );

    // Company name fuzzy match
    const companyNameFuzzy = searchData.companyName && candidate.companyName
        ? fuzzySimilarity(searchData.companyName, candidate.companyName)
        : 0;

    // Cross-matching: Check if locationName matches companyName (customer might say company as location)
    const locationNameMatchesCompany = Boolean(
        searchData.locationName &&
        candidate.companyName &&
        normalizeText(searchData.locationName) === normalizeText(candidate.companyName)
    );

    const locationNameMatchesCompanyFuzzy = searchData.locationName && candidate.companyName
        ? fuzzySimilarity(searchData.locationName, candidate.companyName)
        : 0;

    // Cross-matching: Check if companyName matches locationName (customer might say location as company)
    const companyNameMatchesLocation = Boolean(
        searchData.companyName &&
        candidate.locationName &&
        normalizeText(searchData.companyName) === normalizeText(candidate.locationName)
    );

    const companyNameMatchesLocationFuzzy = searchData.companyName && candidate.locationName
        ? fuzzySimilarity(searchData.companyName, candidate.locationName)
        : 0;

    // Address match (use lower threshold for more flexibility)
    let addressSimilarityScore = 0;
    let addressMatch = false;
    if (searchData.address && candidate.address) {
        const candidateAddress = `${candidate.address.street || ''} ${candidate.address.city || ''} ${candidate.address.state || ''} ${candidate.address.postalCode || ''}`.trim();
        addressSimilarityScore = addressSimilarity(searchData.address, candidateAddress);
        addressMatch = addressSimilarityScore > 0.6; // Lower threshold from 0.8
    }

    // Contact name match
    const nameSimilarity = searchData.name && candidate.contactName
        ? fuzzySimilarity(searchData.name, candidate.contactName)
        : 0;
    const nameMatch = nameSimilarity > 0.6;

    // Count how many locations this contact/company has
    const companyId = candidate.companyName ? 
        allCandidates.find(c => c.companyName === candidate.companyName)?.locationId : null;
    const locationsForCompany = companyId ? 
        allCandidates.filter(c => c.companyName === candidate.companyName).length : 0;

    // Classify into tiers
    let tier = 3; // Default: low confidence
    let tierReason = 'no_strong_match';

    // Tier 1: High confidence - auto-create job
    if (phoneExact && addressMatch) {
        tier = 1;
        tierReason = 'phone_and_address_match';
    } else if (locationNameExact && addressMatch) {
        tier = 1;
        tierReason = 'location_name_and_address_match';
    } else if (locationNameMatchesCompany && addressMatch) {
        tier = 1;
        tierReason = 'location_as_company_and_address_match';
    } else if (phoneExact && locationsForCompany === 1) {
        tier = 1;
        tierReason = 'phone_match_single_location';
    } else if (phoneExact) {
        tier = 1;
        tierReason = 'phone_match';
    } else if (locationNameExact && companyNameExact) {
        tier = 1;
        tierReason = 'location_and_company_exact';
    } else if (locationNameMatchesCompany && locationsForCompany === 1) {
        tier = 1;
        tierReason = 'location_as_company_single_location';
    }
    // Tier 2: Medium confidence - create with note
    else if (locationNameExact) {
        tier = 2;
        tierReason = 'location_name_exact';
    } else if (locationNameMatchesCompany) {
        tier = 2;
        tierReason = 'location_name_matches_company';
    } else if (companyNameMatchesLocation) {
        tier = 2;
        tierReason = 'company_name_matches_location';
    } else if (companyNameExact && locationsForCompany === 1) {
        tier = 2;
        tierReason = 'company_match_single_location';
    } else if (companyNameExact && addressMatch) {
        tier = 2;
        tierReason = 'company_and_address_match';
    } else if (locationNameMatchesCompany && addressMatch) {
        tier = 2;
        tierReason = 'location_as_company_and_address';
    } else if (locationNameFuzzy > 0.8 && addressMatch) {
        tier = 2;
        tierReason = 'location_fuzzy_and_address';
    } else if (companyNameFuzzy > 0.8 && locationNameFuzzy > 0.8) {
        tier = 2;
        tierReason = 'company_and_location_fuzzy';
    } else if (locationNameMatchesCompanyFuzzy > 0.8 && addressMatch) {
        tier = 2;
        tierReason = 'location_as_company_fuzzy_and_address';
    }
    // Tier 3: Low confidence - needs review
    else if (companyNameExact || locationNameFuzzy > 0.7 || addressMatch || locationNameMatchesCompanyFuzzy > 0.7) {
        tier = 3;
        tierReason = 'weak_match';
    }

    return {
        tier,
        tierReason,
        phoneExact,
        locationNameExact,
        companyNameExact,
        locationNameMatchesCompany,
        companyNameMatchesLocation,
        addressMatch,
        addressSimilarity: addressSimilarityScore,
        locationSimilarity: locationNameFuzzy,
        companySimilarity: companyNameFuzzy,
        nameSimilarity,
        nameMatch,
        locationsForCompany
    };
};

const searchByPhone = async (authToken, phone) => {
    const contacts = await serviceTradeService.searchContacts(authToken, phone);
    const normalizedSearch = normalizePhone(phone);
    const candidates = [];

    logMatchEvent('phone_search_contacts_fetched', {
        phone,
        contactsCount: contacts.length
    });

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
        logMatchEvent('phone_search_contact_matches', {
            phone,
            candidateLocations: candidates.length,
            locationIds: candidates.map((candidate) => candidate.locationId).filter(Boolean)
        });
        return candidates;
    }

    // Phone not found in contacts - rely on other search methods (location name, company, address)
    // Removed slow getLocations() fallback for performance (was taking 2-3 minutes)
    // Customers always provide location/company name or address, so other searches will find it
    logMatchEvent('phone_search_contact_not_found_no_fallback', { 
        phone,
        reason: 'Relying on location/company/address searches for better performance'
    });

    return candidates;
};

const searchByName = async (authToken, name) => {
    const contacts = await serviceTradeService.searchContacts(authToken, name);
    const candidates = [];

    logMatchEvent('name_search_contacts_fetched', {
        name,
        contactsCount: contacts.length
    });

    contacts.forEach((contact) => {
        if (Array.isArray(contact.locations) && contact.locations.length > 0) {
            contact.locations.forEach((location) => {
                candidates.push(buildCandidate({ contact, location, source: 'name' }));
            });
        }
    });

    logMatchEvent('name_search_candidates', {
        name,
        candidateLocations: candidates.length,
        locationIds: candidates.map((candidate) => candidate.locationId).filter(Boolean)
    });

    return candidates;
};

const searchByLocationName = async (authToken, locationName) => {
    const locations = await serviceTradeService.searchLocationsByName(authToken, locationName);
    logMatchEvent('location_name_search_results', {
        locationName,
        locationsCount: locations.length,
        locationIds: locations.map((location) => location.id)
    });
    return locations.map((location) => buildCandidate({ contact: location.primaryContact || null, location, source: 'location_name' }));
};

const searchByAddress = async (authToken, address) => {
    const locations = await serviceTradeService.searchLocationsByAddress(authToken, address);
    logMatchEvent('address_search_results', {
        address,
        locationsCount: locations.length,
        locationIds: locations.map((location) => location.id)
    });
    return locations.map((location) => buildCandidate({ contact: location.primaryContact || null, location, source: 'address' }));
};

const searchByCompanyName = async (authToken, companyName) => {
    const companies = await serviceTradeService.searchCompaniesByName(authToken, companyName);
    const companyIds = companies.map((company) => company.id).filter(Boolean);
    logMatchEvent('company_name_search_companies', {
        companyName,
        companyIds,
        companiesCount: companies.length
    });
    if (companyIds.length === 0) return [];

    const locations = await serviceTradeService.searchLocationsByCompanyIds(authToken, companyIds);
    logMatchEvent('company_name_search_locations', {
        companyName,
        companyIds,
        locationsCount: locations.length,
        locationIds: locations.map((location) => location.id)
    });
    return locations.map((location) =>
        buildCandidate({ contact: location.primaryContact || null, location, source: 'company_name' })
    );
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
        
        // Also search as company name (customer might say company instead of location)
        tasks.push(searchByCompanyName(authToken, searchData.locationName));
        taskLabels.push('location_name_as_company');
    }
    if (searchData.address) {
        tasks.push(searchByAddress(authToken, searchData.address));
        taskLabels.push('address');
    }
    if (searchData.companyName) {
        tasks.push(searchByCompanyName(authToken, searchData.companyName));
        taskLabels.push('company_name');
        
        // Also search as location name (customer might say location instead of company)
        tasks.push(searchByLocationName(authToken, searchData.companyName));
        taskLabels.push('company_name_as_location');
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

    const allCandidates = Array.from(deduped.values());
    
    const tieredCandidates = allCandidates.map((candidate) => ({
        ...candidate,
        ...determineMatchQuality(candidate, searchData, allCandidates)
    }));

    // Sort by tier (1 = best), then by match quality within tier
    tieredCandidates.sort((a, b) => {
        // Sort by tier first (lower tier number = higher priority)
        if (a.tier !== b.tier) return a.tier - b.tier;

        // Within same tier, sort by match quality
        // Tier 1: prefer phone+address over phone alone
        if (a.tier === 1) {
            if (a.phoneExact && a.addressMatch && !(b.phoneExact && b.addressMatch)) return -1;
            if (b.phoneExact && b.addressMatch && !(a.phoneExact && a.addressMatch)) return 1;
        }

        // Sort by similarity scores
        const addressSort = (b.addressSimilarity || 0) - (a.addressSimilarity || 0);
        if (addressSort !== 0) return addressSort;

        const locationSort = (b.locationSimilarity || 0) - (a.locationSimilarity || 0);
        if (locationSort !== 0) return locationSort;

        const companySort = (b.companySimilarity || 0) - (a.companySimilarity || 0);
        if (companySort !== 0) return companySort;

        const phoneSort = (b.phoneExact ? 1 : 0) - (a.phoneExact ? 1 : 0);
        return phoneSort;
    });

    const topCandidates = tieredCandidates.slice(0, 5).map((candidate) => ({
        locationId: candidate.locationId,
        locationName: candidate.locationName,
        companyName: candidate.companyName,
        contactName: candidate.contactName,
        tier: candidate.tier,
        tierReason: candidate.tierReason,
        phoneExact: candidate.phoneExact,
        locationNameExact: candidate.locationNameExact,
        companyNameExact: candidate.companyNameExact,
        addressMatch: candidate.addressMatch,
        addressSimilarity: candidate.addressSimilarity,
        locationSimilarity: candidate.locationSimilarity,
        companySimilarity: candidate.companySimilarity
    }));

    logMatchEvent('matching_summary', {
        searchData,
        candidateCount: tieredCandidates.length,
        tier1Count: tieredCandidates.filter(c => c.tier === 1).length,
        tier2Count: tieredCandidates.filter(c => c.tier === 2).length,
        tier3Count: tieredCandidates.filter(c => c.tier === 3).length,
        topCandidates
    });
    return tieredCandidates;
};

module.exports = {
    findCustomerWithConfidence
};
