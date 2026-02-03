---
name: Post-Call ServiceTrade Integration
overview: Create a NEW codebase at `VOICEAGENT-ST-WEBHOOK` that receives Retell's `call_analyzed` webhook, validates address via Google Maps (required), matches customer using parallel search with confidence scoring, and creates a ServiceTrade job when confidence >= 80.
todos:
  - id: create-googlemaps-service
    content: Create src/services/googleMapsService.js for address validation using GOOGLE_MAPS_KEY
    status: pending
  - id: enhance-servicetrade
    content: Add searchContacts, searchLocationsByName methods to serviceTradeService.js
    status: pending
  - id: create-matching-service
    content: Create src/services/customerMatchingService.js with parallel matching and confidence scoring (threshold 80+)
    status: pending
  - id: create-webhook-route
    content: Create webhook handler at src/routes/webhook/retell.js for call_analyzed events
    status: pending
  - id: update-app-routes
    content: Register new webhook route in app.js
    status: pending
  - id: test-webhook
    content: Test webhook with sample call_analyzed payload
    status: pending
isProject: false
---

# Post-Call ServiceTrade Integration Plan

## Problem Statement

The current implementation has two critical issues:

1. **Latency**: During-call processing (tool call invocations) causes delays, especially when falling back to fetching all locations
2. **Unreliable Customer Matching**: Phone-only search misses customers who are location primary contacts but not in the Contact directory
3. **Accuracy is Critical**: Wrong location match means technician goes to wrong location

## Proposed Architecture

```mermaid
flowchart TB
    subgraph RetellAI[Retell AI Platform]
        Call[Voice Call]
        Analysis[Post-Call Analysis]
    end
    
    subgraph Webhook["/webhook/retell"]
        Handler[Webhook Handler]
        GoogleMaps[Google Maps Validation]
    end
    
    subgraph MatchingService[Customer Matching Service - Parallel]
        ParallelRunner[Promise.all]
        PhoneMatch[Phone Search]
        NameMatch[Name Search]
        AddressMatch[Address Match]
        Scorer[Confidence Scorer]
    end
    
    subgraph ServiceTradeAPI[ServiceTrade API]
        ContactAPI["/contact?search="]
        LocationAPI["/location?name="]
        JobAPI["/job POST"]
    end
    
    subgraph Supabase[Supabase - Existing Tables]
        Tokens[servicetrade_tokens]
        JobConfig[servicetrade_job_configs]
    end
    
    subgraph External[External APIs]
        GMaps[Google Maps Geocoding]
    end
    
    Call --> Analysis
    Analysis -->|call_analyzed| Handler
    Handler --> Tokens
    Tokens -->|auth_token| GoogleMaps
    GoogleMaps -->|validate address| GMaps
    GMaps -->|normalized address| ParallelRunner
    ParallelRunner --> PhoneMatch
    ParallelRunner --> NameMatch
    ParallelRunner --> AddressMatch
    PhoneMatch --> ContactAPI
    NameMatch --> ContactAPI
    AddressMatch --> LocationAPI
    ContactAPI --> Scorer
    LocationAPI --> Scorer
    Scorer -->|"confidence >= 80"| JobAPI
    Scorer -->|"confidence < 80"| ConsoleLog[Console.log]
```



## New Codebase Location

- **Root folder**: `/Users/apple/voiceagent-st-webhook`
- **Note**: Implementation will be in this new codebase (not in `Claraservicetradeapi` or `integration_capabilities`)

## Key Files to Modify/Create

### 1. Google Maps Address Validation Service

**File**: `src/services/googleMapsService.js`

Validates and normalizes addresses before matching using Google Maps Geocoding API.
Address validation is **required** for this implementation (no skipping).

```javascript
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY;

/**
 * Validate and normalize an address using Google Maps Geocoding API
 * Returns structured address components for better matching
 */
async function validateAddress(rawAddress) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(rawAddress)}&key=${GOOGLE_MAPS_KEY}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.status !== 'OK' || !data.results?.length) {
        console.log('⚠️ Google Maps could not validate address:', rawAddress);
        return null;
    }
    
    const result = data.results[0];
    const components = result.address_components;
    
    // Extract structured address parts
    const getComponent = (type) => components.find(c => c.types.includes(type))?.long_name || '';
    const getShortComponent = (type) => components.find(c => c.types.includes(type))?.short_name || '';
    
    return {
        formatted_address: result.formatted_address,
        street_number: getComponent('street_number'),
        street_name: getComponent('route'),
        street: `${getComponent('street_number')} ${getComponent('route')}`.trim(),
        city: getComponent('locality') || getComponent('sublocality'),
        state: getShortComponent('administrative_area_level_1'),
        postalCode: getComponent('postal_code'),
        country: getShortComponent('country'),
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        place_id: result.place_id
    };
}

module.exports = { validateAddress };
```

