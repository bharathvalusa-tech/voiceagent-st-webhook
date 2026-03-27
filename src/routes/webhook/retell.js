// @ts-nocheck
const config = require('../../config/environment');
const express = require('express');
const { waitUntil } = require('@vercel/functions');
const retellService = require('../../services/retellService');
const { validateAddress, buildAddressQuery } = require('../../services/googleMapsService');
const { findCustomerWithConfidence } = require('../../services/customerMatchingService');
const { createJob } = require('../../controllers/serviceTradeController');
const emailNotificationService = require('../../services/emailNotificationService');
const supabaseService = require('../../services/supabaseService');
const router = express.Router();

const processedCalls = new Map();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

const cleanupProcessedCalls = () => {
    const now = Date.now();
    for (const [key, ts] of processedCalls) {
        if (now - ts > IDEMPOTENCY_TTL_MS) processedCalls.delete(key);
    }
};
setInterval(cleanupProcessedCalls, 60 * 1000).unref();

const forwardToApiGateway = async (rawBodyStr, parsedBody, signatureHeader) => {
    const apiGatewayUrl = process.env.API_GATEWAY_URL;
    if (!apiGatewayUrl) return;

    const eventType = parsedBody?.event || parsedBody?.event_type || '';

    // Only forward call_started, call_ended, and call_analyzed events
    if (eventType !== 'call_started' && eventType !== 'call_ended' && eventType !== 'call_analyzed') return;

    // Use the raw body string so the x-retell-signature HMAC remains valid
    // on the receiving Lambda (it verifies against the normalized original payload)
    const bodyStr = rawBodyStr || JSON.stringify(parsedBody);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(apiGatewayUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-retell-signature': signatureHeader || ''
            },
            body: bodyStr,
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        console.log(`[API_GATEWAY] Forwarded ${eventType} event, status: ${response.status}`);
    } catch (error) {
        // Swallow errors — forward failures must never block the main webhook response
        console.error(`[API_GATEWAY] Error forwarding webhook: ${error.message}`);
    }
};

const extractPayload = (body) => {
    const eventType = body.event || body.event_type || body.type || body.webhook_event;
    const call = body.call || body.data?.call || body.data || body;
    const analysis = body.call_analysis || body.analysis || body.data?.call_analysis || body.data?.analysis || call?.call_analysis || {};
    const extracted =
        analysis.custom_analysis_data ||
        analysis.extracted_data ||
        analysis.call_analyzed_data ||
        analysis;
    const dynamicVars = body.collected_dynamic_variables || call?.collected_dynamic_variables || {};

    return { eventType, call, analysis, extracted, dynamicVars };
};

const logWithContext = (level, message, context = {}) => {
    const payload = {
        level,
        message,
        ...context
    };
    if (level === 'error') {
        console.error(JSON.stringify(payload));
    } else {
        console.log(JSON.stringify(payload));
    }
};

const buildJobDescription = (issueDescription, callerName, callerPhone, currentNode) => {
    const name = (callerName || '').trim() || 'Unknown person';
    const phone = (callerPhone || '').trim() || null;
    const namePart = phone ? `${name} (${phone})` : name;

    const isOfficeHours = currentNode &&
        currentNode.toLowerCase().includes('office') &&
        !currentNode.toLowerCase().includes('after');
    const prefix = isOfficeHours ? '[OFFICE HOURS]' : '[AFTER HOURS]';

    const rawDescription = (issueDescription || '').trim();
    if (!rawDescription) {
        return `${prefix}: ${namePart} reported an issue.`;
    }

    const replaced = callerName
        ? rawDescription.replace(/\b(caller|customer)\b/gi, name)
        : rawDescription;

    return `${prefix}: ${namePart} reported ${replaced}`;
};

const normalizeBool = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', 'yes', 'y', '1'].includes(normalized)) return true;
        if (['false', 'no', 'n', '0'].includes(normalized)) return false;
    }
    return null;
};

