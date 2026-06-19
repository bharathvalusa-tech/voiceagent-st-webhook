# Fuzzy Matching, Confidence Tiers, and Review System

This document explains how the voice agent webhook matches an inbound call to a CRM location, how it decides how confident it is in that match, and what happens based on that confidence level.

---

## Overview

When a call comes in, the system tries to identify which customer/location it belongs to by comparing extracted call data (phone number, company name, location name, address, caller name) against CRM records. Because speech-to-text transcription introduces errors and callers don't always give exact names, fuzzy matching is used throughout.

The output of matching is a **tier** (1, 2, or 3) for each candidate location. The tier drives the decision to auto-create a job, create a job with a review note, or hold for manual review.

---

## Text Normalization (Before Any Comparison)

All comparisons run on normalized versions of strings. Two normalization functions handle this:

**`normalizePhone()`** — strips everything except digits.
- `"(214) 555-1234"` → `"2145551234"`

**`normalizeText()`** — lowercases, removes punctuation, collapses whitespace.
- `"Dallas Fire & Alarm, LLC"` → `"dallas fire alarm llc"`

This means "ACME Corp." and "acme corp" are identical before comparison.

---

## Fuzzy Similarity Algorithms

Two algorithms are used to score how similar two strings are, on a scale of 0.0 to 1.0.

### Token (Jaccard) Similarity

Splits each string into words and computes the ratio of shared words to total unique words.

```
tokens_a = {"dallas", "fire", "alarm"}
tokens_b = {"dallas", "alarm"}

intersection = 2, union = 3
score = 2/3 = 0.67
```

Good at matching when words are present but order or extras differ.

### Bigram (Dice) Similarity

Splits each string into 2-character substrings ("bigrams") and computes shared-bigram ratio.

```
"diversetec" → {di, iv, ve, er, rs, se, et, te, ec}
"diversatek" → {di, iv, ve, er, rs, sa, at, te, ek}

shared = 6, total = 9 + 9 = 18
score = (2 × 6) / 18 = 0.67
```

Good at catching character-level transcription errors like "Diversetec" vs "DIVERSATEK".

### `fuzzySimilarity()`

Returns `Math.max(tokenSimilarity, bigramSimilarity)` — whichever algorithm gives a higher score wins.

### Address Similarity

Addresses get special treatment:
- Exact match → 1.0
- One address contains the other as a substring → 0.9
- Otherwise → `fuzzySimilarity()`

An **address query match** is a stricter check. The system generates several search variants from a given address (with/without direction prefix, with/without street suffix, etc.) and checks for an exact-variant hit. This catches "123 N Main St" vs "123 North Main Street" without penalizing the score.

**Address match threshold:**
- When phone or location name is also available → address similarity > **0.6** is enough
- When address is the only non-phone identifier → requires > **0.75**

---

## The 15 Match Signals

For each candidate location, `determineMatchQuality()` computes 15 boolean or numeric signals:

| Signal | Type | Description |
|---|---|---|
| `phoneExact` | bool | Normalized phone numbers match |
| `locationNameExact` | bool | Normalized location names match exactly |
| `locationNameFuzzy` | 0–1 | Fuzzy score for location names |
| `companyNameExact` | bool | Normalized company names match exactly |
| `companyNameFuzzy` | 0–1 | Fuzzy score for company names |
| `companyNamePrefixMatch` | bool | First 5 characters of company name match |
| `locationNameMatchesCompany` | bool | Search location name = candidate company name |
| `locationNameMatchesCompanyFuzzy` | 0–1 | Fuzzy version of above |
| `companyNameMatchesLocation` | bool | Search company name = candidate location name |
| `addressSimilarityScore` | 0–1 | Address similarity score |
| `addressQueryMatch` | bool | Strict address variant match |
| `addressMatch` | bool | Combined address check (query match OR similarity above threshold) |
| `nameSimilarity` | 0–1 | Fuzzy score for caller's contact name |
| `locationsForCompany` | int | How many CRM locations share this company name |
| `locationsForExactPhone` | int | How many CRM locations share this exact phone number |

