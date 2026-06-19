# Voice Agent Webhook — System Blueprint
### CRM-Agnostic Implementation Guide

This document captures the full architecture, logic, and design decisions of this webhook system so it can be re-implemented against any CRM. ServiceTrade-specific API calls are clearly marked — everything else is CRM-agnostic.

---

## Overview

A voice AI agent (Retell AI) takes inbound calls. When the call ends, Retell fires a `call_analyzed` webhook. This system:
1. Parses the call data
2. Finds the matching customer/location in the CRM using fuzzy logic
3. Creates a job/ticket automatically if confidence is high enough
4. Sends an email notification either way

---

## Tech Stack

| Layer | Technology | Swappable? |
|---|---|---|
| Runtime | Node.js (Express) | Yes |
| Deployment | Vercel (serverless) | Yes |
| Voice AI | Retell AI | Yes — adapt `extractPayload` |
| CRM | ServiceTrade | **Yes — primary swap target** |
| Auth DB | Supabase | Yes |
| Address validation | Google Maps API | Yes |
| Email | SendGrid | Yes |

---

## Files to Create

```
src/
  app.js                          — Express entry point
  routes/
    webhook/
      retell.js                   — Main webhook handler (orchestrator)
  services/
    customerMatchingService.js    — All fuzzy logic + confidence scoring (CRM-agnostic)
    serviceTradeService.js        — CRM API calls (REPLACE THIS for new CRM)
    emailNotificationService.js   — SendGrid email builder + sender
    retellService.js              — Retell API client (fetch call details)
    googleMapsService.js          — Address validation
    supabaseService.js            — Config/token storage
  config/
    environment.js                — Env var parsing + thresholds
    database.js                   — Supabase client init
vercel.json                       — Deployment config
```

---

## Step 1 — Webhook Entry Point

**File:** `routes/webhook/retell.js`

### 1a. Receive and immediately respond

```
POST /webhook/retell
```

- Read `x-retell-signature` header for future HMAC verification
- Call `extractPayload(req.body)` to normalize the body shape
- If event type is not `call_analyzed` → return 200, do nothing
- Extract `callId` and `agentId`
- Check idempotency: store `callId → timestamp` in a local Map with 5-min TTL. If already processed → return 200 with `duplicate` status
- **Respond 200 immediately** before doing any work
- Run all processing in the background using `waitUntil()` (Vercel) or equivalent

> **Why respond immediately?** Retell retries if it doesn't get 200 fast. All real work is async.

### 1b. Forward to secondary systems (optional)

Before processing, fire-and-forget a copy of the raw webhook body to an internal API gateway for logging or other consumers. Use a 3-second abort timeout. Never let this block the main flow.

---

## Step 2 — Parse Raw Payload

**Function:** `extractPayload(body)`

Retell's webhook payload shape can vary. Normalize it into:

```js
{
  eventType,      // "call_analyzed"
  call,           // the call object
  analysis,       // call_analysis sub-object
  extracted,      // custom_analysis_data / extracted_data from LLM
  dynamicVars     // collected_dynamic_variables from Retell custom functions
}
```

Try multiple key paths for each because Retell's shape differs across agent configurations:
- `body.call`, `body.data.call`, `body.data`
- `body.call_analysis`, `body.data.call_analysis`, `call.call_analysis`
- `analysis.custom_analysis_data`, `analysis.extracted_data`, `analysis.call_analyzed_data`

---

## Step 3 — Field Extraction

**Function:** `loadExtractedFields(extracted, analysis, dynamicVars)`

Extract every field you need for matching. For each field, check multiple source keys in priority order and take the first non-null value.

### Fields to extract and their priority order:

**Phone**
1. `call.from_number` (most reliable — comes from carrier)
2. `extracted.caller_phone`
3. `extracted.phone`

**Caller Name**
1. `extracted.caller_name`
2. `extracted.customer_name`
3. `dynamicVars.callerName`, `dynamicVars.customerName`

