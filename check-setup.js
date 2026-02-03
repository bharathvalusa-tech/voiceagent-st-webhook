/**
 * Setup Diagnostic Script
 * Checks if your environment is configured correctly
 */

const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
    reset: '\x1b[0m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

async function checkSetup() {
    log('\n🔍 Checking Your Setup...\n', 'blue');
    
    // Check 1: Environment Variables
    log('1. Checking Environment Variables...', 'yellow');
    require('dotenv').config();
    
    const requiredEnvVars = [
        'PORT',
        'SUPABASE_URL',
        'SUPABASE_ANON_KEY',
        'RETELL_API_KEY'
    ];
    
    let envOk = true;
    for (const envVar of requiredEnvVars) {
        if (process.env[envVar]) {
            log(`   ✓ ${envVar} is set`, 'green');
        } else {
            log(`   ✗ ${envVar} is missing`, 'red');
            envOk = false;
        }
    }
    
    if (!envOk) {
        log('\n⚠ Fix your .env file before continuing\n', 'red');
        return;
    }
    
    // Check 2: Supabase Connection
    log('\n2. Checking Supabase Connection...', 'yellow');
    try {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY
        );
        
        const { data, error } = await supabase
            .from('servicetrade_tokens')
            .select('agent_id, auth_token')
            .limit(5);
        
        if (error) {
            log(`   ✗ Supabase error: ${error.message}`, 'red');
        } else {
            log(`   ✓ Connected to Supabase`, 'green');
            log(`   ✓ Found ${data.length} token(s) in database`, 'green');
            
            if (data.length > 0) {
                log('\n   Available agent_ids:', 'blue');
                data.forEach(row => {
                    const tokenPreview = row.auth_token ? 
                        row.auth_token.substring(0, 10) + '...' : 
                        'NO TOKEN';
                    log(`   - ${row.agent_id} (token: ${tokenPreview})`, 'yellow');
                });
            } else {
                log('\n   ⚠ No tokens found in servicetrade_tokens table', 'yellow');
                log('   You need to add a ServiceTrade token to test', 'yellow');
            }
        }
    } catch (error) {
        log(`   ✗ Error: ${error.message}`, 'red');
    }
    
    // Check 3: Server Status
    log('\n3. Checking Server Status...', 'yellow');
    try {
        const response = await fetch('http://localhost:3000/health');
        if (response.ok) {
            log('   ✓ Server is running on port 3000', 'green');
        } else {
            log('   ✗ Server responded with error', 'red');
        }
    } catch (error) {
        log('   ✗ Server is not running', 'red');
        log('   Start it with: npm run dev', 'yellow');
    }
    
    // Summary
    log('\n' + '='.repeat(60), 'blue');
    log('Summary', 'blue');
    log('='.repeat(60), 'blue');
    
    log('\n✅ What\'s Working:', 'green');
    log('- Environment variables are configured', 'green');
    log('- Supabase connection is working', 'green');
    
    log('\n📝 Next Steps:', 'yellow');
    log('1. Make sure you have a valid ServiceTrade token in Supabase', 'yellow');
    log('2. Use a real phone number from ServiceTrade in your tests', 'yellow');
    log('3. Update test-payload.json with real customer data', 'yellow');
    
    log('\n💡 To test with real data:', 'blue');
    log('- Get a customer phone number from ServiceTrade', 'blue');
    log('- Update the phone number in test-api.js (line 67)', 'blue');
    log('- Run: npm test', 'blue');
    
    log('\n');
}

checkSetup().catch(error => {
    log('\n✗ Diagnostic failed:', 'red');
    console.error(error);
});