The **prefix match** (first 5 characters) exists specifically for speech-to-text drift where the beginning of a company name is more reliably transcribed than the end.

The **cross-field signals** (`locationNameMatchesCompany`, `companyNameMatchesLocation`) exist because callers often use the location name and company name interchangeably.

---

## Tier Assignment

Signals are combined into rules. The first rule that matches wins.

### Tier 1 — High Confidence

A job is auto-created. No human review needed.

| Rule | Signals Required |
|---|---|
| `phone_and_address_match` | `phoneExact` + `addressMatch` |
| `location_name_and_address_match` | `locationNameExact` + `addressMatch` |
| `location_as_company_and_address_match` | `locationNameMatchesCompany` + `addressMatch` |
| `phone_match_single_location` | `phoneExact` + only 1 location has that phone |
| `company_location_and_address_exact` | All three of company, location, address exact |
| `company_fuzzy_location_and_address_match` | `companyNameFuzzy > 0.95` + location + address |
| `company_prefix_location_and_address_match` | `companyNamePrefixMatch` + location + address |
| `location_and_company_exact` | Both location and company exact (no address needed) |
| `location_as_company_single_location` | `locationNameMatchesCompany` + only 1 such location |
| `phone_match_with_address_similarity` | `phoneExact` + `addressSimilarity > 0.5` |

> **Note:** Company + Address alone (without location name) was intentionally moved to Tier 2. Speech-to-text errors like "Uptown" vs "Intown" are too risky without a third corroborating signal.

### Tier 2 — Medium Confidence

A job is created **only if all Tier 2 candidates point to the same location**. If they point to different locations, the call is flagged for manual review. A note is added to created jobs indicating they need a review.

| Rule | Signals Required |
|---|---|
| `phone_match_multiple_locations` | `phoneExact` but phone maps to 2+ locations |
| `address_query_match` | `addressQueryMatch` alone |
| `company_and_address_exact_no_location` | Company exact + address, no location name |
| `company_fuzzy_and_address_no_location` | `companyNameFuzzy > 0.9` + address |
| `company_prefix_and_address_no_location` | Prefix match + address |
| `location_name_exact` | Location name exact, nothing else |
| `location_name_matches_company` | `locationNameMatchesCompany` alone |
| `company_name_matches_location` | `companyNameMatchesLocation` alone |
| `company_match_single_location` | Company exact + only 1 location for that company |
| `company_fuzzy_and_address` | `companyNameFuzzy > 0.6` + address |
| `location_fuzzy_and_address` | `locationNameFuzzy > 0.8` + address |
| `company_and_location_fuzzy` | Both company and location fuzzy > 0.8 |

### Tier 3 — Low Confidence

No job is created. Flagged for manual review with the top 3 candidates listed.

Catches weak matches like:
- Company name exact but nothing else
- Location fuzzy > 0.7 but no corroborating signals
- Address match but no name or phone support

If no signals match at all → `no_strong_match` (still Tier 3).

---

## Candidate Sorting

When multiple candidates are returned, they are sorted:

1. Tier ascending (Tier 1 first)
2. Within Tier 1: phone+address match above phone-only
3. `addressSimilarity` descending
4. `locationSimilarity` descending
5. `companySimilarity` descending
6. `phoneExact` descending

The top-ranked Tier 1 candidate (if any) is selected for job creation.

---

## Address Direct-Hit Narrowing

If an address search returns 2+ direct CRM hits, the system checks which of those candidates also have a matching name (exact location name, company name, or cross-field match). If exactly one does, all others are discarded. This prevents a strong phone match at the wrong address from winning.

---

## Cross-Validation Gate

Even a Tier 1 candidate passes through a final sanity check before a job is created.

If the caller provided any of address, company name, or location name, **at least one must agree** with the selected candidate:

| Field | Passing Condition |
|---|---|
| Address | `addressMatch` OR `addressSimilarity >= 0.75` |
| Company | `companyNameExact` OR `locationNameMatchesCompany` OR `companySimilarity >= 0.6` |
| Location | `locationNameExact` OR `companyNameMatchesLocation` OR `locationSimilarity >= 0.75` |

