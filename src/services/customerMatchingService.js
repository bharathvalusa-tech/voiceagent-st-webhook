const config = require('../config/environment');
const serviceTradeService = require('./serviceTradeService');
const locationPhoneIndex = require('./locationPhoneIndex');

// Compare on the LAST TEN digits, not on every digit — and strip extensions first.
// See src/utils/phone.js for why the order matters.
const { normalizePhone } = require('../utils/phone');
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

const getSearchPrefix = (name, prefixLen = 5) => {
    const trimmed = (name || '').trim();
    if (trimmed.length <= prefixLen) return trimmed;
    return trimmed.slice(0, prefixLen);
};

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

const dedupeLocationsById = (locations) => {
    const uniqueLocations = new Map();
    locations.forEach((location) => {
        const key = location?.id || `${location?.name || 'unknown'}-${location?.company?.id || 'unknown'}`;
        if (!uniqueLocations.has(key)) {
            uniqueLocations.set(key, location);
        }
    });
    return Array.from(uniqueLocations.values());
};

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

const logMatchEvent = (message, context = {}) => {
    console.log(JSON.stringify({ level: 'info', message, ...context }));
};

const buildCandidate = ({ contact, location, source }) => {
    return {
        source,
        contactId: contact?.id || null,
        contactName: contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() : '',
        // Fall back to the LOCATION's own main line when there is no contact. A site
        // whose only number is `Location.phoneNumber` reaches us through the location
        // phone index with `contact: null`; without this fallback its candidate carries
        // no phone at all, `phoneExact` is false, and it can never reach Tier 1 on the
        // phone — which is the one case locationPhoneIndex.js exists to serve.
        contactPhone: contact?.phone || contact?.mobile || contact?.alternatePhone
            || location?.phoneNumber || '',
        contactEmail: contact?.email || '',
        locationId: location?.id || null,
        locationName: location?.name || '',
        // Location status ('active' | 'inactive' | 'pending' | null). The matcher pool now
        // includes inactive locations; the confident-match selection uses this to prefer
        // active and to flag a known-but-inactive address. Missing → treated as active.
        locationStatus: location?.status || null,
        companyId: location?.company?.id || null,
        companyName: location?.company?.name || '',
        address: location?.address || null
    };
};