**Address** — try component-by-component first, then raw string
1. Build from: `extracted.address_line1` + `extracted.city` + `extracted.state` + `extracted.postal_code`
2. `extracted.caller_address`, `extracted.address`, `extracted.serviceAddress`
3. `dynamicVars.validated_address`, `dynamicVars.serviceAddress`

**Location Name** (branch/site name within a company)
1. `extracted.location_name`
2. `extracted.business_name`
3. `extracted.location`

**Company Name**
1. `extracted.company_name`
2. `extracted.company`
3. `extracted.business_name` (only if different from location name)

**Tech IDs** (CRM-specific — who should be assigned)
- Scan `dynamicVars` keys matching regex `/^tech\d*_id$/i` or `/^technician\d*_id$/i`
- Fallback to `extracted.tech_id`, `extracted.tech_ids`

**Service Line IDs** (CRM-specific — type of service)
- Scan `dynamicVars` keys matching regex `/^service[_-]?line\d*[_-]?id$/i`
- Fallback to `extracted.serviceLineId`, `extracted.service_line_ids`

**Call Type**
- `dynamicVars.call_type` → `extracted.call_type` → `call.call_type`
- Normalize to lowercase string
- If `web_call` → skip job creation entirely

**Emergency Flag**
- Check `dynamicVars.isEmergency`, then `extracted.isEmergency`, then `analysis.isEmergency`
- Normalize boolean: accept `true/false`, `1/0`, `"yes"/"no"`, `"true"/"false"`
- Take the first non-null result

### Retell API fallback

If after extraction `callerPhone`, `callerName`, AND `rawAddress` are all missing:
- Call the Retell API: `GET /v2/get-call/{callId}`
- Re-run `loadExtractedFields` on the richer response
- Merge: API data as base, webhook data overrides on top

---

## Step 4 — Address Validation

**Service:** Google Maps API (or equivalent geocoder)

```js
validateAddress({ line1, city, state, postalCode })
→ { street, city, state, postalCode }  // normalized canonical form
```

- On success: build `addressForMatching = "123 Main St, Dallas, TX, 75001"`
- On failure or error: fall back to the raw address string from the call
- **Never block job creation because address validation failed** — just use the raw string

---

## Step 5 — Load Agent Config from Database

Query your config store (Supabase in this implementation) by `agentId`:

**Table: `servicetrade_tokens`** (rename to `crm_tokens` for new CRM)

Required columns:
- `auth_token` — CRM session/API token
- `send_job_email` — boolean, enable job-created emails
- `send_job_fail_email` — boolean, enable job-not-created emails
- `emailto` — comma-separated recipient list
- `ccmail` — comma-separated CC list

**Table: `servicetrade_job_configs`** (rename to `crm_job_configs`)

Required columns:
- `create_emergency_jobs` — boolean, whether to create jobs when `isEmergency = true`

---

## Step 6 — Customer Matching

**File:** `services/customerMatchingService.js`

This is the CRM-agnostic core. The only CRM-specific parts are the search functions that call out to CRM APIs.

### 6a. Similarity Algorithms

These are pure functions — keep them exactly as-is.

#### `normalizePhone(phone)`
Strip everything except digits: `/[^\d]/g`

#### `normalizeText(text)`
Lowercase → replace non-alphanumeric with space → collapse whitespace → trim

#### `tokenSimilarity(a, b)` — Jaccard on words
```
tokens_a = set of words in normalizeText(a)
tokens_b = set of words in normalizeText(b)
score = |intersection| / |union|
```
Example: "Dallas Fire Alarm" vs "Dallas Alarm" → intersection={dallas,alarm}, union={dallas,fire,alarm} → 2/3 = 0.67

#### `bigramSimilarity(a, b)` — Dice on character pairs
```
For "hello": bigrams = ["he","el","ll","lo"]
score = (2 × |shared bigrams|) / (|bigrams_a| + |bigrams_b|)
```
Good for catching typos and speech-to-text errors ("Diversetec" vs "DIVERSATEK")