Additionally, if the matched phone maps to multiple locations **and** the caller provided other identifiers that don't match, the candidate is rejected as `ambiguous_phone_mapping`.

On failure, no job is created and the call is flagged for manual review with reason `retell_data_mismatch` or `ambiguous_phone_mapping`.

---

## Decision Tree (After Matching)

```
findCustomerWithConfidence() returns ranked candidates
           │
           ▼
    Any Tier 1 candidates?
    ├─ YES → take tier1[0] → cross-validation
    │         ├─ Pass → CREATE JOB
    │         └─ Fail → REVIEW FLAG (retell_data_mismatch)
    │
    └─ NO → Any Tier 2 candidates?
             ├─ YES → all point to same location?
             │         ├─ YES (1 unique location) → CREATE JOB + review note
             │         └─ NO (multiple locations) → REVIEW FLAG (multiple_medium_confidence_matches)
             │
             └─ NO → Any Tier 3 candidates?
                      ├─ YES → REVIEW FLAG (low_confidence_matches)
                      └─ NO  → REVIEW FLAG (no_matches)
```

---

## Review Flags (Reason Codes)

| Reason Code | What Happened |
|---|---|
| `no_matches` | No candidates found at all |
| `low_confidence_matches` | Only Tier 3 weak matches found |
| `multiple_medium_confidence_matches` | Tier 2 candidates point to different locations |
| `retell_data_mismatch` | Selected candidate failed cross-validation |
| `ambiguous_phone_mapping` | Phone maps to multiple locations with no tiebreaker |
| `emergency_jobs_disabled` | Call was an emergency but config disables auto-creation |
| `web_call_excluded` | Call type is `web_call`, excluded by design |
| `internal_error` | Unhandled exception during processing |

---

## Email Notifications

Two email templates are sent based on outcome.

### Job Created Email

- Subject: `New Service Request Logged - {Name} | {Type}`
- Contains: caller info, matched location, issue summary, job number, link to job
- Sent only when `settings.send_job_email = true`

### Manual Review Email

- Subject: `Service Request Needs Review - {Name} | {Type}`
- Contains:
  - Caller info and reported issue
  - **Reason code** (human-readable label + system message)
  - **Top 3 candidates** with location name, company, address, and the tier reason that was assigned
  - **Validation summary** if the call passed matching but failed cross-validation
- Sent when `settings.send_job_email = true` AND `settings.send_job_fail_email = true`

Recipients are configured per-agent in the database (`settings.emailto`, `settings.ccmail`).

---

## All Fuzzy Thresholds at a Glance

| Value | Usage |
|---|---|
| > 0.95 | Company fuzzy → Tier 1 (with location + address) |
| > 0.9 | Company fuzzy → Tier 2 (with address, no location) |
| > 0.8 | Location fuzzy → Tier 2 (with address); also company + location both fuzzy → Tier 2 |
| > 0.75 | Address strict threshold (address-only calls); cross-validation address/location |
| > 0.7 | Minimum location or company fuzzy for Tier 3 (not discarded) |
| > 0.6 | Company fuzzy → Tier 2 (with address); address lenient threshold; name similarity flag; cross-validation company |
| > 0.5 | Address similarity → Tier 1 when combined with phone |
| first 5 chars | Prefix match length for company name (catches STT drift) |

---

## Key Source Files

| File | Purpose |
|---|---|
| [customerMatchingService.js](voiceagent-st-webhook/src/services/customerMatchingService.js) | Fuzzy algorithms, signal computation, tier assignment, candidate sorting |
| [retell.js](voiceagent-st-webhook/src/controllers/retell.js) | Webhook handler, candidate selection, cross-validation, job creation decision |
| [emailNotificationService.js](voiceagent-st-webhook/src/services/emailNotificationService.js) | Review and confirmation email composition and sending |
| [environment.js](voiceagent-st-webhook/src/config/environment.js) | Threshold config (currently hard-coded in service layer) |
