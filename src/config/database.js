const { createClient } = require('@supabase/supabase-js');
// Same .env.local-then-.env order as src/config/environment.js — this module is
// imported directly by some routes without going through it.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = supabase;
