const serviceTradeService = require('./serviceTradeService');
const supabaseService = require('./supabaseService');
const config = require('../config/environment');

/**
 * Phone -> ServiceTrade location index, built from the full location list.
 *
 * WHY A TABLE AND NOT AN API QUERY: ServiceTrade has no phone filter on
 * GET /location. Its only phone-indexed endpoint is GET /contact?search=, which
 * cannot see a location's own main line (Location.phoneNumber) because that field
 * lives on the location, not on any contact. A caller ringing the site's main
 * number is therefore invisible to contact search.
 *
 * WHY IT IS CHEAP: the whole location list comes back in ONE request
 * (GET /location?limit=1000). Measured against Adaptive: 393 locations, 1 page,
 * ~370ms. The "removed slow getLocations() fallback (2-3 minutes)" note in
 * customerMatchingService.js does not hold for a tenant this size.
 *
 * WHY ONLY UNIQUE NUMBERS COUNT: 45 of Adaptive's 204 distinct numbers appear on
 * more than one location — head-office lines, property-manager numbers, and their
 * own dispatch number. A number that maps to several locations identifies none of
 * them, so it is indexed but never returned as a match.
 */

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// Last ten digits, extensions stripped first. See src/utils/phone.js.
const { normalizePhone } = require('../utils/phone');

// One entry per ServiceTrade account (keyed by agent id, which owns the token).
const caches = new Map();

const formatAddress = (address) => {
    const a = address || {};
    return [a.street, a.city, a.state, a.postalCode].filter(Boolean).join(', ').trim();
};

const buildIndex = (locations) => {
    const index = new Map();
    for (const location of locations) {
        if (!location || !location.id) continue;
        const pc = location.primaryContact || {};
        const numbers = [location.phoneNumber, pc.phone, pc.mobile, pc.alternatePhone]
            .map(normalizePhone)
            .filter((n) => n.length === 10);

        for (const number of new Set(numbers)) {
            if (!index.has(number)) index.set(number, []);
            index.get(number).push({
                locationId: location.id,
                locationName: location.name || '',
                locationStatus: location.status || null,
                address: location.address || null,
                matchedAddress: formatAddress(location.address)
            });
        }
    }
    return index;
};

// A table-built index is cached briefly, not for the full 12 hours: it exists because
// ServiceTrade was unreachable, and the next call should try the API again rather than
// serve mirrored data all day.
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Rebuild the index from the `servicetrade_locations` mirror instead of the API.
 *
 * WHICH tenant's rows to read is not obvious: this index is keyed by auth token while
 * the mirror is keyed by agent id, and for Adaptive those are two different agents —
 * the ServiceTrade config lives on the outbound dispatch agent, the mirrored rows are
 * keyed by the inbound one. Reading the wrong tenant's locations would be worse than
 * reading none.
 *
 * The link is `servicetrade_tokens.st_username`: both agents authenticate as the same
 * ServiceTrade user, so a shared username means a shared account. That is a fact in
 * the database, not a mapping someone has to declare — and it costs one extra read on
 * a path that only runs when ServiceTrade is already down.
 *
 * Returns null when nothing matches or the matched agent has no mirrored rows.
 */
async function buildIndexFromMirror(stAgentId) {
    const configured = config.locationSyncAgentIds || [];
    if (!stAgentId || configured.length === 0) return null;

    const usernames = await supabaseService.getTokenUsernames([stAgentId, ...configured]);
    const holding = usernames.get(stAgentId);
    if (!holding) {
        console.warn(`[location-phone-index] ${stAgentId} has no st_username — cannot identify its mirrored rows`);
        return null;
    }

    const mirrorAgentId = configured.find((agentId) => usernames.get(agentId) === holding);
    if (!mirrorAgentId) return null;

    const rows = await supabaseService.getLocationsForAgent(mirrorAgentId);
    if (!rows || rows.length === 0) return null;

    // Reuse the API's own shape so buildIndex sees exactly what it sees live.
    // `raw_response` is the untouched GET /location payload, so primaryContact's
    // phone/mobile/alternate come along — 107 further distinct numbers on this
    // account, which the flat columns alone would lose.
    const locations = rows.map((row) => {
        const raw = row.raw_response || {};
        return {
            id: row.servicetrade_id,
            name: row.name || raw.name || '',
            status: row.status || raw.status || null,
            phoneNumber: row.phone_number || raw.phoneNumber || '',
            primaryContact: raw.primaryContact || null,
            address: raw.address || {
                street: row.street || '',
                city: row.city || '',
                state: row.state || '',
                postalCode: row.postal_code || ''
            }
        };
    });

    return { index: buildIndex(locations), locationCount: locations.length, agentId: mirrorAgentId };
}