**Benefits of Google Maps validation:**
- Normalizes "123 Main St" vs "123 Main Street" vs "123 main st"
- Extracts structured city/state/zip for precise matching
- Gets lat/lng for potential geo-radius matching
- Returns null for invalid addresses (prevents bad matches)

### 2. New Webhook Handler

**File**: `src/routes/webhook/retell.js`

Handles incoming `call_analyzed` webhook events from Retell:

- Extracts analyzed data fields (caller_name, address, issue_description, urgency)
- Validates address with Google Maps
- Triggers parallel customer matching with confidence scoring
- Creates job if confidence >= 80, otherwise logs for manual review

### 2. Customer Matching Service (Parallel with Scoring)

**File**: `src/services/customerMatchingService.js`

Parallel multi-strategy customer matching with confidence scoring:

```javascript
/**
 * Run all search strategies in parallel using Promise.all
 * This is concurrent I/O (not CPU threads) - minimal overhead
 */
async function findCustomerWithConfidence(authToken, searchData) {
  const { phone, name, address } = searchData;
  
  // Run all searches in parallel - ~200ms total vs ~600ms sequential
  const [phoneResults, nameResults, addressResults] = await Promise.all([
    phone ? searchByPhone(authToken, phone) : Promise.resolve([]),
    name ? searchByName(authToken, name) : Promise.resolve([]),
    address ? searchByAddress(authToken, address) : Promise.resolve([])
  ]);
  
  // Score and rank all candidates
  const candidates = scoreAndRankCandidates({
    phoneResults,
    nameResults, 
    addressResults,
    searchData
  });
  
  return candidates; // Sorted by confidence score
}

/**
 * Confidence Scoring Algorithm
 * 
 * Score Components (max 100 points):
 * - Phone exact match: +40 points
 * - Phone partial match: +20 points  
 * - Name exact match: +30 points
 * - Name fuzzy match (>80% similarity): +15 points
 * - Address exact match: +30 points
 * - Address partial match: +15 points
 * 
 * Thresholds:
 * - >= 80: High confidence → Auto-create job
 * - 50-79: Medium confidence → Log for review, include suggestions
 * - < 50: Low confidence → Manual review required (no job created)
 */
function calculateConfidenceScore(candidate, searchData) {
  let score = 0;
  
  // Phone scoring
  if (searchData.phone && candidate.phone) {
    const phoneMatch = normalizePhone(searchData.phone) === normalizePhone(candidate.phone);
    score += phoneMatch ? 40 : (partialPhoneMatch(searchData.phone, candidate.phone) ? 20 : 0);
  }
  
  // Name scoring  
  if (searchData.name && candidate.name) {
    const nameSimilarity = calculateStringSimilarity(searchData.name, candidate.name);
    score += nameSimilarity === 1 ? 30 : (nameSimilarity > 0.8 ? 15 : 0);
  }
  
  // Address scoring
  if (searchData.address && candidate.address) {
    const addressSimilarity = calculateAddressSimilarity(searchData.address, candidate.address);
    score += addressSimilarity === 1 ? 30 : (addressSimilarity > 0.7 ? 15 : 0);
  }
  
  return score;
}
```

### 3. Enhanced ServiceTrade Service

**File**: `src/services/serviceTradeService.js`

Add new search methods based on **exact ServiceTrade API documentation** (`api.ServiceTrade.com - API documentation.html`):

