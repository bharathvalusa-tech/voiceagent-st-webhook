const express = require('express');
const router = express.Router();
const { parsePhoneNumber } = require('libphonenumber-js');
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const { getCustomerByPhone } = require('../../controllers/serviceTradeController');

router.post('/st-customer', async (req, res) => {
    try {
        // Be flexible with payload shape (Retell/tools sometimes send flattened bodies)
        const call = req.body?.call || req.body || {};
        const fromPhoneNumberRaw = call.from_number || call.fromNumber || call.phone || req.body?.from_number;
        const agentId = call.agent_id || call.agentId || req.body?.agent_id;
        
        if (!fromPhoneNumberRaw) {
            console.error('st-customer missing phone number. Body:', JSON.stringify(req.body));
            return sendErrorResponse(res, 'Phone number is required', 400);
        }
        
        // Parse phone number and extract national number (without country code)
        let fromPhoneNumber;
        try {
            const phoneNumber = parsePhoneNumber(fromPhoneNumberRaw, 'US');
            if (!phoneNumber || !phoneNumber.isValid()) {
                return sendErrorResponse(res, 'Invalid phone number format', 400);
            }
            fromPhoneNumber = phoneNumber.nationalNumber;
        } catch (parseError) {
            console.error('Phone parsing error:', parseError);
            return sendErrorResponse(res, 'Invalid phone number format', 400);
        }
        
        if (!agentId) {
            console.error('st-customer missing agent_id. Body:', JSON.stringify(req.body));
            return sendErrorResponse(res, 'agent_id is required', 400);
        }
        
        const customerData = await getCustomerByPhone(fromPhoneNumber, agentId);
        
        return res.status(200).json({
            name: customerData.name,
            phone: customerData.phone,
            email: customerData.email,
            customerId: customerData.customerId, // Contact ID of the caller
            locations: customerData.locations,
            // Keep backward compatibility fields
            locationId: customerData.locationId,
            companyId: customerData.companyId,
            address: customerData.address
        });
    } catch (error) {
        console.error('Error in st-customer route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