#### `fuzzySimilarity(a, b)`
```
max(tokenSimilarity(a, b), bigramSimilarity(a, b))
```
Takes the better of the two — word-level matching handles partial name matches, bigram handles misspellings.

#### `addressSimilarity(a, b)`
```
if exact match → 1.0
if one contains the other → 0.9
else → fuzzySimilarity(a, b)
```

### 6b. Address Query Builder

**Function:** `buildAddressSearchQueries(address)`

Generates multiple search query variants from one address string to maximize CRM search hits:

```
Input:  "123 N Main Street, Suite 4, Dallas, TX"

Step 1: Extract street segment before first comma → "123 N Main Street"
Step 2: Tokenize → ["123", "n", "main", "street"]
Step 3: Find house number (digit token) → "123" at index 0
Step 4: Remove unit tokens (suite, apt, floor, etc.)
Step 5: Find street suffix (street, ave, rd, etc.) → truncate there
Step 6: coreTokens = ["n", "main"]  (up to 3 tokens after house number)
Step 7: Remove leading directional → ["main"]

Output queries (deduplicated):
  "123 n main"          ← house + core + directional
  "123 main"            ← house + core without directional
  "123 N Main Street"   ← full street segment
  "123 N Main Street, Suite 4, Dallas, TX"  ← full raw address
```

These queries are tried in order against the CRM's search API — stops at first hit.

#### `hasAddressQueryMatch(a, b)`
Generates queries for both addresses and checks if any query variant from A appears in B's query set. This is the strict address equality check used in scoring.

### 6c. CRM Search Functions

These 5 functions are the **only CRM-specific part** of the matching system. Replace their internals for a new CRM but keep the signatures and return shape identical.

Each returns an array of **candidate objects** (see `buildCandidate` below).

#### `searchByPhone(authToken, phone)`
- Call CRM: `GET /contact?search={phone}`
- For each contact returned, check if any of their phones (primary, mobile, alternate) matches after `normalizePhone()`
- For each matching contact, expand into one candidate per location they're associated with
- If no contact match found → return `[]` (do NOT fall back to scanning all locations — too slow)

#### `searchByName(authToken, name)`
- Call CRM: `GET /contact?search={name}`
- Return all locations for all matching contacts (no filtering at this stage — scoring handles it)

#### `searchByLocationName(authToken, locationName)`
- Try CRM general search first: `GET /location?search={locationName}`
- If that returns results → use them
- If empty → fall back to name-specific search with first 5 chars as prefix: `GET /location?name={prefix}`
- Map results through `buildCandidate`

#### `searchByAddress(authToken, address)`
- Generate queries via `buildAddressSearchQueries(address)`
- Try each query sequentially against `GET /location?search={query}`
- Stop and return on the **first query that yields results**
- If all queries return empty → fall back to full location scan + in-memory address filtering:
  - Fetch ALL active locations (paginated, run pages in parallel)
  - For each location, normalize its address and compute token overlap
  - Keep locations where: `tokenOverlap >= 0.8` OR `(postalMatch AND tokenOverlap >= 0.5)` OR substring match

#### `searchByCompanyName(authToken, companyName)`
- Call CRM: `GET /company?name={first5chars}`
- Get company IDs from results
- Call CRM: `GET /location?companyId={id1,id2,...}` (batch, comma-separated)
- Return all locations under those companies

### 6d. Candidate Shape

**Function:** `buildCandidate({ contact, location, source })`

Flatten each contact+location pair into a single object:

```js
{
  source,           // 'phone' | 'name' | 'location_name' | 'address_direct' | 
                    // 'address_fallback' | 'company_name'
  contactId,
  contactName,      // "firstName lastName"
  contactPhone,     // primary phone
  contactEmail,
  locationId,
  locationName,
  companyId,
  companyName,
  address           // { street, city, state, postalCode }
}
```

