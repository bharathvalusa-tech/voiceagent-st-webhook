const express = require('express');
const cors = require('cors');
const config = require('./config/environment');
const logger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');
const { sendSuccessResponse } = require('./utils/responseHelper');

// Import routes
const stCustomerRoutes = require('./routes/serviceTrade/customerDetails');
const stJobRoutes = require('./routes/serviceTrade/jobDetails');
const stInvoiceRoutes = require('./routes/serviceTrade/invoiceDetails');
const stCreateJobRoutes = require('./routes/serviceTrade/createJob');
const stCreateServiceRequestRoutes = require('./routes/serviceTrade/createServiceRequest');
const retellWebhookRoutes = require('./routes/webhook/retell');
const app = express();

// CORS configuration - allow requests from any domain
app.use(cors({
    origin: '*', // Allow all origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false // Set to true if you need to send cookies
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(logger);

// Routes
app.use('/', stCustomerRoutes);
app.use('/', stJobRoutes);
app.use('/', stInvoiceRoutes);
app.use('/', stCreateJobRoutes);
app.use('/', stCreateServiceRequestRoutes);
app.use('/webhook', retellWebhookRoutes);
// Health check endpoint
app.get('/health', (req, res) => {
    sendSuccessResponse(res, { 
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv 
    }, 'Server is running');
});

// Error handling middleware (must be last)
app.use(errorHandler);

module.exports = app;