const determineMatchQuality = (candidate, searchData, allCandidates) => {
    /**
     * MATCHING PRIORITY ORDER (Tier 1 - Auto-create):
     * 1. Phone + Address (most reliable for multi-location contacts)
     * 2. Location Name + Address
     * 3. Phone (single location only)
     * 4. Company + Location + Address (requires both to avoid confusion like "Uptown" vs "Intown")
     * 
     * Note: Company name + address alone is now Tier 2 due to speech-to-text
     * confusion with similar names (e.g., "Uptown Suites" vs "Intown Suites")
     */
    
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

    // Company name prefix match — catches speech-to-text misspellings
    // e.g. "Diversetec" and "DIVERSATEK" share prefix "diver"
    const companyNamePrefixMatch = (() => {
        if (!searchData.companyName || !candidate.companyName) return false;
        const searchNorm = normalizeText(searchData.companyName);
        const candidateNorm = normalizeText(candidate.companyName);
        if (searchNorm.length < 4 || candidateNorm.length < 4) return false;
        const prefixLen = Math.min(5, searchNorm.length, candidateNorm.length);
        return searchNorm.slice(0, prefixLen) === candidateNorm.slice(0, prefixLen);
    })();

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

    // Address match - use stricter threshold when company names could be ambiguous
    let addressSimilarityScore = 0;
    let addressMatch = false;
    let addressQueryMatch = false;
    if (searchData.address && candidate.address) {
        const candidateAddress = `${candidate.address.street || ''} ${candidate.address.city || ''} ${candidate.address.state || ''} ${candidate.address.postalCode || ''}`.trim();
        addressSimilarityScore = addressSimilarity(searchData.address, candidateAddress);
        addressQueryMatch = hasAddressQueryMatch(searchData.address, candidateAddress);
        
        // Use stricter threshold (0.75) when relying on company name to avoid confusion
        // Use normal threshold (0.6) when we have phone or location name match
        const hasPhoneOrLocation = (searchData.phone && candidate.contactPhone) || 
                                   (searchData.locationName && candidate.locationName);
        const threshold = hasPhoneOrLocation ? 0.6 : 0.75;
        
        addressMatch = addressQueryMatch || addressSimilarityScore > threshold;
    }

    // Count how many unique locations are associated with this company name
    const locationsForCompany = candidate.companyName
        ? new Set(
            allCandidates
                .filter(c => c.companyName === candidate.companyName && c.locationId)
                .map(c => c.locationId)
        ).size
        : 0;

    // Count how many unique locations are tied to the exact incoming phone.
    // If a phone belongs to multiple locations, phone-only matching is ambiguous.
    const locationsForExactPhone = normalizedSearchPhone
        ? new Set(
            allCandidates
                .filter((c) => normalizePhone(c.contactPhone) === normalizedSearchPhone && c.locationId)
                .map((c) => c.locationId)
        ).size
        : 0;

    // Classify into tiers
    let tier = 3; // Default: low confidence
    let tierReason = 'no_strong_match';

    // Tier 1: High confidence - auto-create job
    // PRIORITY 1: Phone + Address (most reliable for disambiguation)
    if (phoneExact && addressMatch) {
        tier = 1;
        tierReason = 'phone_and_address_match';
    } 
    // PRIORITY 2: Location name + Address
    else if (locationNameExact && addressMatch) {
        tier = 1;
        tierReason = 'location_name_and_address_match';
    } else if (locationNameMatchesCompany && addressMatch) {
        tier = 1;
        tierReason = 'location_as_company_and_address_match';
    } 
    // PRIORITY 3: Single phone match (no ambiguity)
    else if (phoneExact && locationsForExactPhone === 1) {
        tier = 1;
        tierReason = 'phone_match_single_location';
    }
    // PRIORITY 4: Company name + Address (moved DOWN because of speech-to-text confusion like "Uptown" vs "Intown")
    else if (companyNameExact && addressMatch && locationNameExact) {
        // Require BOTH company AND location name to match with address for tier 1
        // This prevents confusion between similar company names
        tier = 1;
        tierReason = 'company_location_and_address_exact';
    } else if (companyNameFuzzy > 0.95 && addressMatch && locationNameExact) {
        // Very high company name similarity (0.95+) + location name + address
        tier = 1;
        tierReason = 'company_fuzzy_location_and_address_match';
    } else if (companyNamePrefixMatch && addressMatch && locationNameExact) {
        // Company name prefix + location name + address
        tier = 1;
        tierReason = 'company_prefix_location_and_address_match';
    }
    // Company name + address alone is now Tier 2 (too risky with similar names)
    else if (locationNameExact && companyNameExact) {
        tier = 1;
        tierReason = 'location_and_company_exact';
    } else if (locationNameMatchesCompany && locationsForCompany === 1) {
        tier = 1;
        tierReason = 'location_as_company_single_location';
    } else if (phoneExact && addressSimilarityScore > 0.5) {
        // Phone match with decent address similarity (even if not perfect match)
        // This catches cases where address might have minor differences but phone is exact
        tier = 1;
        tierReason = 'phone_match_with_address_similarity';
    } else if (phoneExact) {
        tier = 2;
        tierReason = 'phone_match_multiple_locations';
    }
    // Tier 2: Medium confidence - create with note
    else if (addressQueryMatch) {
        tier = 2;
        tierReason = 'address_query_match';
    } else if (companyNameExact && addressMatch) {
        // Company name + address WITHOUT location name confirmation
        // Moved to tier 2 due to similar company names (Uptown vs Intown)
        tier = 2;
        tierReason = 'company_and_address_exact_no_location';
    } else if (companyNameFuzzy > 0.9 && addressMatch) {
        // Very high company similarity + address but no location name
        tier = 2;
        tierReason = 'company_fuzzy_and_address_no_location';
    } else if (companyNamePrefixMatch && addressMatch) {
        // Company prefix + address but no location name
        tier = 2;
        tierReason = 'company_prefix_and_address_no_location';
    } else if (locationNameExact) {
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
    } else if (companyNameFuzzy > 0.6 && addressMatch) {
        // Allow common transcription/spelling drift when address is a strong match
        tier = 2;
        tierReason = 'company_fuzzy_and_address';
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
        companyNamePrefixMatch,
        locationNameMatchesCompany,
        companyNameMatchesLocation,
        addressMatch,
        addressQueryMatch,
        addressSimilarity: addressSimilarityScore,
        locationSimilarity: locationNameFuzzy,
        companySimilarity: companyNameFuzzy,
        locationsForCompany,
        locationsForExactPhone
    };
};

// A contact attached to more locations than this identifies nobody. ServiceTrade
// accounts carry system/catch-all contacts — Adaptive's "Service Trade Work
// Acknowledgements" is on 103 of their 393 locations — and fanning one of those out
// produces a hundred candidates that can never resolve to a confident match, at the
// cost of building them on every call.
const MAX_CONTACT_LOCATION_FANOUT = 8;

