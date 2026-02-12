const express = require('express');
const router = express.Router();
const { parsePhoneNumber } = require('libphonenumber-js');
const { sendErrorResponse } = require('../../utils/responseHelper');
const { getCustomerByPhone, getJobsByLocation } = require('../../controllers/serviceTradeController');

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
            const customerData = await getCustomerByPhone(fromPhoneNumber, agentId);

            // Query jobs across ALL locations the contact is associated with
            const locations = customerData.locations || [];
            const locationIds = locations.map(loc => loc.id).filter(Boolean);

            if (locationIds.length === 0) {
                return sendErrorResponse(res, 'Customer has no associated locations', 404);
            }

            const jobPromises = locationIds.map(locId =>
                getJobsByLocation(locId, agentId, status).catch(err => {
                    console.log(`⚠️ Failed to fetch jobs for location ${locId}:`, err.message);
                    return [];
                })
            );
            const jobArrays = await Promise.all(jobPromises);
            const allJobs = jobArrays.flat();

            // Deduplicate by jobId
            const seen = new Set();
            const jobs = allJobs.filter(job => {
                if (seen.has(job.jobId)) return false;
                seen.add(job.jobId);
                return true;
            });

            return res.status(200).json({
                jobs
            });
        } else {
            return sendErrorResponse(res, 'Either from_phone_number or location_id is required', 400);
        }
    } catch (error) {
        console.error('Error in st-job route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