**CRM adaptation:** The only thing to change is which fields to pull from your CRM's contact/location object shape.

### 6e. Running All Searches

**Function:** `findCustomerWithConfidence(authToken, searchData)`

```
searchData = { phone, name, locationName, companyName, address }
```

Build task list based on which fields are present:
- phone → `searchByPhone`
- name → `searchByName`
- locationName → `searchByLocationName` + also `searchByCompanyName(locationName)` (cross-search)
- address → `searchByAddress` (run this FIRST, sequentially, before the parallel batch)
- companyName → `searchByCompanyName` + also `searchByLocationName(companyName)` (cross-search)

> Cross-searches matter because callers often say the company name when asked "location name" and vice versa.

Run all except address in `Promise.all()`. Merge all arrays, deduplicate by `locationId-contactId` key.

**Address pre-filter:** If `searchByAddress` returned direct hits (source = `address_direct`), discard any candidate whose `locationId` is NOT in that set. This prevents a strong phone match at the wrong location from winning.

---

## Step 7 — Confidence Scoring

**Function:** `determineMatchQuality(candidate, searchData, allCandidates)`

This is the heart of the system. Runs once per candidate after all searches complete.

### 7a. Compute All Signals

For each candidate, compute these boolean/numeric signals:

| Signal | How to compute |
|---|---|
| `phoneExact` | `normalizePhone(searchData.phone) === normalizePhone(candidate.contactPhone)` |
| `locationNameExact` | `normalizeText(searchData.locationName) === normalizeText(candidate.locationName)` |
| `locationNameFuzzy` | `fuzzySimilarity(searchData.locationName, candidate.locationName)` (0–1) |
| `companyNameExact` | `normalizeText(searchData.companyName) === normalizeText(candidate.companyName)` |
| `companyNameFuzzy` | `fuzzySimilarity(searchData.companyName, candidate.companyName)` (0–1) |
| `companyNamePrefixMatch` | first `min(5, len)` chars of normalized names match (catches STT drift) |
| `locationNameMatchesCompany` | `normalizeText(searchData.locationName) === normalizeText(candidate.companyName)` |
| `locationNameMatchesCompanyFuzzy` | `fuzzySimilarity(searchData.locationName, candidate.companyName)` |
| `companyNameMatchesLocation` | `normalizeText(searchData.companyName) === normalizeText(candidate.locationName)` |
| `addressSimilarityScore` | `addressSimilarity(searchData.address, candidateFullAddress)` |
| `addressQueryMatch` | `hasAddressQueryMatch(searchData.address, candidateFullAddress)` |
| `addressMatch` | see threshold logic below |
| `nameSimilarity` | `fuzzySimilarity(searchData.name, candidate.contactName)` |
| `locationsForExactPhone` | count of unique locationIds in `allCandidates` with the same exact phone |
| `locationsForCompany` | count of unique locationIds in `allCandidates` with the same companyName |

**Address match threshold logic:**
```
if phone or locationName is also present:
    threshold = 0.6   (lenient — other signals reduce ambiguity)
else:
    threshold = 0.75  (strict — address is the only identifier)

addressMatch = addressQueryMatch OR (addressSimilarityScore > threshold)
```

### 7b. Tier Assignment

Evaluate conditions in strict priority order. First match wins.

---

#### TIER 1 — High Confidence (auto-create job, no human review)

| Priority | Condition | Reason Code |
|---|---|---|
| 1 | `phoneExact AND addressMatch` | `phone_and_address_match` |
| 2 | `locationNameExact AND addressMatch` | `location_name_and_address_match` |
| 3 | `locationNameMatchesCompany AND addressMatch` | `location_as_company_and_address_match` |
| 4 | `phoneExact AND locationsForExactPhone === 1` | `phone_match_single_location` |
| 5 | `companyNameExact AND locationNameExact AND addressMatch` | `company_location_and_address_exact` |
| 6 | `companyNameFuzzy > 0.95 AND locationNameExact AND addressMatch` | `company_fuzzy_location_and_address_match` |
| 7 | `companyNamePrefixMatch AND locationNameExact AND addressMatch` | `company_prefix_location_and_address_match` |
| 8 | `locationNameExact AND companyNameExact` (no address needed) | `location_and_company_exact` |
| 9 | `locationNameMatchesCompany AND locationsForCompany === 1` | `location_as_company_single_location` |
| 10 | `phoneExact AND addressSimilarityScore > 0.5` | `phone_match_with_address_similarity` |