```javascript
/**
 * Search contacts by name, phone, or email
 * ServiceTrade API: GET /contact?search={query}
 * The 'search' param matches against contact name, phone numbers, OR email address
 */
async searchContacts(authToken, searchQuery) {
    const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
    const response = await fetch(
        `${this.baseUrl}/contact?search=${encodeURIComponent(searchQuery)}`,
        { 
            method: 'GET',
            headers: { 'Cookie': cookieValue, 'Content-Type': 'application/json' } 
        }
    );
    const { data } = await response.json();
    return data.contacts || [];
}

/**
 * Search locations by name
 * ServiceTrade API: GET /location?name={query}&limit=100
 * The 'name' param searches in location name OR store number (substring match)
 * NOTE: No direct address search available in API - must filter client-side
 */
async searchLocationsByName(authToken, nameQuery) {
    const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
    const response = await fetch(
        `${this.baseUrl}/location?name=${encodeURIComponent(nameQuery)}&limit=100&status=active`,
        { 
            method: 'GET',
            headers: { 'Cookie': cookieValue, 'Content-Type': 'application/json' } 
        }
    );
    const { data } = await response.json();
    return data.locations || [];
}

/**
 * Get locations with address filtering (client-side)
 * Since ServiceTrade has NO address search param, we fetch and filter
 */
async searchLocationsByAddress(authToken, addressQuery) {
    const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
    // Fetch active locations with higher limit for address matching
    const response = await fetch(
        `${this.baseUrl}/location?status=active&limit=1000`,
        { 
            method: 'GET',
            headers: { 'Cookie': cookieValue, 'Content-Type': 'application/json' } 
        }
    );
    const { data } = await response.json();
    const locations = data.locations || [];
    
    // Client-side address filtering
    const normalizedQuery = addressQuery.toLowerCase().replace(/[^\w\s]/g, '');
    return locations.filter(loc => {
        if (!loc.address) return false;
        const fullAddress = `${loc.address.street} ${loc.address.city} ${loc.address.state} ${loc.address.postalCode}`.toLowerCase();
        return fullAddress.includes(normalizedQuery) || 
               normalizedQuery.includes(loc.address.street?.toLowerCase());
    });
}
```

**ServiceTrade API Reference** (from `api.ServiceTrade.com - API documentation.html`):

**Contact endpoint (`/contact`) Query Params:**
- `search` (string): Match against contact **name, phone numbers, or email address**
- `locationId` (integer): Return only contacts for specific location
- `companyId` (integer): Return only contacts for specific company
- `email` (string): Exact match against email

**Location endpoint (`/location`) Query Params:**
- `name` (string): Search in **location name or store number** (substring match)
- `companyId` (string): Comma-delimited company IDs
- `status` (string): Filter by status ('active', 'inactive', 'pending')
- `limit` (integer): Results limit (default 10, max 5000)

**IMPORTANT LIMITATION**: ServiceTrade Location API has **NO direct address search parameter**. Address matching requires fetching locations and filtering client-side.

### 4. Existing Supabase Tables (No Changes Needed)

**Database**: Using existing Supabase instance from `.env`:
- `SUPABASE_URL`: `https://tpvserzjhmyxjssabokm.supabase.co`

**Existing Table**: `servicetrade_tokens` - Used for auth token lookup

```sql
-- Already exists - no changes needed
CREATE TABLE public.servicetrade_tokens (
  id bigint generated by default as identity not null,
  created_at timestamp with time zone not null default now(),
  agent_id character varying not null,
  auth_token character varying not null,
  auth_data jsonb not null default '{}'::jsonb,
  constraint servicetrade_tokens_pkey primary key (id),
  constraint servicetrade_tokens_agent_id_key unique (agent_id)
);
```

**Usage**: The webhook will extract `agent_id` from the `call_analyzed` payload and look up `auth_token` from this table.

**Logging**: For this first version, errors will be logged to console. A proper `job_creation_logs` table can be added later for production monitoring.

### 5. Updated App Routes

**File**: `src/app.js`

Add new webhook route:

```javascript
const retellWebhookRoutes = require('./routes/webhook/retell');
app.use('/webhook', retellWebhookRoutes);
```

## Retell Post-Call Analysis Configuration

Configure these analysis fields in Retell dashboard:

- `caller_name` (string): Name extracted from conversation
- `caller_address` (string): Address mentioned in call
- `issue_description` (string): Summary of the service issue
- `urgency` (string): "emergency", "urgent", "routine"
- `preferred_date` (string): If customer mentions preferred appointment date
- `preferred_time` (string): If customer mentions preferred time

## Customer Matching Logic Detail (Parallel with Scoring)

