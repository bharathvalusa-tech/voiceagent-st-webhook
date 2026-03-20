require('dotenv').config();

const parseNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const config = {
    port: process.env.PORT || 3000,
    retellApiKey: process.env.RETELL_API_KEY || process.env.retellapikey,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    googleMapsKey: process.env.GOOGLE_MAPS_KEY,
    sendgridApiKey: process.env.SENDGRID_API_KEY,
    notificationEmailFrom: process.env.NOTIFICATION_EMAIL_FROM || 'developer@justclara.ai',
    notificationEmailFromName: process.env.NOTIFICATION_EMAIL_FROM_NAME || 'CLARA.AI',
    nodeEnv: process.env.NODE_ENV || 'development',
    serviceTradeVendorId: process.env.SERVICETRADE_VENDOR_ID || '2319651446605697',
    matchingThresholds: {
        confidence: parseNumber(process.env.MATCH_CONFIDENCE_THRESHOLD, 80),
        fuzzySimilarity: parseNumber(process.env.FUZZY_SIMILARITY_THRESHOLD, 0.8),
        nameSimilarity: parseNumber(process.env.NAME_SIMILARITY_THRESHOLD, 0.6)
    }
};

module.exports = config;
