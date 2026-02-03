const express = require('express');
const router = express.Router();
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const { createJob } = require('../../controllers/serviceTradeController');

/**
 * POST /st-create-job
 * Creates a job for an existing customer in ServiceTrade
 * 
 * Required fields:
 * - agent_id: The Retell agent ID (for auth token lookup)
 * - locationId: The ServiceTrade location ID
 * - companyId: The ServiceTrade company ID (used as vendorId)
 * 
 * Optional fields:
 * - type: Job type (default: "emergency_service_call")
 * - description: Job description (default: "Service request from call")
 * - appointmentDate: Date in format "YYYY-MM-DD"
 * - appointmentTime: Time in format "HH:MM:SS"
 * - primaryContactId: ServiceTrade contact ID of the person who called (optional if callerPhoneNumber provided)
 * - callerPhoneNumber: Phone number of the caller (will auto-lookup contact ID)
 * - call_id: Retell call ID for reference
 */
router.post('/st-create-job', async (req, res) => {
    try {
        const { agent_id, locationId, companyId, type, description, appointmentDate, appointmentTime, primaryContactId, callerPhoneNumber, call_id, customName, jobDurationMinutes, techIds, released } = req.body;
        
        if (!agent_id) {
            return sendErrorResponse(res, 'agent_id is required', 400);
        }
        if (!locationId) {
            return sendErrorResponse(res, 'locationId is required', 400);
        }

        // Create job with provided locationId and companyId
        const result = await createJob({
            locationId,
            companyId,
            type,
            description,
            appointmentDate,
            appointmentTime,
            primaryContactId,
            callerPhoneNumber,
            call_id,
            customName,
            jobDurationMinutes,
            techIds,
            released
        }, agent_id);
        
        return sendSuccessResponse(res, result, 'Job created successfully', 201);
    } catch (error) {
        console.error('Error in st-create-job route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