const searchByPhone = async (authToken, phone, stAgentId) => {
    // ServiceTrade's `search=` does NOT match an E.164 string: "+14169012663" returns
    // zero contacts where "4169012663" returns the right one. Always query the
    // ten-digit form.
    const normalizedSearch = normalizePhone(phone);
    if (!normalizedSearch) {
        logMatchEvent('phone_search_skipped_unusable_number', { phone });
        return [];
    }

    const contacts = await serviceTradeService.searchContacts(authToken, normalizedSearch);
    const candidates = [];

    logMatchEvent('phone_search_contacts_fetched', {
        phone,
        query: normalizedSearch,
        contactsCount: contacts.length
    });

    contacts.forEach((contact) => {
        const phones = [contact.phone, contact.mobile, contact.alternatePhone].filter(Boolean);
        const hasMatch = phones.some((p) => normalizePhone(p) === normalizedSearch);
        if (!hasMatch) return;

        const locations = Array.isArray(contact.locations) ? contact.locations : [];
        if (locations.length > MAX_CONTACT_LOCATION_FANOUT) {
            logMatchEvent('phone_search_contact_rejected_fanout', {
                phone: normalizedSearch,
                contactId: contact.id,
                locationCount: locations.length
            });
            return;
        }

        locations.forEach((location) => {
            candidates.push(buildCandidate({ contact, location, source: 'phone' }));
        });
    });

    if (candidates.length > 0) {
        logMatchEvent('phone_search_contact_matches', {
            phone,
            candidateLocations: candidates.length,
            locationIds: candidates.map((candidate) => candidate.locationId).filter(Boolean)
        });
        return candidates;
    }

    // No usable contact hit. Fall back to the location phone index — a site's own main
    // line (Location.phoneNumber) lives on the location, so /contact?search= can never
    // find it. The index is one cached request, not the multi-minute scan the old
    // getLocations() fallback was.
    try {
        const hit = await locationPhoneIndex.lookupByPhone(
            authToken, normalizedSearch, authToken, stAgentId
        );
        if (hit) {
            logMatchEvent('phone_search_location_index_hit', {
                phone: normalizedSearch,
                locationId: hit.locationId,
                locationStatus: hit.locationStatus
            });
            return [
                buildCandidate({
                    contact: null,
                    location: {
                        id: hit.locationId,
                        name: hit.locationName,
                        status: hit.locationStatus,
                        address: hit.address
                    },
                    source: 'location_phone'
                })
            ];
        }
    } catch (error) {
        // Never let the index take the whole match down — the address/name searches
        // still run in parallel and can resolve this call on their own.
        console.error(`[matching] location phone index lookup failed: ${error.message || error}`);
    }

    logMatchEvent('phone_search_no_match', { phone: normalizedSearch });
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
    const directLocations = dedupeLocationsById(
        await serviceTradeService.searchLocations(authToken, locationName)
    );
    if (directLocations.length > 0) {
        logMatchEvent('location_name_search_results', {
            locationName,
            searchMode: 'direct_search',
            locationsCount: directLocations.length,
            locationIds: directLocations.map((location) => location.id)
        });
        return directLocations.map((location) =>
            buildCandidate({ contact: location.primaryContact || null, location, source: 'location_name' })
        );
    }

    const fallbackQuery = getSearchPrefix(locationName);
    const locations = await serviceTradeService.searchLocationsByName(authToken, fallbackQuery);
    logMatchEvent('location_name_search_results', {
        locationName,
        searchMode: 'legacy_name_fallback',
        fallbackQuery,
        locationsCount: locations.length,
        locationIds: locations.map((location) => location.id)
    });
    return locations.map((location) => buildCandidate({ contact: location.primaryContact || null, location, source: 'location_name' }));
};

