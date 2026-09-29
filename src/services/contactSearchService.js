/**
 * ONE sideloaded ServiceTrade contact search, shared by every caller that needs it.
 *
 * WHY IT IS ONE REQUEST. ServiceTrade's `/contact?search=` is a single fuzzy field that
 * takes a phone number, a contact name or an email. `_sideload` pulls the related
 * entities into the same response object, so contact + companies + locations + addresses
 * arrive together instead of a second round trip or getLocations()'s page-by-page scan
 * (minutes, on a live emergency call). Measured at ~60ms on the Braconier account.
 *
 * WHY IT LIVES HERE AND NOT IN verifyCustomer.js. Two tenants now need the same search
 * with the same response-shape tolerance: Braconier's customer gate and the Adaptive
 * inbound lookup. Two copies of `normalizeContactSearch` would drift the moment
 * ServiceTrade changes a field name, and the whole point of that function is that the
 * undocumented sideloaded shape is normalized in exactly one place.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It applies no customer gate and picks no winner.
 * Those are tenant policy — Braconier refuses a non-customer company, Adaptive refuses
 * nobody — and they belong to the callers.
 */

// `status=public,private` returns contacts of both statuses.
const SIDELOAD = 'contact.locations,contact.companies,location.company';
const CONTACT_STATUS = 'public,private';
const SERVICETRADE_BASE = 'https://api.servicetrade.com/api';

// Comfortably inside a caller's patience, and far above the ~60ms this search measures at.
const LOOKUP_TIMEOUT_MS = 8000;

// ServiceTrade stores names as typed, which for these accounts means ALL CAPS with stray
// whitespace ("BRAD ", "POSITIVE APPROACH"). The agent speaks these aloud, so they are
// cleaned on the way out rather than at every call site.
const toSpokenName = (value) => String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

// The four parts, in the order the agent speaks them. Blank parts are dropped rather than
// producing a doubled comma.
const spokenAddress = (loc) => [loc.street, loc.city, loc.state, loc.postal_code]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');

/**
 * Resolve either response shape into one internal object.
 *
 * `_sideload` and `status` are outside ServiceTrade's published contract, and the shapes
 * differ materially — `contact.company` is a bare int here and an embedded object in the
 * documented response, locations are top-level and referenced by id here but nested
 * there, and pagination sits in `meta` rather than `data`. Reading the sideloaded shape
 * directly would mean a silent removal of the parameter becomes a runtime type error
 * mid-call. Both shapes normalize through here instead, so switching to the documented
 * endpoint is a config change rather than a rewrite.
 *
 * Location rows come out in the {street, city, state, postal_code} shape that
 * addressMatchService.matchAgainstRows already consumes — that is deliberate, so the
 * fuzzy matcher needs no adapter of its own.
 */
const normalizeContactSearch = (json) => {
    const data = (json && json.data) || {};
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];

    const byId = (rows) => {
        const map = new Map();
        (Array.isArray(rows) ? rows : []).forEach((row) => {
            if (row && row.id !== undefined) map.set(String(row.id), row);
        });
        return map;
    };

    const locationsById = byId(data.locations);
    const companiesById = byId(data.companies);
    const addressesById = byId(data.addresses);
    const sideloaded = locationsById.size > 0 || companiesById.size > 0;

    // A location arrives as an id (sideloaded) or as a whole object (documented).
    const toLocationRow = (entry) => {
        const loc = (entry && typeof entry === 'object')
            ? entry
            : locationsById.get(String(entry));
        if (!loc) return null;

        // Sideloaded locations carry addressStreet/addressCity/...; documented ones nest
        // an address object; and a sideloaded `address` may be an id into data.addresses.
        const addr = (loc.address && typeof loc.address === 'object')
            ? loc.address
            : addressesById.get(String(loc.address)) || {};

        return {
            servicetrade_id: loc.id,
            name: loc.name || '',
            status: loc.status || 'active',
            street: loc.addressStreet || addr.street || '',
            city: loc.addressCity || addr.city || '',
            state: loc.addressState || addr.state || '',
            postal_code: loc.addressPostalCode || addr.postalCode || '',
            companyId: loc.company && typeof loc.company === 'object'
                ? loc.company.id
                : loc.company
        };
    };

    const normalized = contacts.map((contact) => {
        const locations = (Array.isArray(contact.locations) ? contact.locations : [])
            .map(toLocationRow)
            .filter(Boolean);

        // On the shared live record `contact.companies` is [] while `contact.company` is
        // populated — the company is derived THROUGH the location, not directly assigned.
        // Reading companies[] would have returned nothing.
        const companyRef = contact.company
            || (locations.length > 0 ? locations[0].companyId : null);
        const company = (companyRef && typeof companyRef === 'object')
            ? companyRef
            : companiesById.get(String(companyRef)) || null;

        return {
            contactId: contact.id,
            contactName: toSpokenName(`${contact.firstName || ''} ${contact.lastName || ''}`),
            email: contact.email || '',
            companyId: company ? company.id : null,
            companyName: company ? toSpokenName(company.name) : '',
            // Braconier's whole verdict. `customer` is ServiceTrade's own flag; the
            // documented shape omits it unless sideloaded, which is why that case falls
            // back to null (unknown) rather than false (rejected).
            companyIsCustomer: company && typeof company.customer === 'boolean'
                ? company.customer
                : null,
            companyStatus: company ? company.status : null,
            locations
        };
    });

    return {
        shape: sideloaded ? 'sideloaded' : 'documented',
        totalRecords: (json && json.meta && json.meta.totalRecords) !== undefined
            ? json.meta.totalRecords
            : (data.totalRecords !== undefined ? data.totalRecords : contacts.length),
        contacts: normalized
    };
};

const fetchContactSearch = async (authToken, term) => {
    const url = `${SERVICETRADE_BASE}/contact`
        + `?search=${encodeURIComponent(term)}`
        + `&_sideload=${encodeURIComponent(SIDELOAD)}`
        + '&limit=100&page=1'
        + `&status=${encodeURIComponent(CONTACT_STATUS)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Cookie: `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
        }

        // Guarded for the same reason serviceTradeService.getContacts is: an empty body
        // reaching .json() throws "Unexpected end of JSON input", which is
        // indistinguishable from "no match" by the time it reaches the caller.
        const text = await response.text();
        if (!text) throw new Error('ServiceTrade returned an empty body');
        return JSON.parse(text);
    } finally {
        clearTimeout(timeout);
    }
};

/** fetch + normalize, the pair every caller actually wants. */
const searchContacts = async (authToken, term) =>
    normalizeContactSearch(await fetchContactSearch(authToken, term));

module.exports = {
    SIDELOAD,
    CONTACT_STATUS,
    SERVICETRADE_BASE,
    LOOKUP_TIMEOUT_MS,
    toSpokenName,
    spokenAddress,
    normalizeContactSearch,
    fetchContactSearch,
    searchContacts
};
