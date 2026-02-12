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
        
        // Step 1: Fetch customer info (includes all locations)
        const customerData = await getCustomerByPhone(fromPhoneNumber, agentId);
        
        // Step 2: Fetch jobs across ALL locations the contact is associated with
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

        // Deduplicate jobs by jobId
        const seenJobs = new Set();
        const jobDetails = allJobs.filter(job => {
            if (seenJobs.has(job.jobId)) return false;
            seenJobs.add(job.jobId);
            return true;
        });

        if (jobDetails.length === 0) {
            return res.status(200).json({ invoices: [] });
        }

        // Step 3: Fetch invoices for ALL jobs (not just the first one)
        const invoicePromises = jobDetails.map(job =>
            getInvoicesByJobId(job.jobId, agentId).catch(err => {
                console.log(`⚠️ Failed to fetch invoices for job ${job.jobId}:`, err.message);
                return [];
            })
        );
        const invoiceArrays = await Promise.all(invoicePromises);
        const allInvoices = invoiceArrays.flat();

        // Deduplicate invoices by id
        const seenInvoices = new Set();
        const invoices = allInvoices.filter(inv => {
            const invId = inv?.id || inv?.invoiceId;
            if (!invId || seenInvoices.has(invId)) return false;
            seenInvoices.add(invId);
            return true;
        });
        
        return res.status(200).json({
            invoices: invoices
        });
    } catch (error) {
        console.error('Error in st-invoice route:', error);
        sendErrorResponse(res, error.message || 'Internal server error', 500);
    }
});

module.exports = router;
