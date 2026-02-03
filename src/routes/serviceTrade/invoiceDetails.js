const express = require('express');
const router = express.Router();
const { sendErrorResponse } = require('../../utils/responseHelper');
const { getCustomerByPhone, getJobsByLocation, getInvoicesByJobId } = require('../../controllers/serviceTradeController');

router.post('/st-invoice', async (req, res) => {
    try {
        const fromPhoneNumber = req.body.args?.fromPhoneNumber;
        const agentId = req.body.args?.agent_id;
        const status = req.body.args?.status;
        
        if (!fromPhoneNumber) {
            return sendErrorResponse(res, 'fromPhoneNumber is required', 400);
        }
        
        if (!agentId) {
            return sendErrorResponse(res, 'agent_id is required', 400);
        }
        
        // Step 1: Fetch customer info
        const customerData = await getCustomerByPhone(fromPhoneNumber, agentId);
        
        // Step 2: Fetch job info
        const jobDetails = await getJobsByLocation(customerData.locationId, agentId, status);
        
        // Step 3: Fetch invoices
        const invoices = await getInvoicesByJobId(jobDetails[0].jobId, agentId);
        
        return res.status(200).json({
            invoices: invoices
        });
    } catch (error) {
        console.error('Error in st-invoice route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
