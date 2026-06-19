# Email Notification Service

This document covers the complete flow from a webhook event to a sent email — how the email is triggered, what data is assembled, how the email is composed, and what the recipient actually sees.

---

## Overview

The email notification service is a singleton (`emailNotificationService.js`) that wraps SendGrid. It is called at the end of every webhook processing run in `retell.js`, regardless of whether a job was created or not. There are two email types:

| Email Type | When Sent | Badge |
|---|---|---|
| **Job Created** | Tier 1 match → job successfully created in ServiceTrade | `Emergency Job Created` or `Service Request Logged` |
| **Manual Review** | Any failure path: no match, low confidence, validation fail, config block, error | `Manual Review Needed` |

---

## Step 1 — Gate Checks (Before Anything Is Sent)

`sendJobNotification()` runs three checks in order. If any fail without an `overrideTo`, the email is skipped immediately.

```
1. isConfigured?
   → Requires SENDGRID_API_KEY in environment
   → Returns: { sent: false, reason: 'sendgrid_not_configured' }

2. isNotificationEnabled(settings, outcome)?
   → Requires settings.send_job_email = true (any of: true, 1, "yes", "y")
   → For 'job_not_created' outcome: ALSO requires settings.send_job_fail_email = true
   → Returns: { sent: false, reason: 'notifications_disabled' }

3. Recipients resolved?
   → settings.emailto must parse to at least one address
   → Returns: { sent: false, reason: 'no_recipients' }
```

`settings` here is the per-agent database row. Each agent independently controls whether job-created emails and/or failure emails are sent.

`overrideTo` bypasses the settings gate entirely — used for internal/test sends.

---

## Step 2 — Building `notificationBase` (The Shared Context)

Before any email-related code runs, `retell.js` builds a base context object at line 780:

```javascript
notificationBase = buildNotificationContext({
    call,           // raw Retell call object
    callId,
    agentId,
    callerName,
    callerPhone,
    serviceAddress, // addressForMatching || rawAddress
    locationName,
    companyName,
    issueDescription,
    callSummary,
    emergencyType,
    isEmergencyFlag,
    serviceLineId
});
```

This produces the shape that every email is built from:

| Field | Source |
|---|---|
| `callId` / `agentId` | Passed through |
| `customerName` | `callerName` or `"Unknown Caller"` |
| `callerPhone` | `callerPhone` → fallback to `call.from_number` → `"Not provided"` |
| `serviceAddress` | `addressForMatching || rawAddress || "Not provided"` |
| `locationName` / `companyName` | Extracted from call or null |
| `issueDescription` | `issueDescription || callSummary || "Service request from call"` |
| `priority` | `"Emergency"` if `isEmergencyFlag === true`, else `"Non-Emergency"` |
| `timestamp` | `call.start_timestamp` or `Date.now()` |

---

## Step 3 — Trigger Points in retell.js

Every exit path from `processCallAnalyzed()` calls `sendNotification({ outcome, details })`. The details object is merged on top of `notificationBase` before sending.

### Path A — `web_call` excluded

```javascript
sendNotification({
    outcome: 'job_not_created',
    details: {
        reasonCode: 'web_call_excluded',
        reasonMessage: 'Job creation skipped for web_call',
        callerPhone: ...
    }
})
```

### Path B — Emergency jobs disabled by config

```javascript
sendNotification({
    outcome: 'job_not_created',
    details: {
        reasonCode: 'emergency_jobs_disabled',
        reasonMessage: 'Job not created because call is marked as emergency...'
    }
})
```

### Path C — No matches found

```javascript
sendNotification({
    outcome: 'job_not_created',
    details: {
        reasonCode: 'no_matches',
        reasonMessage: 'No matching locations found in ServiceTrade'
    }
})
```

### Path D — Multiple medium-confidence matches (Tier 2, different locations)

```javascript
sendNotification({
    outcome: 'job_not_created',
    details: {
        reasonCode: 'multiple_medium_confidence_matches',
        reasonMessage: 'Multiple possible locations found',
        topCandidates: tier2Candidates.slice(0, 3)  // [{locationId, locationName, companyName, tierReason}]
    }
})
```

### Path E — Low confidence only (Tier 3)

```javascript
sendNotification({
    outcome: 'job_not_created',
    details: {
        reasonCode: 'low_confidence_matches',
        reasonMessage: 'Only weak matches found',
        topCandidates: tier3Candidates.slice(0, 3)
    }
})
```

### Path F — Cross-validation failed

```javascript
sendNotification({
    outcome: 'job_not_created',
    details: {
        reasonCode: candidateValidation.reason,    // 'retell_data_mismatch' | 'ambiguous_phone_mapping'
        reasonMessage: 'Selected location does not sufficiently match call data',
        locationName: selectedCandidate.locationName,
        companyName: selectedCandidate.companyName,
        serviceAddress: selectedCandidate.address,
        validationSummary: buildValidationSummary(candidateValidation)
        // e.g. "addressMatches=false, companyMatches=true, locationMatches=false, phoneMatches=true, locationsForExactPhone=3"
    }
})
```

