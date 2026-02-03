const config = require('../../config/environment');
const express = require('express');
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

const getCallField = (call, extracted, fallbackKeys = []) => {
    for (const key of fallbackKeys) {
        if (call?.[key]) return call[key];
        if (extracted?.[key]) return extracted[key];
    }
    return null;
};

router.post('/retell', async (req, res) => {
    try {
        const { eventType, call, analysis, extracted } = extractPayload(req.body || {});

        if (eventType && eventType !== 'call_analyzed') {
            return res.status(200).json({ status: 'ignored', message: 'Event not call_analyzed' });
        }

        const agentId = call?.agent_id || extracted?.agent_id || req.body?.agent_id;
        if (!agentId) {
            console.log('❌ Missing agent_id in webhook payload');
            return res.status(200).json({ status: 'error', message: 'Missing agent_id' });
        }

        const callId = call?.call_id || call?.id || req.body?.call_id || extracted?.call_id;
        const callerPhone =
            call?.from_number ||
            call?.fromNumber ||
            call?.phone_number ||
            extracted?.caller_phone ||
            extracted?.phone ||
            null;

        const callerName =
            extracted?.caller_name ||
            extracted?.customer_name ||
            extracted?.name ||
            null;

        const addressLine1 =
            extracted?.address_line1 ||
            extracted?.addressLine1 ||
            extracted?.street_address ||
            extracted?.street ||
            extracted?.address1 ||
            null;

        const addressCity =
            extracted?.city ||
            extracted?.address_city ||
            extracted?.addressCity ||
            null;

        const addressState =
            extracted?.state ||
            extracted?.address_state ||
            extracted?.addressState ||
            null;

        const addressPostal =
            extracted?.postal_code ||
            extracted?.postalCode ||
            extracted?.zip ||
            null;

        const rawAddress =
            extracted?.caller_address ||
            extracted?.address ||
            extracted?.location_address ||
            extracted?.raw_input ||
            buildAddressQuery({
                line1: addressLine1,
                city: addressCity,
                state: addressState,
                postalCode: addressPostal
            }) ||
            null;

        const locationName =
            extracted?.location_name ||
            extracted?.business_name ||
            extracted?.location ||
            null;

        const issueDescription =
            extracted?.issue_description ||
            analysis?.call_summary ||
            extracted?.call_summary ||
            'Service request from call';

        if (!rawAddress) {
            console.log('❌ Missing address for validation', { callId, agentId });
            return res.status(200).json({ status: 'pending_review', message: 'Missing address' });
        }

        const validatedAddress = await validateAddress({
            line1: addressLine1 || rawAddress,
            city: addressCity,
            state: addressState,
            postalCode: addressPostal
        });
        if (!validatedAddress) {
            console.log('❌ Address validation failed', { callId, agentId, rawAddress });
            return res.status(200).json({ status: 'pending_review', message: 'Invalid address' });
        }

        const tokenData = await supabaseService.getServiceTradeToken(agentId);
        if (!tokenData || tokenData.length === 0) {
            console.log('❌ No ServiceTrade token found', { agentId, callId });
            return res.status(200).json({ status: 'error', message: 'No ServiceTrade token found' });
        }

        const authToken = tokenData[0].auth_token;

        const searchData = {
            phone: callerPhone,
            name: callerName,
            locationName,
            address: validatedAddress.formatted_address || validatedAddress.street
        };

        const candidates = await findCustomerWithConfidence(authToken, searchData);
        const bestMatch = candidates[0];

        if (!bestMatch || bestMatch.confidence < config.matchingThresholds.confidence || !bestMatch.locationId) {
            console.log('❌ Low confidence match - manual review needed:', {
                callId,
                agentId,
                callerPhone,
                callerName,
                address: validatedAddress.formatted_address,
                bestMatch,
                candidatesCount: candidates.length
            });
            return res.status(200).json({ status: 'pending_review', message: 'Low confidence match' });
        }

        const jobResult = await createJob(
            {
                locationId: bestMatch.locationId,
                description: issueDescription,
                callerPhoneNumber: callerPhone,
                call_id: callId
            },
            agentId
        );

        return res.status(200).json({
            status: 'success',
            job: jobResult,
            match: {
                locationId: bestMatch.locationId,
                confidence: bestMatch.confidence
            }
        });
    } catch (error) {
        console.error('❌ Error handling Retell webhook:', error);
        return res.status(200).json({ status: 'error', message: error.message || 'Webhook error' });
    }
});

module.exports = router;