> **Design rationale for Tier 1:** Multiple signals required to prevent false positives from speech-to-text errors. Phone alone is only Tier 1 when there's exactly one location for that phone — otherwise it's ambiguous.

---

#### TIER 2 — Medium Confidence (create job, add a note for review)

| Condition | Reason Code |
|---|---|
| `phoneExact` (multiple locations) | `phone_match_multiple_locations` |
| `addressQueryMatch` alone | `address_query_match` |
| `companyNameExact AND addressMatch` (no location name) | `company_and_address_exact_no_location` |
| `companyNameFuzzy > 0.9 AND addressMatch` (no location name) | `company_fuzzy_and_address_no_location` |
| `companyNamePrefixMatch AND addressMatch` (no location name) | `company_prefix_and_address_no_location` |
| `locationNameExact` alone | `location_name_exact` |
| `locationNameMatchesCompany` alone | `location_name_matches_company` |
| `companyNameMatchesLocation` alone | `company_name_matches_location` |
| `companyNameExact AND locationsForCompany === 1` | `company_match_single_location` |
| `companyNameFuzzy > 0.6 AND addressMatch` | `company_fuzzy_and_address` |
| `locationNameMatchesCompany AND addressMatch` | `location_as_company_and_address` |
| `locationNameFuzzy > 0.8 AND addressMatch` | `location_fuzzy_and_address` |
| `companyNameFuzzy > 0.8 AND locationNameFuzzy > 0.8` | `company_and_location_fuzzy` |
| `locationNameMatchesCompanyFuzzy > 0.8 AND addressMatch` | `location_as_company_fuzzy_and_address` |

> **Why company+address alone is only Tier 2:** Speech-to-text confuses similar names ("Uptown Suites" → "Intown Suites"). Without location name as a third signal, the risk of a wrong match is too high.

---

#### TIER 3 — Low Confidence (do not create job, send for manual review)

Any of these alone without a stronger combination:
- `companyNameExact` only
- `locationNameFuzzy > 0.7`
- `addressMatch` without name/phone support
- `locationNameMatchesCompanyFuzzy > 0.7`

If nothing matches any condition → candidate score stays Tier 3 with reason `no_strong_match`.

---

### 7c. Returned Score Object

```js
{
  tier,                        // 1, 2, or 3
  tierReason,                  // string code from tables above
  phoneExact,                  // boolean
  locationNameExact,           // boolean
  companyNameExact,            // boolean
  companyNamePrefixMatch,      // boolean
  locationNameMatchesCompany,  // boolean
  companyNameMatchesLocation,  // boolean
  addressMatch,                // boolean
  addressQueryMatch,           // boolean
  addressSimilarity,           // 0–1 float
  locationSimilarity,          // 0–1 float (locationNameFuzzy)
  companySimilarity,           // 0–1 float (companyNameFuzzy)
  nameSimilarity,              // 0–1 float
  nameMatch,                   // boolean (nameSimilarity > 0.6)
  locationsForCompany,         // integer
  locationsForExactPhone       // integer
}
```

---

## Step 8 — Tie-Breaking and Sorting

### Address direct hit narrowing

**Function:** `narrowDirectAddressCandidates(tieredCandidates, directAddressLocationIds)`

If address search returned 2+ direct hits:
- Among those locations, find ones where `locationNameExact OR companyNameExact OR locationNameMatchesCompany OR companyNameMatchesLocation` is also true
- If exactly 1 such location → keep only that one, discard the rest
- Otherwise → leave all candidates unchanged