### Path G — Job created successfully

```javascript
sendNotification({
    outcome: 'job_created',
    details: {
        callerPhone: matchedPhone || callerPhone,
        locationName: selectedCandidate.locationName,
        companyName: selectedCandidate.companyName,
        serviceAddress: selectedCandidate.address,
        jobId: jobResult?.jobId,
        jobUri: jobResult?.jobUri,
        jobNumber: jobResult?.jobNumber,
        matchTier,
        tierReason: selectedCandidate.tierReason
    }
})
```

### Path H — Unhandled exception

```javascript
sendNotification({
    outcome: 'job_not_created',
    details: {
        reasonCode: 'internal_error',
        reasonMessage: error.message || 'Webhook error'
    }
})
```

---

## Step 4 — Details Normalization

Inside `sendJobNotification()`, the merged details object is normalized before being passed to email composition:

```javascript
const normalizedDetails = {
    ...details,
    customerName:       details.customerName || 'Unknown Caller',
    callerPhone:        details.callerPhone  || 'Not provided',
    serviceAddress:     formatAddress(details.serviceAddress),   // handles string or {street,city,state,zip} object
    emergencyType:      inferEmergencyType(details),             // see below
    priority:           details.priority || 'Non-Emergency',
    timestampCentral:   formatTimestampCentral(details.timestamp), // Central Time, human-readable
    reasonLabel:        details.reasonLabel || toTitleCase(details.reasonCode || 'manual_review_required'),
    reasonMessage:      details.reasonMessage || 'Manual review required before dispatch',
    topCandidatesText:  formatCandidateList(details.topCandidates),  // formatted string
    validationSummary:  details.validationSummary || null
};
```

### `inferEmergencyType()` — How the email subject type is determined

Resolves in priority order:

1. `details.emergencyType` or `details.issueType` (explicit)
2. `details.serviceLineId` → `1 = "Fire Alarm"`, `5 = "Sprinkler"`
3. Keyword scan across `issueDescription`, `callSummary`, `locationName`, `companyName`:
   - Contains "sprinkler" → `"Sprinkler"`
   - Contains "alarm" → `"Alarm"`
   - Contains "fire" → `"Fire Emergency"`
   - `details.priority === 'Emergency'` → `"Emergency Dispatch"`
4. Fallback → `"Service Request"`

### `formatCandidateList()` — How top candidates are formatted

Each candidate (up to 3) renders as one pipe-delimited line:

```
1. Dallas Fire Protection | Company: Acme Inc | Address: 123 Main St | Reason: phone_and_address_match
2. Dallas Alarm Services | Company: Acme Inc | Address: 456 Oak Ave | Reason: location_name_exact
```

If no candidates → `"Not available"` (and the field is omitted from the email body).

### `buildValidationSummary()` — For failed cross-validations

Produces a compact status string:

```
addressMatches=false, companyMatches=true, locationMatches=false, phoneMatches=true, locationsForExactPhone=3
```

---

## Step 5 — Email Composition

The normalized details flow into one of two compose functions.

### `composeJobCreatedEmail()`

**Subject:** `New Service Request Logged - {customerName} | {emergencyType}`

**Badge:** `Emergency Job Created` (if `priority === 'Emergency'`) or `Service Request Logged`

**Cards rendered (in order):**

| Card | Fields |
|---|---|
| Caller Details | Name, Phone |
| Service Location | Address, Location Name, Company |
| Call Summary | Type, Priority, Issue |
| Action Taken | "Job created in ServiceTrade", Job Number (monospace), Call Time (Central) |

**CTA button:** "Open ServiceTrade Job" → links to the ServiceTrade job URL

**Job link resolution (`buildServiceTradeJobLink`):**
1. `details.jobLink` (direct, cleaned up)
2. `details.jobUri` (cleaned up — strips `/api/job/` → `/job/`)
3. `authData.job_url_template` with `{{jobId}}` or `{jobId}` substituted
4. `authData.app_url`
5. `authData.portal_url`
6. Fallback: `https://app.servicetrade.com/auth`

**Footer:** `Expected callback: Within 10 minutes`

---

### `composeJobNotCreatedEmail()`

**Subject:** `Service Request Needs Review - {customerName} | {emergencyType}`

**Badge:** `Manual Review Needed`

**No CTA button** (no job was created, so no link).

**Cards rendered (in order):**

