// @ts-nocheck
const config = require('../../config/environment');
const express = require('express');
const retellService = require('../../services/retellService');
const { validateAddress, buildAddressQuery } = require('../../services/googleMapsService');
const { findCustomerWithConfidence } = require('../../services/customerMatchingService');
const { createJob } = require('../../controllers/serviceTradeController');
const supabaseService = require('../../services/supabaseService');

const router = express.Router();

const extractPayload = (body) => {
    const eventType = body.event || body.event_type || body.type || body.webhook_event;
    const call = body.call || body.data?.call || body.data || body;
    const analysis = body.call_analysis || body.analysis || body.data?.call_analysis || body.data?.analysis || {};
    const extracted =
        analysis.custom_analysis_data ||
        analysis.extracted_data ||
        analysis.call_analyzed_data ||
        analysis;

    return { eventType, call, analysis, extracted };
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

const buildJobDescription = (issueDescription, callerName) => {
    const name = (callerName || '').trim() || 'Unknown person';
    const rawDescription = (issueDescription || '').trim();
    if (!rawDescription) {
        return `[AFTER HOURS]: ${name} reported an issue.`;
    }

    const replaced = callerName
        ? rawDescription.replace(/\b(caller|customer)\b/gi, name)
        : rawDescription;

    return `[AFTER HOURS]: ${name} reported ${replaced}`;
};

router.post('/retell', async (req, res) => {
    try {
        const { eventType, call, analysis, extracted } = extractPayload(req.body || {});

        if (eventType && eventType !== 'call_analyzed') {
            return res.status(200).json({ status: 'ignored', message: 'Event not call_analyzed' });
        }

        const agentId = call?.agent_id || extracted?.agent_id || req.body?.agent_id;
        const callId = call?.call_id || call?.id || req.body?.call_id || extracted?.call_id;
        if (!agentId) {
            logWithContext('error', 'Missing agent_id in webhook payload', { callId });
            return res.status(200).json({
                status: 'error',
                reason: 'missing_agent_id',
                message: 'Missing agent_id'
            });
        }

        const loadExtractedFields = (sourceExtracted, sourceAnalysis) => {
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
                null;

            const addressLine1 =
                sourceExtracted?.address_line1 ||
                sourceExtracted?.addressLine1 ||
                sourceExtracted?.street_address ||
                sourceExtracted?.street ||
                sourceExtracted?.address1 ||
                null;

            const addressCity =
                sourceExtracted?.city ||
                sourceExtracted?.address_city ||
                sourceExtracted?.addressCity ||
                null;

            const addressState =
                sourceExtracted?.state ||
                sourceExtracted?.address_state ||
                sourceExtracted?.addressState ||
                null;

            const addressPostal =
                sourceExtracted?.postal_code ||
                sourceExtracted?.postalCode ||
                sourceExtracted?.zip ||
                null;

            const rawAddress =
                sourceExtracted?.caller_address ||
                sourceExtracted?.address ||
                sourceExtracted?.location_address ||
                sourceExtracted?.raw_input ||
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
                sourceExtracted?.call_summary ||
                'Service request from call';

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
                issueDescription
            };
        };

        let resolvedExtracted = extracted || {};
        let resolvedAnalysis = analysis || {};
        let extractedFields = loadExtractedFields(resolvedExtracted, resolvedAnalysis);

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
                extractedFields = loadExtractedFields(resolvedExtracted, resolvedAnalysis);

                logWithContext('info', 'Loaded extracted fields via Retell API fallback', {
                    callId,
                    agentId
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
            issueDescription
        } = extractedFields;

        if (!rawAddress) {
            logWithContext('error', 'Missing address for validation', {
                callId,
                agentId,
                callerPhone,
                callerName
            });
            return res.status(200).json({
                status: 'pending_review',
                reason: 'missing_address',
                message: 'Missing address'
            });
        }

        const validatedAddress = await validateAddress({
            line1: addressLine1 || rawAddress,
            city: addressCity,
            state: addressState,
            postalCode: addressPostal
        });
        if (!validatedAddress) {
            logWithContext('error', 'Address validation failed', {
                callId,
                agentId,
                callerPhone,
                callerName,
                rawAddress
            });
            return res.status(200).json({
                status: 'pending_review',
                reason: 'invalid_address',
                message: 'Invalid address'
            });
        }

        const tokenData = await supabaseService.getServiceTradeToken(agentId);
        if (!tokenData || tokenData.length === 0) {
            logWithContext('error', 'No ServiceTrade token found', {
                callId,
                agentId
            });
            return res.status(200).json({
                status: 'error',
                reason: 'missing_servicetrade_token',
                message: 'No ServiceTrade token found'
            });
        }

        const authToken = tokenData[0].auth_token;

        const validatedFullAddress = [
            validatedAddress.street,
            validatedAddress.city,
            validatedAddress.state,
            validatedAddress.postalCode
        ]
            .filter(Boolean)
            .join(', ');

        const buildSearchData = (phone) => {
            return {
                phone,
                name: callerName,
                locationName,
                companyName,
                address: validatedFullAddress || validatedAddress.formatted_address || validatedAddress.street
            };
        };

        let matchedPhone = callerPhone;
        let candidates = await findCustomerWithConfidence(authToken, buildSearchData(callerPhone));
        let bestMatch = candidates[0];

        const shouldTryFallbackPhone =
            callerPhoneFallback &&
            callerPhoneFallback !== callerPhone &&
            (!bestMatch || bestMatch.confidence < config.matchingThresholds.confidence);

        if (shouldTryFallbackPhone) {
            const fallbackCandidates = await findCustomerWithConfidence(
                authToken,
                buildSearchData(callerPhoneFallback)
            );
            const fallbackBestMatch = fallbackCandidates[0];
            if (
                fallbackBestMatch &&
                fallbackBestMatch.confidence >= config.matchingThresholds.confidence &&
                fallbackBestMatch.locationId
            ) {
                candidates = fallbackCandidates;
                bestMatch = fallbackBestMatch;
                matchedPhone = callerPhoneFallback;
            }
        }

        if (!bestMatch || bestMatch.confidence < config.matchingThresholds.confidence || !bestMatch.locationId) {
            logWithContext('error', 'Low confidence match - manual review needed', {
                callId,
                agentId,
                callerPhone: matchedPhone,
                callerName,
                address: validatedAddress.formatted_address,
                candidatesCount: candidates.length,
                topCandidate: bestMatch
                    ? {
                          locationId: bestMatch.locationId,
                          locationName: bestMatch.locationName,
                          confidence: bestMatch.confidence,
                          phoneExact: bestMatch.phoneExact,
                          addressSimilarity: bestMatch.addressSimilarity,
                          locationSimilarity: bestMatch.locationSimilarity,
                          companySimilarity: bestMatch.companySimilarity,
                          nameSimilarity: bestMatch.nameSimilarity
                      }
                    : null,
                bestMatch,
                confidenceThreshold: config.matchingThresholds.confidence
            });
            return res.status(200).json({
                status: 'pending_review',
                reason: 'low_confidence_match',
                message: 'Low confidence match',
                details: {
                    bestMatch,
                    candidatesCount: candidates.length,
                    confidenceThreshold: config.matchingThresholds.confidence
                }
            });
        }

        const jobDescription = buildJobDescription(issueDescription, callerName);

        const jobResult = await createJob(
            {
                locationId: bestMatch.locationId,
                description: jobDescription,
                callerPhoneNumber: matchedPhone,
                call_id: callId
            },
            agentId
        );

        logWithContext('info', 'Job created successfully', {
            callId,
            agentId,
            locationId: bestMatch.locationId,
            confidence: bestMatch.confidence,
            jobId: jobResult?.jobId
        });

        return res.status(200).json({
            status: 'success',
            job: jobResult,
            match: {
                locationId: bestMatch.locationId,
                confidence: bestMatch.confidence
            }
        });
    } catch (error) {
        logWithContext('error', 'Error handling Retell webhook', {
            error: error.message,
            stack: error.stack
        });
        return res.status(200).json({
            status: 'error',
            reason: 'internal_error',
            message: error.message || 'Webhook error'
        });
    }
});

module.exports = router;