const searchByAddress = async (authToken, address) => {
    const queries = buildAddressSearchQueries(address);

    for (const query of queries) {
        const directLocations = dedupeLocationsById(
            await serviceTradeService.searchLocations(authToken, query)
        );
        if (directLocations.length > 0) {
            logMatchEvent('address_search_results', {
                address,
                searchMode: 'direct_search',
                queryUsed: query,
                attemptedQueries: queries,
                locationsCount: directLocations.length,
                locationIds: directLocations.map((location) => location.id)
            });
            return directLocations.map((location) =>
                buildCandidate({ contact: location.primaryContact || null, location, source: 'address_direct' })
            );
        }
    }

    const locations = await serviceTradeService.searchLocationsByAddress(authToken, address);
    logMatchEvent('address_search_results', {
        address,
        searchMode: 'legacy_scan_fallback',
        attemptedQueries: queries,
        locationsCount: locations.length,
        locationIds: locations.map((location) => location.id)
    });
    return locations.map((location) =>
        buildCandidate({ contact: location.primaryContact || null, location, source: 'address_fallback' })
    );
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

const narrowDirectAddressCandidates = (tieredCandidates, directAddressLocationIds) => {
    if (directAddressLocationIds.size <= 1) {
        return tieredCandidates;
    }

    const corroboratedLocationIds = new Set(
        tieredCandidates
            .filter((candidate) => directAddressLocationIds.has(candidate.locationId))
            .filter((candidate) =>
                candidate.locationNameExact ||
                candidate.companyNameExact ||
                candidate.locationNameMatchesCompany ||
                candidate.companyNameMatchesLocation
            )
            .map((candidate) => candidate.locationId)
    );

    if (corroboratedLocationIds.size !== 1) {
        return tieredCandidates;
    }

    return tieredCandidates.filter((candidate) => corroboratedLocationIds.has(candidate.locationId));
};

const findCustomerWithConfidence = async (authToken, searchData) => {
    const tasks = [];
    const taskLabels = [];
    let addressCandidates = [];
    let directAddressLocationIds = new Set();

    // PHONE FIRST, and authoritative when it is unambiguous.
    //
    // A caller number that resolves to exactly ONE ServiceTrade location identifies the
    // site by itself — it needs no corroboration from a spoken address, and it must not
    // be second-guessed by one. Both of those used to happen: the address-direct filter
    // below discards any candidate outside `directAddressLocationIds`, so a correct
    // phone match lost to a fuzzy address hit on a different site.
    //
    // Ambiguity still falls through. 19 of the 110 distinct numbers on the Adaptive
    // account sit on more than one location (head-office lines, property managers);
    // those identify nothing on their own and need the address path.
    let prefetchedPhoneCandidates = null;
    if (searchData.phone && normalizePhone(searchData.phone).length === 10) {
        prefetchedPhoneCandidates = await searchByPhone(authToken, searchData.phone, searchData.stAgentId);

        // BOTH sources have to agree before this settles anything.
        //
        // searchByPhone consults the location index only when contact search came back
        // empty, so a number found on ONE contact looks unique even while the same
        // number is the main line of two other locations. Live example on this account:
        // 416-755-9518 is on a contact at "Greenwin(2223 Eglinton Ave. E)" and on the
        // main line of two further Greenwin sites — three candidates, one of which the
        // contact path would have settled on alone. The address search used to be able
        // to correct that; a short-circuit cannot, so it must not fire.
        let indexLocationIds = [];
        try {
            const indexHits = await locationPhoneIndex.lookupAllByPhone(
                authToken, searchData.phone, authToken, searchData.stAgentId
            );
            indexLocationIds = indexHits.map((hit) => hit.locationId).filter(Boolean);
        } catch (error) {
            // The index being unavailable must not turn into a confident single match.
            // Skip the short-circuit and let the full fan-out decide.
            console.error(`[matching] phone-first index check failed, deferring to the full search: ${error.message || error}`);
            indexLocationIds = null;
        }

        const phoneLocationIds = indexLocationIds === null ? [] : [...new Set([
            ...prefetchedPhoneCandidates.map((candidate) => candidate.locationId).filter(Boolean),
            ...indexLocationIds
        ])];

        if (phoneLocationIds.length === 1) {
            const settled = prefetchedPhoneCandidates
                .filter((candidate) => candidate.locationId === phoneLocationIds[0])
                .map((candidate) => ({
                    ...candidate,
                    ...determineMatchQuality(candidate, searchData, prefetchedPhoneCandidates),
                    tier: 1,
                    tierReason: 'phone_match_single_location',
                    // searchByPhone already verified this number against the contact's
                    // phone/mobile/alternate, or came from the location's own line. The
                    // recomputed flag can read false when the match was on `mobile` while
                    // `contactPhone` holds `phone`, so state what we know instead.
                    phoneExact: true
                }));

            logMatchEvent('phone_first_settled_match', {
                phone: searchData.phone,
                locationId: phoneLocationIds[0],
                locationName: settled[0].locationName,
                locationStatus: settled[0].locationStatus,
                candidateCount: settled.length,
                // Recorded so a settled match is auditable: both the contact graph and
                // the location index pointed at this one location and nothing else.
                corroboratedBy: ['contact_search', 'location_phone_index'],
                skippedSearches: ['name', 'location_name', 'address', 'company_name']
            });
            return settled;
        }

        logMatchEvent('phone_first_not_settled', {
            phone: searchData.phone,
            distinctLocationIds: phoneLocationIds.length,
            contactLocationIds: [...new Set(prefetchedPhoneCandidates.map((c) => c.locationId).filter(Boolean))].length,
            indexLocationIds: indexLocationIds === null ? 'unavailable' : [...new Set(indexLocationIds)].length,
            reason: indexLocationIds === null
                ? 'index_unavailable'
                : (phoneLocationIds.length === 0 ? 'no_phone_candidates' : 'ambiguous_across_locations')
        });
    }

    if (searchData.phone) {
        // Reuse the fetch above rather than querying ServiceTrade for the same number
        // twice; only search afresh when the short-circuit was skipped outright.
        tasks.push(prefetchedPhoneCandidates
            ? Promise.resolve(prefetchedPhoneCandidates)
            : searchByPhone(authToken, searchData.phone, searchData.stAgentId));
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
        const locationPrefix = getSearchPrefix(searchData.locationName);
        tasks.push(searchByCompanyName(authToken, locationPrefix));
        taskLabels.push('location_name_as_company');
    }
    if (searchData.address) {
        addressCandidates = await searchByAddress(authToken, searchData.address);
        directAddressLocationIds = new Set(
            addressCandidates
                .filter((candidate) => candidate.source === 'address_direct' && candidate.locationId)
                .map((candidate) => candidate.locationId)
        );
        tasks.push(Promise.resolve(addressCandidates));
        taskLabels.push('address');
    }
    if (searchData.companyName) {
        const companyPrefix = getSearchPrefix(searchData.companyName);
        tasks.push(searchByCompanyName(authToken, companyPrefix));
        taskLabels.push('company_name');
        
        // Also search as location name (customer might say location instead of company)
        tasks.push(searchByLocationName(authToken, searchData.companyName));
        taskLabels.push('company_name_as_location');
    }

    const results = await Promise.all(tasks);
    let candidates = results.flat();

    if (directAddressLocationIds.size > 0) {
        candidates = candidates.filter((candidate) =>
            !candidate.locationId || directAddressLocationIds.has(candidate.locationId)
        );
        logMatchEvent('address_primary_filter_applied', {
            address: searchData.address,
            retainedLocationIds: Array.from(directAddressLocationIds),
            candidateCountAfterFilter: candidates.length
        });
    }

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

    const narrowedTieredCandidates = narrowDirectAddressCandidates(
        tieredCandidates,
        directAddressLocationIds
    );

    if (narrowedTieredCandidates.length !== tieredCandidates.length) {
        logMatchEvent('address_direct_tiebreak_applied', {
            address: searchData.address,
            retainedLocationIds: [...new Set(narrowedTieredCandidates.map((candidate) => candidate.locationId).filter(Boolean))],
            candidateCountBeforeTiebreak: tieredCandidates.length,
            candidateCountAfterTiebreak: narrowedTieredCandidates.length
        });
    }

    // Sort by tier (1 = best), then by match quality within tier
    narrowedTieredCandidates.sort((a, b) => {
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

    const topCandidates = narrowedTieredCandidates.slice(0, 5).map((candidate) => ({
        locationId: candidate.locationId,
        locationName: candidate.locationName,
        locationStatus: candidate.locationStatus,
        companyName: candidate.companyName,
        contactName: candidate.contactName,
        tier: candidate.tier,
        tierReason: candidate.tierReason,
        phoneExact: candidate.phoneExact,
        locationNameExact: candidate.locationNameExact,
        companyNameExact: candidate.companyNameExact,
        addressMatch: candidate.addressMatch,
        addressQueryMatch: candidate.addressQueryMatch,
        addressSimilarity: candidate.addressSimilarity,
        locationSimilarity: candidate.locationSimilarity,
        companySimilarity: candidate.companySimilarity
    }));

    logMatchEvent('matching_summary', {
        searchData,
        candidateCount: narrowedTieredCandidates.length,
        tier1Count: narrowedTieredCandidates.filter(c => c.tier === 1).length,
        tier2Count: narrowedTieredCandidates.filter(c => c.tier === 2).length,
        tier3Count: narrowedTieredCandidates.filter(c => c.tier === 3).length,
        topCandidates
    });
    return narrowedTieredCandidates;
};

module.exports = {
    findCustomerWithConfidence
};