const buildNotificationContext = ({
    call,
    callId,
    agentId,
    callerName,
    callerPhone,
    serviceAddress,
    locationName,
    companyName,
    issueDescription,
    callSummary,
    emergencyType,
    isEmergencyFlag,
    serviceLineId
}) => ({
    callId,
    agentId,
    customerName: callerName || 'Unknown Caller',
    callerPhone: callerPhone || call?.from_number || call?.fromNumber || 'Not provided',
    serviceAddress: serviceAddress || 'Not provided',
    locationName: locationName || null,
    companyName: companyName || null,
    issueDescription: issueDescription || callSummary || 'Service request from call',
    callSummary: callSummary || issueDescription || null,
    emergencyType: emergencyType || null,
    priority: isEmergencyFlag ? 'Emergency' : 'Non-Emergency',
    serviceLineId: serviceLineId || null,
    timestamp: call?.start_timestamp || Date.now()
});

const buildValidationSummary = (validation) => {
    if (!validation || !validation.checks) return null;

    const checks = validation.checks;
    return [
        `addressMatches=${Boolean(checks.addressMatches)}`,
        `companyMatches=${Boolean(checks.companyMatches)}`,
        `locationMatches=${Boolean(checks.locationMatches)}`,
        `phoneMatches=${Boolean(checks.phoneMatches)}`,
        `locationsForExactPhone=${checks.locationsForExactPhone || 0}`
    ].join(', ');
};

const validateCandidateAgainstRetellData = ({ candidate, searchContext }) => {
    const hasAddressInput = Boolean(searchContext.addressForMatching);
    const hasCompanyInput = Boolean(searchContext.companyName);
    const hasLocationInput = Boolean(searchContext.locationName);
    const hasPhoneInput = Boolean(searchContext.matchedPhone);

    const addressMatches = Boolean(
        candidate.addressMatch || (candidate.addressSimilarity || 0) >= 0.75
    );
    const companyMatches = Boolean(
        candidate.companyNameExact ||
        candidate.locationNameMatchesCompany ||
        (candidate.companySimilarity || 0) >= 0.6
    );
    const locationMatches = Boolean(
        candidate.locationNameExact ||
        candidate.companyNameMatchesLocation ||
        (candidate.locationSimilarity || 0) >= 0.75
    );
    const phoneMatches = Boolean(candidate.phoneExact);

    const nonPhoneChecks = [
        { field: 'address', provided: hasAddressInput, matched: addressMatches },
        { field: 'company', provided: hasCompanyInput, matched: companyMatches },
        { field: 'location', provided: hasLocationInput, matched: locationMatches }
    ].filter((check) => check.provided);
    const matchedNonPhoneChecks = nonPhoneChecks.filter((check) => check.matched);

    // If caller provided richer identifiers (address/company/location), require at least one to match.
    // This prevents phone-only associations from creating jobs at unrelated locations.
    if (nonPhoneChecks.length > 0 && matchedNonPhoneChecks.length === 0) {
        return {
            isValid: false,
            reason: 'retell_data_mismatch',
            checks: {
                addressMatches,
                companyMatches,
                locationMatches,
                phoneMatches,
                locationsForExactPhone: candidate.locationsForExactPhone || 0
            }
        };
    }

    // Additional guard: if phone maps to multiple locations, ensure at least one non-phone signal matches.
    if (
        hasPhoneInput &&
        candidate.phoneExact &&
        (candidate.locationsForExactPhone || 0) > 1 &&
        matchedNonPhoneChecks.length === 0
    ) {
        return {
            isValid: false,
            reason: 'ambiguous_phone_mapping',
            checks: {
                addressMatches,
                companyMatches,
                locationMatches,
                phoneMatches,
                locationsForExactPhone: candidate.locationsForExactPhone || 0
            }
        };
    }

    return {
        isValid: true,
        reason: 'validated',
        checks: {
            addressMatches,
            companyMatches,
            locationMatches,
            phoneMatches,
            locationsForExactPhone: candidate.locationsForExactPhone || 0
        }
    };
};

