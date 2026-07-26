require('dotenv').config();

const parseNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

// Parse a comma/semicolon-separated email list into a de-duplicated array.
// Returns the provided fallback array when the env var is unset/empty.
const parseEmailList = (value, fallback = []) => {
    if (!value) return fallback;
    const emails = [...new Set(
        String(value)
            .split(/[;,]/)
            .map((entry) => entry.trim())
            .filter(Boolean)
    )];
    return emails.length > 0 ? emails : fallback;
};

const config = {
    port: process.env.PORT || 3000,
    retellApiKey: process.env.RETELL_API_KEY || process.env.retellapikey,
    openaiApiKey: process.env.OPENAI_API_KEY || process.env.openaiapikey,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY,
    googleMapsKey: process.env.GOOGLE_MAPS_KEY,
    sendgridApiKey: process.env.SENDGRID_API_KEY,
    notificationEmailFrom: process.env.NOTIFICATION_EMAIL_FROM || 'developer@justclara.ai',
    notificationEmailFromName: process.env.NOTIFICATION_EMAIL_FROM_NAME || 'CLARA.AI',
    nodeEnv: process.env.NODE_ENV || 'development',
    // Adaptive Climates Apps Script /exec URL. The outbound post-call webhook POSTs
    // the job result here (action:'job_update') so the escalation sheet row is
    // updated with is_job_created / job_number / outcome. Same value as the
    // Vercel ADAPTIVE_EXEC_URL that feeds the sheet.
    adaptiveSheetExecUrl: process.env.ADAPTIVE_SHEET_EXEC_URL || '',
    // Recipients of internal error/alert emails (sendInternalAlert). Comma or
    // semicolon separated. Falls back to the built-in team list when unset.
    internalAlertRecipients: parseEmailList(process.env.INTERNAL_ALERT_RECIPIENTS, [
        'pavan.kalyan@justclara.ai',
        'subham.agarwal@justclara.ai',
        'aayush.thapar@justclara.ai',
        'bharath.valusa@justclara.ai'
    ]),
    matchingThresholds: {
        confidence: parseNumber(process.env.MATCH_CONFIDENCE_THRESHOLD, 80),
        fuzzySimilarity: parseNumber(process.env.FUZZY_SIMILARITY_THRESHOLD, 0.8),
        nameSimilarity: parseNumber(process.env.NAME_SIMILARITY_THRESHOLD, 0.6)
    }
};

module.exports = config;