```mermaid
flowchart TD
    Start[Receive call_analyzed webhook] --> Extract[Extract: phone, name, address, issue]
    
    Extract --> Parallel[Run Promise.all - Parallel Search]
    
    subgraph ParallelSearch[Parallel Search - ~200ms total]
        PhoneSearch[Phone Search]
        NameSearch[Name Search]
        AddressSearch[Address Search]
    end
    
    Parallel --> PhoneSearch
    Parallel --> NameSearch
    Parallel --> AddressSearch
    
    PhoneSearch --> Collect[Collect All Results]
    NameSearch --> Collect
    AddressSearch --> Collect
    
    Collect --> Score[Calculate Confidence Scores]
    
    Score --> Evaluate{Highest Score?}
    
    Evaluate -->|">= 80 points"| SingleMatch{Single match?}
    Evaluate -->|"50-79 points"| LogWithSuggestions[Log for Review + Suggestions]
    Evaluate -->|"< 50 points"| ManualOnly[Manual Review Required]
    
    SingleMatch -->|Yes| CreateJob[Auto-Create Job]
    SingleMatch -->|No, multiple| PickBest[Pick highest scored]
    
    PickBest --> CreateJob
    
    CreateJob --> LogSuccess[Log success to Supabase]
    LogWithSuggestions --> CustomUI[Custom UI: Review Queue]
    ManualOnly --> CustomUI
    
    LogSuccess --> Done[Done]
    CustomUI --> Done
```



## Confidence Scoring Reference


| Match Type              | Points | Example                       |
| ----------------------- | ------ | ----------------------------- |
| Phone exact match       | +40    | "5551234567" === "5551234567" |
| Phone partial match     | +20    | Last 7 digits match           |
| Name exact match        | +30    | "John Smith" === "John Smith" |
| Name fuzzy match (>80%) | +15    | "John Smith" ~ "Jon Smith"    |
| Address exact match     | +30    | Full address matches          |
| Address partial match   | +15    | Street + city match           |


**Decision Thresholds:**


| Score Range | Action                          | Reason                                       |
| ----------- | ------------------------------- | -------------------------------------------- |
| >= 80       | Auto-create job                 | High confidence - safe to proceed            |
| 50-79       | Log for review with suggestions | Medium confidence - needs human verification |
| < 50        | Manual review only              | Low confidence - too risky to auto-create    |


## Why Parallel is Better Than Sequential

```
Sequential (current approach):
  Phone search ──200ms──> Name search ──200ms──> Address search ──200ms──> Total: ~600ms

Parallel (new approach):  
  Phone search ──200ms──┐
  Name search  ──200ms──├──> Scorer ──10ms──> Total: ~210ms
  Address search──200ms─┘

Benefits:
- 3x faster execution
- No additional CPU cost (Node.js async I/O)
- All data available for cross-validation scoring
- Better accuracy through combined signals
```

## Implementation Order

1. **Step 0**: Create new codebase folder `voiceagent-st-webhook` at workspace root
2. **Step 1**: Create `googleMapsService.js` for required address validation using `GOOGLE_MAPS_KEY`
3. **Step 2**: Add new search methods to `serviceTradeService.js` (searchContacts, searchLocationsByName)
4. **Step 3**: Create `customerMatchingService.js` with parallel search and confidence scoring
5. **Step 4**: Create webhook handler at `src/routes/webhook/retell.js`
6. **Step 5**: Register webhook route in `app.js`
7. **Step 6**: Test with sample `call_analyzed` payload

## Environment Variables Required

All keys are already in `.env`:
```
GOOGLE_MAPS_KEY=AIzaSyD8bXwY5bX1Z7y3F4X9Vj1KXJz8Q9V7E6M  # For address validation
openaiapikey=sk-proj-...                                  # Available if needed
SUPABASE_URL=https://tpvserzjhmyxjssabokm.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIs...
```

## Error Handling (First Version)

For this initial implementation:
- **Confidence >= 80**: Auto-create job in ServiceTrade
- **Confidence < 80**: Log to console with details (no job created)
- **API errors**: Log to console, return appropriate HTTP status

```javascript
// Example error logging
if (bestMatch.confidence < 80) {
  console.log('❌ Low confidence match - manual review needed:', {
    callId: webhookData.call_id,
    callerPhone: searchData.phone,
    callerName: searchData.name,
    bestMatch: bestMatch,
    allCandidates: candidates
  });
  return res.status(200).json({ status: 'pending_review', message: 'Low confidence - manual review required' });
}
```

## Future Enhancements (Not in Scope Now)

- Add `job_creation_logs` table for proper tracking
- Build custom UI for manual review queue
- Add Slack/email notifications for low-confidence matches
- Implement retry logic for failed API calls

## Backward Compatibility

The existing during-call routes (`/st-customer`, `/st-create-job`) will remain functional for:

- Existing agents not migrated to post-call flow
- Fallback if post-call processing fails
- Testing and debugging