router.post('/retell', async (req, res) => {
    const signatureHeader = req.headers['x-retell-signature'] || req.headers['X-Retell-Signature'] || '';
    try {
        await forwardToApiGateway(req.rawBody || null, req.body, signatureHeader);
    } catch (fwdErr) {
        console.error(`[API_GATEWAY] Unexpected forwarding error (ignored): ${fwdErr.message}`);
    }

    const { eventType, call, analysis, extracted, dynamicVars } = extractPayload(req.body || {});

    if (eventType && eventType !== 'call_analyzed') {
        return res.status(200).json({ status: 'ignored', message: 'Event not call_analyzed' });
    }

    const agentId = call?.agent_id || extracted?.agent_id || req.body?.agent_id;
    const callId = call?.call_id || call?.id || req.body?.call_id || extracted?.call_id;

    if (!agentId) {
        logWithContext('error', 'Missing agent_id in webhook payload', { callId });
        return res.status(200).json({ status: 'error', reason: 'missing_agent_id', message: 'Missing agent_id' });
    }

    if (callId && processedCalls.has(callId)) {
        logWithContext('info', 'Duplicate call_analyzed ignored (already processed)', {
            callId,
            agentId,
            firstProcessedAt: new Date(processedCalls.get(callId)).toISOString()
        });
        return res.status(200).json({
            status: 'duplicate',
            reason: 'already_processed',
            message: `call_analyzed for ${callId} was already processed`
        });
    }

    if (callId) {
        processedCalls.set(callId, Date.now());
    }

    res.status(200).json({ status: 'accepted', callId });

    const backgroundWork = processCallAnalyzed({ req, call, analysis, extracted, dynamicVars, callId, agentId })
        .catch(err => logWithContext('error', 'Background processing failed', { callId, agentId, error: err.message, stack: err.stack }));

    waitUntil(backgroundWork);
});