/**
 * Return the cached index for this account, rebuilding it when absent or stale.
 * A rebuild failure returns the previous index if one exists — a ServiceTrade blip
 * should degrade to slightly stale data, not to no data.
 *
 * With no cached index either (a cold instance during a ServiceTrade outage, which is
 * exactly when an emergency call must still resolve), fall back to the hourly-synced
 * `servicetrade_locations` mirror before giving up.
 */
async function getIndex(authToken, cacheKey, stAgentId) {
    const key = cacheKey || 'default';
    const cached = caches.get(key);
    const ttl = cached && cached.source === 'mirror' ? FALLBACK_CACHE_TTL_MS : CACHE_TTL_MS;
    const fresh = cached && Date.now() - cached.builtAt < ttl;
    if (fresh) return cached.index;

    try {
        const started = Date.now();
        const locations = await serviceTradeService.getAllLocations(authToken);
        const index = buildIndex(locations);
        caches.set(key, { index, builtAt: Date.now(), source: 'api' });
        console.log(`[location-phone-index] built for ${key}: ${locations.length} locations, ${index.size} distinct numbers, ${Date.now() - started}ms`);
        return index;
    } catch (error) {
        console.error(`[location-phone-index] rebuild failed for ${key}: ${error.message || error}`);
        if (cached) {
            console.warn(`[location-phone-index] serving stale index for ${key}`);
            return cached.index;
        }

        try {
            const mirrored = await buildIndexFromMirror(stAgentId);
            if (mirrored) {
                caches.set(key, { index: mirrored.index, builtAt: Date.now(), source: 'mirror' });
                // Loud on purpose: a match resolved from the mirror must be
                // distinguishable in the logs from one resolved live, because the
                // mirror is only as current as the last successful hourly sync.
                console.warn(`[location-phone-index] SERVING FROM MIRROR for ${key} (agent ${mirrored.agentId}): ${mirrored.locationCount} locations, ${mirrored.index.size} distinct numbers — ServiceTrade unreachable`);
                return mirrored.index;
            }
        } catch (fallbackError) {
            console.error(`[location-phone-index] mirror fallback failed: ${fallbackError.message || fallbackError}`);
        }

        throw error;
    }
}

/**
 * Resolve a caller's number to exactly one ServiceTrade location.
 *
 * @returns {Promise<null | {locationId, locationName, locationStatus, address, matchedAddress}>}
 *   null when the number is unusable, unknown, or ambiguous across several locations.
 */
async function lookupByPhone(authToken, phone, cacheKey, stAgentId) {
    const number = normalizePhone(phone);
    if (number.length !== 10) return null;

    const index = await getIndex(authToken, cacheKey, stAgentId);
    const hits = index.get(number);
    if (!hits || hits.length === 0) return null;

    if (hits.length > 1) {
        // Prefer a single ACTIVE location when the collision is between an active one
        // and deactivated duplicates — that is a renamed/re-created site, not a genuine
        // ambiguity. Anything else stays unresolved.
        const active = hits.filter((h) => h.locationStatus !== 'inactive');
        if (active.length !== 1) {
            console.log(`[location-phone-index] ${number} maps to ${hits.length} locations — not identifying`);
            return null;
        }
        return active[0];
    }

    return hits[0];
}

/**
 * EVERY location whose own line matches, ambiguity included.
 *
 * lookupByPhone deliberately returns null when a number spans several locations,
 * because its job is to identify one. A caller deciding whether a number is
 * unambiguous ENOUGH to settle a match needs the opposite: the raw count, so a
 * contact-derived hit on one location cannot look unique while the same number sits
 * on two others' main lines.
 *
 * @returns {Promise<Array>} possibly empty; never null.
 */
async function lookupAllByPhone(authToken, phone, cacheKey, stAgentId) {
    const number = normalizePhone(phone);
    if (number.length !== 10) return [];

    const index = await getIndex(authToken, cacheKey, stAgentId);
    return index.get(number) || [];
}

// Drop a cached index so the next lookup rebuilds. Used by tests.
function invalidate(cacheKey) {
    if (cacheKey) caches.delete(cacheKey);
    else caches.clear();
}

module.exports = { lookupByPhone, lookupAllByPhone, invalidate, normalizePhone, _buildIndex: buildIndex };
