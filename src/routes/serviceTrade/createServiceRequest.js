const express = require('express');
const router = express.Router();
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');
const serviceTradeService = require('../../services/serviceTradeService');
const { getAuthToken } = require('../../controllers/serviceTradeController');

/**
 * POST /st-create-service-request
 * Creates a service request in ServiceTrade
 * 
 * Required fields:
 * - agent_id: The Retell agent ID (for auth token lookup)
 * - locationId: The ServiceTrade location ID
 * 
 * Optional fields:
 * - serviceLineId: Service line ID (defaults to 1 if not provided)
 * - description: Service request description
 * - jobId: Job ID to associate with (if linking to existing job)
 * - appointmentIds: Array of appointment IDs to associate with
 */
router.post('/st-create-service-request', async (req, res) => {
    try {
        const { agent_id, locationId, serviceLineId, description, jobId, appointmentIds } = req.body;
        
        if (!agent_id) {
            return sendErrorResponse(res, 'agent_id is required', 400);
        }
        if (!locationId) {
            return sendErrorResponse(res, 'locationId is required', 400);
        }

        const supabaseAuthToken = await getAuthToken(agent_id);

        // Create service request
        const result = await serviceTradeService.createServiceRequest(supabaseAuthToken, {
            description: description || 'Service request from API',
            locationId: locationId,
            serviceLineId: serviceLineId,
            jobId: jobId,
            appointmentIds: appointmentIds
        });
        
        return sendSuccessResponse(res, result, 'Service request created successfully', 201);
    } catch (error) {
        console.error('Error in st-create-service-request route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;