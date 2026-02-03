const express = require('express');
const router = express.Router();
const { parsePhoneNumber } = require('libphonenumber-js');
const { sendErrorResponse } = require('../../utils/responseHelper');
const { getJobsByPhone, getCustomerByPhone, getJobsByLocation } = require('../../controllers/serviceTradeController');

router.post('/st-job', async (req, res) => {
    try {
        const fromPhoneNumberRaw = req.body.call.from_number;
        const agentId = req.body.call.agent_id;
        const status = req.body.args.status;
        
        if (fromPhoneNumberRaw) {
            // Parse phone number and extract national number (without country code)
            const phoneNumber = parsePhoneNumber(fromPhoneNumberRaw);
            if (!phoneNumber || !phoneNumber.isValid()) {
                return sendErrorResponse(res, 'Invalid phone number format', 400);
            }
            const fromPhoneNumber = phoneNumber.nationalNumber;
            const {locationId} =await getCustomerByPhone(fromPhoneNumber, agentId);
            const jobs = await getJobsByLocation(locationId, agentId, status);
            return res.status(200).json({
                jobs
            });
        }else {
            return sendErrorResponse(res, 'Either from_phone_number or location_id is required', 400);
        }
    } catch (error) {
        console.error('Error in st-job route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