| Card | Fields |
|---|---|
| Caller Details | Name, Phone |
| Service Location | Address, Location Name, Company |
| Call Summary | Type, Priority, Issue |
| Action Taken | "Job was not created", Reason (human label), System Message, Top Candidates (if any), Validation Details (if failed cross-validation), Call Time |

**Footer:** `Expected callback: Manual review needed`

---

## Step 6 — Email Assembly and Sending

The final SendGrid message is assembled with:

```javascript
{
    to:   parseEmailList(settings.emailto),   // comma or semicolon separated list in DB
    cc:   parseEmailList(settings.ccmail),    // optional CC list
    from: {
        email: config.notificationEmailFrom,
        name:  config.notificationEmailFromName
    },
    subject: message.subject,
    text:    message.text,    // plain-text fallback
    html:    message.html,    // full HTML email
    customArgs: {
        outcome: 'job_created' | 'job_not_created',
        callId:  '...',
        agentId: '...'
    }
}
```

`parseEmailList()` accepts a string (comma or semicolon delimited), an array, or null. It deduplicates and trims all entries.

Both `text` and `html` versions are always built and sent. The text version is a plain-text fallback with the same sections, and the HTML version is a fully styled card layout.

---

## Step 7 — Return Value and Logging

On success:
```javascript
{ sent: true, to: [...], cc: [...], subject: '...', jobLink: '...' | null }
```

On skip:
```javascript
{ sent: false, skipped: true, reason: 'notifications_disabled' | 'sendgrid_not_configured' | 'no_recipients' }
```

`retell.js` logs `'Notification email sent'` with recipients on success, or `'Notification email skipped'` with the reason on skip. SendGrid failures are caught and logged as `'Failed to send notification email'` — they do not propagate or affect the webhook response.

---

## Complete Flow Diagram

```
processCallAnalyzed() [retell.js]
    │
    ├─ Build notificationBase (callerName, phone, address, issue, priority, timestamp)
    │
    ├─ [matching + job creation logic runs]
    │
    └─ sendNotification({ outcome, details })
             │
             ▼
         merge: { ...notificationBase, authData, ...details }
             │
             ▼
    emailNotificationService.sendJobNotification()
             │
             ├─ Gate 1: SendGrid configured?    → NO → skip (sendgrid_not_configured)
             ├─ Gate 2: settings allow email?   → NO → skip (notifications_disabled)
             │          send_job_email must be true
             │          send_job_fail_email must ALSO be true for 'job_not_created'
             └─ Gate 3: recipients resolved?    → NO → skip (no_recipients)
                         parseEmailList(settings.emailto)
                              │
                              ▼
                    normalizeDetails()
                    ├─ formatAddress()
                    ├─ inferEmergencyType()     → keyword scan → serviceLineId → fallback
                    ├─ formatTimestampCentral() → Central Time string
                    ├─ toTitleCase(reasonCode)  → human-readable reason label
                    └─ formatCandidateList()    → pipe-delimited candidate lines
                              │
                              ▼
              outcome === 'job_created' ?
              ├─ YES → composeJobCreatedEmail()
              │        subject: "New Service Request Logged - {name} | {type}"
              │        badge: "Emergency Job Created" | "Service Request Logged"
              │        cards: Caller | Location | Call Summary | Action Taken
              │        CTA button: "Open ServiceTrade Job"  ← buildServiceTradeJobLink()
              │
              └─ NO  → composeJobNotCreatedEmail()
                       subject: "Service Request Needs Review - {name} | {type}"
                       badge: "Manual Review Needed"
                       cards: Caller | Location | Call Summary | Action Taken
                              (Action Taken includes: reason label, system message,
                               top candidates, validation summary if present)
                              │
                              ▼
                    sgMail.send({ to, cc, from, subject, text, html, customArgs })
                              │
                              ▼
                    log result → return { sent, to, cc, subject, jobLink }
```

---

## Settings Reference

| DB Column | Type | Effect |
|---|---|---|
| `emailto` | string | Primary recipients (comma or semicolon separated) |
| `ccmail` | string | CC recipients (comma or semicolon separated) |
| `send_job_email` | bool/int/string | Master switch — gates ALL emails |
| `send_job_fail_email` | bool/int/string | Additional gate for `job_not_created` emails only |
| `auth_data.job_url_template` | string | Template for job links, e.g. `https://app.servicetrade.com/job/{{jobId}}` |

`normalizeBoolean()` accepts `true/false`, `1/0`, `"true"/"false"`, `"yes"/"no"`, `"y"/"n"` — anything else is treated as `false`.

---

## Key Source Files

| File | Purpose |
|---|---|
| [emailNotificationService.js](voiceagent-st-webhook/src/services/emailNotificationService.js) | All email composition and sending logic |
| [retell.js](voiceagent-st-webhook/src/routes/webhook/retell.js) | `buildNotificationContext()` (line 136), `sendNotification()` (line 307), all trigger call sites |