async function processCallAnalyzed({ req, call, analysis, extracted, dynamicVars, callId, agentId }) {
    let serviceTradeSettings = null;
    let notificationBase = null;

    const sendNotification = async (notification) => {
        if (!serviceTradeSettings || !notificationBase || !notification?.outcome) {
            logWithContext('warn', 'sendNotification skipped - missing context', {
                callId, agentId,
                hasSettings: !!serviceTradeSettings,
                hasNotificationBase: !!notificationBase,
                outcome: notification?.outcome || null
            });
            return;
        }
        try {
            const emailResult = await emailNotificationService.sendJobNotification({
                settings: serviceTradeSettings,
                outcome: notification.outcome,
                details: {
                    ...notificationBase,
                    authData: serviceTradeSettings.auth_data || {},
                    ...notification.details
                }
            });
            if (emailResult.sent) {
                logWithContext('info', 'Notification email sent', {
                    callId, agentId, outcome: notification.outcome,
                    recipients: emailResult.to, cc: emailResult.cc
                });
            } else {
                logWithContext('warn', 'Notification email skipped', {
                    callId, agentId, outcome: notification.outcome,
                    reason: emailResult.reason || 'unknown'
                });
            }
        } catch (emailError) {
            logWithContext('error', 'Failed to send notification email', {
                callId, agentId, outcome: notification.outcome, error: emailError.message
            });
        }
    };

    try {
        const loadExtractedFields = (sourceExtracted, sourceAnalysis, sourceDynamicVars) => {
            const callerPhoneFromCall =
                call?.from_number ||
                call?.fromNumber ||
                call?.phone_number ||
                null;
            const callerPhoneFromExtracted =
                sourceExtracted?.caller_phone ||
                sourceExtracted?.phone ||
                null;
            const callerPhone = callerPhoneFromCall || callerPhoneFromExtracted || null;

            const callerName =
                sourceExtracted?.caller_name ||
                sourceExtracted?.customer_name ||
                sourceExtracted?.name ||
                sourceDynamicVars?.customerName ||
                sourceDynamicVars?.customer_name ||
                sourceDynamicVars?.callerName ||
                sourceDynamicVars?.caller_name ||
                null;

            const addressLine1 =
                sourceExtracted?.address_line1 ||
                sourceExtracted?.addressLine1 ||
                sourceExtracted?.street_address ||
                sourceExtracted?.street ||
                sourceExtracted?.address1 ||
                sourceDynamicVars?.street ||
                sourceDynamicVars?.address_line1 ||
                sourceDynamicVars?.addressLine1 ||
                null;

            const addressCity =
                sourceExtracted?.city ||
                sourceExtracted?.address_city ||
                sourceExtracted?.addressCity ||
                sourceDynamicVars?.city ||
                null;

            const addressState =
                sourceExtracted?.state ||
                sourceExtracted?.address_state ||
                sourceExtracted?.addressState ||
                sourceDynamicVars?.state ||
                null;

            const addressPostal =
                sourceExtracted?.postal_code ||
                sourceExtracted?.postalCode ||
                sourceExtracted?.zip ||
                sourceDynamicVars?.postalCode ||
                sourceDynamicVars?.postal_code ||
                null;

            const rawAddress =
                sourceExtracted?.caller_address ||
                sourceExtracted?.address ||
                sourceExtracted?.location_address ||
                sourceExtracted?.raw_input ||
                sourceExtracted?.serviceAddress ||
                sourceDynamicVars?.validated_address ||
                sourceDynamicVars?.serviceAddress ||
                sourceDynamicVars?.raw_input ||
                buildAddressQuery({
                    line1: addressLine1,
                    city: addressCity,
                    state: addressState,
                    postalCode: addressPostal
                }) ||
                null;

            const locationName =
                sourceExtracted?.location_name ||
                sourceExtracted?.business_name ||
                sourceExtracted?.location ||
                null;
            const companyName =
                sourceExtracted?.company_name ||
                sourceExtracted?.company ||
                (sourceExtracted?.business_name &&
                sourceExtracted?.business_name !== locationName
                    ? sourceExtracted?.business_name
                    : null) ||
                null;

            const issueDescription =
                sourceExtracted?.issue_description ||
                sourceAnalysis?.call_summary ||
                sourceExtracted?.callSummary ||
                sourceExtracted?.call_summary ||
                'Service request from call';

            const callSummary =
                sourceAnalysis?.call_summary ||
                sourceExtracted?.callSummary ||
                sourceExtracted?.call_summary ||
                null;

            const emergencyType =
                sourceExtracted?.emergency_type ||
                sourceExtracted?.emergencyType ||
                sourceDynamicVars?.emergency_type ||
                sourceDynamicVars?.emergencyType ||
                null;

            const callTypeRaw =
                sourceDynamicVars?.call_type ||
                sourceDynamicVars?.callType ||
                sourceExtracted?.call_type ||
                sourceExtracted?.callType ||
                sourceAnalysis?.call_type ||
                sourceAnalysis?.callType ||
                call?.call_type ||
                call?.callType ||
                null;
            const callType = typeof callTypeRaw === 'string' ? callTypeRaw.trim().toLowerCase() : null;

            // Extract technician ID(s) from collected_dynamic_variables (custom functions)
            // Look for patterns like tech1_id, tech2_id, tech_id, etc.
            let techIds = [];
            if (sourceDynamicVars && typeof sourceDynamicVars === 'object') {
                const techIdKeys = Object.keys(sourceDynamicVars).filter(
                    (key) => /^tech\d*_id$/i.test(key) || /^technician\d*_id$/i.test(key)
                );
                techIdKeys.forEach((key) => {
                    const parsed = Number(sourceDynamicVars[key]);
                    if (!Number.isNaN(parsed) && !techIds.includes(parsed)) {
                        techIds.push(parsed);
                    }
                });
            }

            // Fallback to extracted data if no tech IDs from dynamic vars
            if (techIds.length === 0) {
                const rawTechId =
                    sourceExtracted?.tech_id ||
                    sourceExtracted?.techId ||
                    sourceExtracted?.technician_id ||
                    sourceExtracted?.technicianId ||
                    null;
                const rawTechIds =
                    sourceExtracted?.tech_ids ||
                    sourceExtracted?.techIds ||
                    sourceExtracted?.technician_ids ||
                    sourceExtracted?.technicianIds ||
                    null;

                if (rawTechIds && Array.isArray(rawTechIds)) {
                    techIds = rawTechIds.map((id) => Number(id)).filter((id) => !Number.isNaN(id));
                } else if (rawTechId) {
                    const parsed = Number(rawTechId);
                    if (!Number.isNaN(parsed)) {
                        techIds = [parsed];
                    }
                }
            }

            // Extract serviceLineId from collected_dynamic_variables or extracted data
            // Maps emergency type to service line: Fire Alarm = 1, Sprinkler = 5
            let serviceLineId = null;
            const rawServiceLineId =
                sourceDynamicVars?.serviceLineId ||
                sourceExtracted?.serviceLineId ||
                sourceExtracted?.service_line_id ||
                null;
            if (rawServiceLineId) {
                const parsed = Number(rawServiceLineId);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    serviceLineId = parsed;
                }
            }

            return {
                callerPhone,
                callerPhoneFallback: callerPhoneFromExtracted,
                callerName,
                addressLine1,
                addressCity,
                addressState,
                addressPostal,
                rawAddress,
                locationName,
                companyName,
                issueDescription,
                callSummary,
                emergencyType,
                callType,
                techIds,
                serviceLineId
            };
        };

        let resolvedExtracted = extracted || {};
        let resolvedAnalysis = analysis || {};
        let resolvedDynamicVars = dynamicVars || {};
        let extractedFields = loadExtractedFields(resolvedExtracted, resolvedAnalysis, resolvedDynamicVars);

        const needsRetellFetch =
            !extractedFields.callerPhone ||
            !extractedFields.callerName ||
            !extractedFields.rawAddress;

        if (needsRetellFetch && callId) {
            try {
                const callDetails = await retellService.getCall(callId);
                const fallbackAnalysis = callDetails?.call_analysis || {};
                let fallbackExtracted =
                    fallbackAnalysis.custom_analysis_data ||
                    fallbackAnalysis.extracted_data ||
                    fallbackAnalysis.call_analyzed_data ||
                    fallbackAnalysis ||
                    {};

                if (typeof fallbackExtracted === 'string') {
                    try {
                        fallbackExtracted = JSON.parse(fallbackExtracted);
                    } catch (parseError) {
                        // keep as string if parsing fails
                    }
                }

                if (fallbackExtracted && typeof fallbackExtracted === 'object' && fallbackExtracted['caller data']) {
                    try {
                        const parsed = JSON.parse(fallbackExtracted['caller data']);
                        fallbackExtracted = { ...fallbackExtracted, ...parsed };
                    } catch (parseError) {
                        // ignore parse errors for custom blob
                    }
                }

                resolvedAnalysis = fallbackAnalysis;
                resolvedExtracted = { ...fallbackExtracted, ...resolvedExtracted };
                // Also get collected_dynamic_variables from Retell API (contains custom function data like tech IDs)
                const fallbackDynamicVars = callDetails?.collected_dynamic_variables || {};
                resolvedDynamicVars = { ...fallbackDynamicVars, ...resolvedDynamicVars };
                extractedFields = loadExtractedFields(resolvedExtracted, resolvedAnalysis, resolvedDynamicVars);

                logWithContext('info', 'Loaded extracted fields via Retell API fallback', {
                    callId,
                    agentId,
                    hasDynamicVars: Object.keys(resolvedDynamicVars).length > 0
                });
            } catch (error) {
                logWithContext('error', 'Retell API fallback failed', {
                    callId,
                    agentId,
                    error: error.message
                });
            }
        }

        const {
            callerPhone,
            callerName,
            callerPhoneFallback,
            addressLine1,
            addressCity,
            addressState,
            addressPostal,
            rawAddress,
            locationName,
            companyName,
            issueDescription,
            callSummary,
            emergencyType,
            callType,
            techIds,
            serviceLineId
        } = extractedFields;

        if (callType === 'web_call') {
            logWithContext('info', 'Skipping job creation for web_call', {
                callId,
                agentId,
                callType
            });
            return await sendNotification({
                outcome: 'job_not_created',
                details: {
                    reasonCode: 'web_call_excluded',
                    reasonMessage: 'Job creation skipped for web_call',
                    callerPhone: callerPhone || callerPhoneFallback || call?.from_number || call?.fromNumber || null
                }
            });
        }

        if (techIds.length > 0) {
            logWithContext('info', 'Extracted technician IDs from call', {
                callId,
                agentId,
                techIds,
                source: Object.keys(resolvedDynamicVars).length > 0 ? 'collected_dynamic_variables' : 'extracted_data'
            });
        }

        if (serviceLineId) {
            logWithContext('info', 'Extracted serviceLineId from call', {
                callId,
                agentId,
                serviceLineId,
                source: Object.keys(resolvedDynamicVars).length > 0 ? 'collected_dynamic_variables' : 'extracted_data'
            });
        }

        // Try to validate address, but don't block if it fails
        let validatedAddress = null;
        let addressForMatching = null;

        if (rawAddress) {
            try {
                validatedAddress = await validateAddress({
                    line1: addressLine1 || rawAddress,
                    city: addressCity,
                    state: addressState,
                    postalCode: addressPostal
                });
                
                if (validatedAddress) {
                    addressForMatching = [
                        validatedAddress.street,
                        validatedAddress.city,
                        validatedAddress.state,
                        validatedAddress.postalCode
                    ].filter(Boolean).join(', ');
                    
                    logWithContext('info', 'Address validated successfully', {
                        callId,
                        agentId,
                        validatedAddress: addressForMatching
                    });
                } else {
                    // Validation failed, use raw address for matching
                    addressForMatching = rawAddress;
                    logWithContext('warn', 'Address validation failed, using raw address for matching', {
                        callId,
                        agentId,
                        rawAddress
                    });
                }
            } catch (error) {
                // Validation error, use raw address for matching
                addressForMatching = rawAddress;
                logWithContext('warn', 'Address validation error, using raw address for matching', {
                    callId,
                    agentId,
                    rawAddress,
                    error: error.message
                });
            }
        } else {
            logWithContext('warn', 'No address provided, will match by phone/location/company only', {
                callId,
                agentId,
                callerPhone,
                locationName,
                companyName
            });
        }

        const tokenData = await supabaseService.getServiceTradeToken(agentId);
        if (!tokenData || tokenData.length === 0) {
            logWithContext('error', 'No ServiceTrade token found', {
                callId,
                agentId
            });
            return;
        }

        serviceTradeSettings = tokenData[0];

        // Load job configuration (including emergency behavior)
        const jobConfig = await supabaseService.getJobConfig(agentId);
        const createEmergencyJobs =
            jobConfig && typeof jobConfig.create_emergency_jobs === 'boolean'
                ? jobConfig.create_emergency_jobs
                : true;

        // Determine if this call is marked as an emergency.
        // We look in dynamic variables first (highest priority), then extracted data, then analysis.
        const emergencySources = [
            resolvedDynamicVars?.isEmergency ?? resolvedDynamicVars?.is_emergency ?? resolvedDynamicVars?.isitEmergency,
            resolvedExtracted?.isEmergency ?? resolvedExtracted?.is_emergency ?? resolvedExtracted?.isitEmergency,
            resolvedAnalysis?.isEmergency ?? resolvedAnalysis?.is_emergency ?? resolvedAnalysis?.isitEmergency
        ];

        let isEmergencyFlag = null;
        for (const sourceVal of emergencySources) {
            const normalized = normalizeBool(sourceVal);
            if (normalized !== null) {
                isEmergencyFlag = normalized;
                break;
            }
        }

        notificationBase = buildNotificationContext({
            call,
            callId,
            agentId,
            callerName,
            callerPhone,
            serviceAddress: addressForMatching || rawAddress,
            locationName,
            companyName,
            issueDescription,
            callSummary,
            emergencyType,
            isEmergencyFlag,
            serviceLineId
        });

        // If the call is explicitly marked as emergency and config forbids creating emergency jobs,
        // we skip job creation entirely. If Retell doesn't send any emergency flag at all,
        // or sends it as false, we proceed as normal.
        if (isEmergencyFlag === true && !createEmergencyJobs) {
            logWithContext('info', 'Emergency job creation skipped due to configuration', {
                callId,
                agentId,
                createEmergencyJobs,
                emergencyFlagSourcePresent: true
            });

            return await sendNotification({
                outcome: 'job_not_created',
                details: {
                    reasonCode: 'emergency_jobs_disabled',
                    reasonMessage: 'Job not created because call is marked as emergency and emergency jobs are disabled in configuration'
                }
            });
        }

        const authToken = serviceTradeSettings.auth_token;

        const buildSearchData = (phone) => {
            return {
                phone,
                name: callerName,
                locationName,
                companyName,
                address: addressForMatching
            };
        };

        let matchedPhone = callerPhone;
        let candidates = await findCustomerWithConfidence(authToken, buildSearchData(callerPhone));

        // Try fallback phone if primary phone didn't yield tier 1 or tier 2 matches
        const hasTier1or2 = candidates.some(c => c.tier === 1 || c.tier === 2);
        const shouldTryFallbackPhone =
            callerPhoneFallback &&
            callerPhoneFallback !== callerPhone &&
            !hasTier1or2;

        if (shouldTryFallbackPhone) {
            const fallbackCandidates = await findCustomerWithConfidence(
                authToken,
                buildSearchData(callerPhoneFallback)
            );
            const fallbackHasTier1or2 = fallbackCandidates.some(c => c.tier === 1 || c.tier === 2);
            
            if (fallbackHasTier1or2) {
                candidates = fallbackCandidates;
                matchedPhone = callerPhoneFallback;
                logWithContext('info', 'Using fallback phone for better match', {
                    callId,
                    agentId,
                    fallbackPhone: callerPhoneFallback
                });
            }
        }

        // No candidates at all
        if (candidates.length === 0) {
            logWithContext('error', 'No matching locations found', {
                callId,
                agentId,
                callerPhone: matchedPhone,
                callerName,
                locationName,
                companyName,
                address: addressForMatching
            });
            return await sendNotification({
                outcome: 'job_not_created',
                details: {
                    callerPhone: matchedPhone || callerPhone,
                    reasonCode: 'no_matches',
                    reasonMessage: 'No matching locations found in ServiceTrade'
                }
            });
        }

        // Separate candidates by tier
        const tier1Candidates = candidates.filter(c => c.tier === 1 && c.locationId);
        const tier2Candidates = candidates.filter(c => c.tier === 2 && c.locationId);
        const tier3Candidates = candidates.filter(c => c.tier === 3 && c.locationId);

        let selectedCandidate = null;
        let matchTier = null;

        // Tier 1: High confidence - auto-create
        if (tier1Candidates.length > 0) {
            selectedCandidate = tier1Candidates[0];
            matchTier = 1;
            
            logWithContext('info', 'Tier 1 match found - high confidence', {
                callId,
                agentId,
                locationId: selectedCandidate.locationId,
                locationName: selectedCandidate.locationName,
                tierReason: selectedCandidate.tierReason,
                tier1Count: tier1Candidates.length
            });
        }
        // Tier 2: Medium confidence - create with note
        else if (tier2Candidates.length > 0) {
            // Check if all tier 2 candidates point to the same location
            const uniqueLocationIds = [...new Set(tier2Candidates.map(c => c.locationId))];
            
            if (uniqueLocationIds.length === 1) {
                selectedCandidate = tier2Candidates[0];
                matchTier = 2;
                
                logWithContext('info', 'Tier 2 match found - medium confidence, single location', {
                    callId,
                    agentId,
                    locationId: selectedCandidate.locationId,
                    locationName: selectedCandidate.locationName,
                    tierReason: selectedCandidate.tierReason,
                    tier2Count: tier2Candidates.length
                });
            } else {
                // Multiple different locations in tier 2 - needs review
                logWithContext('warn', 'Multiple tier 2 locations found - manual review needed', {
                    callId,
                    agentId,
                    tier2Count: tier2Candidates.length,
                    locationIds: uniqueLocationIds,
                    topCandidates: tier2Candidates.slice(0, 3).map(c => ({
                        locationId: c.locationId,
                        locationName: c.locationName,
                        companyName: c.companyName,
                        tierReason: c.tierReason
                    }))
                });
                
                return await sendNotification({
                    outcome: 'job_not_created',
                    details: {
                        callerPhone: matchedPhone || callerPhone,
                        reasonCode: 'multiple_medium_confidence_matches',
                        reasonMessage: 'Multiple possible locations found',
                        topCandidates: tier2Candidates.slice(0, 3)
                    }
                });
            }
        }
        // Tier 3: Low confidence - needs review
        else {
            logWithContext('warn', 'Only tier 3 matches found - manual review needed', {
                callId,
                agentId,
                tier3Count: tier3Candidates.length,
                topCandidates: tier3Candidates.slice(0, 3).map(c => ({
                    locationId: c.locationId,
                    locationName: c.locationName,
                    companyName: c.companyName,
                    tierReason: c.tierReason
                }))
            });
            
            return await sendNotification({
                outcome: 'job_not_created',
                details: {
                    callerPhone: matchedPhone || callerPhone,
                    reasonCode: 'low_confidence_matches',
                    reasonMessage: 'Only weak matches found',
                    topCandidates: tier3Candidates.slice(0, 3)
                }
            });
        }

        const candidateValidation = validateCandidateAgainstRetellData({
            candidate: selectedCandidate,
            searchContext: {
                matchedPhone,
                addressForMatching,
                companyName,
                locationName
            }
        });
        if (!candidateValidation.isValid) {
            logWithContext('warn', 'Selected candidate failed Retell data validation', {
                callId,
                agentId,
                locationId: selectedCandidate.locationId,
                locationName: selectedCandidate.locationName,
                tierReason: selectedCandidate.tierReason,
                validationReason: candidateValidation.reason,
                validationChecks: candidateValidation.checks
            });
            return await sendNotification({
                outcome: 'job_not_created',
                details: {
                    callerPhone: matchedPhone || callerPhone,
                    locationName: selectedCandidate.locationName || locationName,
                    companyName: selectedCandidate.companyName || companyName,
                    serviceAddress: selectedCandidate.address || addressForMatching || rawAddress,
                    reasonCode: candidateValidation.reason,
                    reasonMessage: 'Selected location does not sufficiently match call data',
                    topCandidates: [selectedCandidate],
                    validationSummary: buildValidationSummary(candidateValidation)
                }
            });
        }

        const callerPhoneForDescription = extractedFields.callerPhone || call?.from_number || call?.fromNumber || null;
        const currentNode = resolvedDynamicVars?.current_node || resolvedDynamicVars?.currentNode || null;
        const jobDescription = buildJobDescription(issueDescription, callerName, callerPhoneForDescription, currentNode);

        const jobResult = await createJob(
            {
                locationId: selectedCandidate.locationId,
                description: jobDescription,
                callerPhoneNumber: matchedPhone,
                call_id: callId,
                techIds: techIds,
                serviceLineId: serviceLineId
            },
            agentId
        );

        logWithContext('info', 'Job created successfully', {
            callId,
            agentId,
            locationId: selectedCandidate.locationId,
            locationName: selectedCandidate.locationName,
            matchTier: matchTier,
            tierReason: selectedCandidate.tierReason,
            jobId: jobResult?.jobId,
            techIds: techIds.length > 0 ? techIds : null,
            serviceLineId: serviceLineId || null,
            addressValidated: validatedAddress ? true : false
        });

        return await sendNotification({
            outcome: 'job_created',
            details: {
                callerPhone: matchedPhone || callerPhone,
                locationName: selectedCandidate.locationName || locationName,
                companyName: selectedCandidate.companyName || companyName,
                serviceAddress: selectedCandidate.address || addressForMatching || rawAddress,
                jobId: jobResult?.jobId,
                jobUri: jobResult?.jobUri,
                jobNumber: jobResult?.jobNumber,
                appointmentCreated: jobResult?.appointmentCreated,
                appointmentError: jobResult?.appointmentError,
                serviceRequestCreated: jobResult?.serviceRequestCreated,
                serviceRequestError: jobResult?.serviceRequestError,
                matchTier,
                tierReason: selectedCandidate.tierReason
            }
        });
    } catch (error) {
        logWithContext('error', 'Error handling Retell webhook', {
            callId, agentId, error: error.message, stack: error.stack
        });
        await sendNotification({
            outcome: 'job_not_created',
            details: {
                reasonCode: 'internal_error',
                reasonMessage: error.message || 'Webhook error'
            }
        });
    }
}

module.exports = router;