### Sort order

```
1. Tier ascending (1 beats 2 beats 3)
2. Within Tier 1: phone+address beats phone alone
3. addressSimilarity descending
4. locationSimilarity descending
5. companySimilarity descending
6. phoneExact descending
```

---

## Step 9 — Candidate Selection

After sorting, the webhook handler selects from the ranked list:

**Tier 1 candidates present:**
- Take `tier1Candidates[0]`
- Proceed to validation then job creation

**Only Tier 2 candidates:**
- Check if all tier 2 candidates point to the same `locationId`
- If **yes (1 unique location)** → take it, proceed with job creation + note
- If **no (multiple locations)** → do NOT create job, send manual review notification

**Only Tier 3 candidates:**
- Do NOT create job
- Send manual review notification with top 3 candidates listed

**No candidates at all:**
- Do NOT create job
- Send manual review notification with `no_matches` reason

---

## Step 10 — Cross-Validation

**Function:** `validateCandidateAgainstRetellData({ candidate, searchContext })`

Even after a Tier 1 match, run a sanity check to prevent bad phone-only matches:

**Rule 1:** If the caller provided address, company, or location name (any of them), at least ONE must match the selected candidate. If none match → reject, send for manual review.

**Rule 2:** If phone maps to multiple locations AND caller provided other identifiers AND none of them match → reject as `ambiguous_phone_mapping`.

Thresholds used in this validation:
- Address: `addressMatch OR addressSimilarity >= 0.75`
- Company: `companyNameExact OR locationNameMatchesCompany OR companySimilarity >= 0.6`
- Location: `locationNameExact OR companyNameMatchesLocation OR locationSimilarity >= 0.75`

---

## Step 11 — Job Creation

**File:** `controllers/serviceTradeController.js` (CRM-specific, replace for new CRM)

Call CRM API to create a job/ticket with:
- `locationId` — from selected candidate
- `description` — built by `buildJobDescription()`
- `techIds` — assigned technicians (from call)
- `serviceLineId` — type of service (from call)

**`buildJobDescription(issueDescription, callerName, callerPhone, currentNode)`**
- Prefix: `[OFFICE HOURS]` or `[AFTER HOURS]` based on `currentNode` value
- Replace generic words "caller" / "customer" in description with actual caller name
- Format: `[AFTER HOURS]: John Smith (555-1234) reported heating unit not working`

---

## Step 12 — Email Notifications

**File:** `services/emailNotificationService.js`

Emails are sent automatically when all three conditions pass:
1. `SENDGRID_API_KEY` is configured
2. `settings.send_job_email = true` (from DB per agent)
3. For failures: `settings.send_job_fail_email = true`

### Two email templates

**Job Created**
- Subject: `New Service Request Logged - {Name} | {Type}`
- Contains: caller info, service location, issue description, job number, link to CRM job
- Badge: `Emergency Job Created` or `Service Request Logged`

**Job Not Created**
- Subject: `Service Request Needs Review - {Name} | {Type}`
- Contains: same info + reason code + human-readable reason message + top candidate list + validation summary
- Badge: `Manual Review Needed`

### Reason codes sent in failure emails

| Reason Code | Meaning |
|---|---|
| `no_matches` | No candidates found at all |
| `low_confidence_matches` | Only Tier 3 weak matches |
| `multiple_medium_confidence_matches` | Tier 2 but multiple different locations |
| `retell_data_mismatch` | Candidate failed cross-validation |
| `ambiguous_phone_mapping` | Phone maps to multiple locations, no corroborating signal |
| `emergency_jobs_disabled` | Call flagged as emergency but config disables emergency job creation |
| `web_call_excluded` | Call type is `web_call`, excluded by design |
| `internal_error` | Uncaught exception |

### Email recipient source
- `settings.emailto` — primary (comma or semicolon separated)
- `settings.ccmail` — CC
- Both come from the per-agent row in the CRM tokens table

---

## Step 13 — Environment Variables

```
PORT                          — Server port (default 3000)
RETELL_API_KEY                — For fetching call details from Retell API
SUPABASE_URL                  — Supabase project URL
SUPABASE_ANON_KEY             — Supabase anon key
SUPABASE_SERVICE_ROLE_KEY     — Supabase service role key (elevated access)
GOOGLE_MAPS_KEY               — Google Maps geocoding API key
SENDGRID_API_KEY              — SendGrid email API key
NOTIFICATION_EMAIL_FROM       — Sender email address
NOTIFICATION_EMAIL_FROM_NAME  — Sender display name

# Tunable thresholds (optional, these are the defaults)
MATCH_CONFIDENCE_THRESHOLD=80
FUZZY_SIMILARITY_THRESHOLD=0.8
NAME_SIMILARITY_THRESHOLD=0.6
```

---

## CRM Adaptation Guide

To port to a different CRM (e.g. ServiceTitan, Salesforce, Jobber, HubSpot):

### What to replace

| File | What to change |
|---|---|
| `serviceTradeService.js` | Rewrite all methods to call your CRM's API. Keep method names and return shapes identical. |
| `supabaseService.js` | Change table names. Column names can stay the same or be remapped. |
| `controllers/serviceTradeController.js` | Rewrite `createJob()` for your CRM's job/ticket API. |
| `config/environment.js` | Add any new env vars your CRM needs. |

### What to keep exactly as-is

- All of `customerMatchingService.js` except the function bodies of the 5 search functions
- `emailNotificationService.js` — fully CRM-agnostic
- `retell.js` logic flow — only swap CRM service imports
- All similarity functions — pure math, no CRM dependency

### CRM data model requirements

Your CRM needs to support these concepts for the matching system to work:

| Concept | Description |
|---|---|
| Contact | A person with a phone number |
| Location / Site | A physical address where service is performed |
| Company / Account | An organization that owns one or more locations |
| Contact ↔ Location link | A contact is associated with one or more locations |
| Location ↔ Company link | A location belongs to a company |

If your CRM uses different terminology (e.g. "Account" instead of "Company", "Asset" instead of "Location"), map accordingly in `buildCandidate()`.

### Search API requirements per function

| Search function | CRM API needed |
|---|---|
| `searchByPhone` | Search contacts by phone/query string, response includes associated locations |
| `searchByName` | Search contacts by name |
| `searchByLocationName` | Search locations by name or general query string |
| `searchByAddress` | Search locations by address or general query string; fallback = paginated full location list |
| `searchByCompanyName` | Search companies by name, then fetch all locations for those company IDs |

---

## Confidence Score Thresholds — Quick Reference

| Threshold | Value | Used for |
|---|---|---|
| Fuzzy similarity (strong) | `> 0.9` | Company name alone → Tier 2 |
| Fuzzy similarity (standard) | `> 0.8` | Location+address → Tier 2; company+location both fuzzy → Tier 2 |
| Fuzzy similarity (company+address) | `> 0.6` | Company fuzzy + address match → Tier 2 |
| Fuzzy similarity (very high company) | `> 0.95` | Company fuzzy + location + address → Tier 1 |
| Address similarity (lenient) | `> 0.6` | When phone or location name also present |
| Address similarity (strict) | `> 0.75` | When address is the only non-phone identifier |
| Address similarity (validation) | `>= 0.75` | Cross-validation check |
| Name match | `> 0.6` | Contact name similarity flag |
| Location Tier 3 floor | `> 0.7` | Minimum to be Tier 3 (not discarded entirely) |
| Company Tier 3 floor | `> 0.7` | Minimum to be Tier 3 |
| Address token overlap (legacy scan) | `>= 0.8` (no postal) or `>= 0.5` (with postal) | `searchLocationsByAddress` fallback |
| Prefix match length | `min(5, len)` chars | `companyNamePrefixMatch` |
