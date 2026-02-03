/**
 * ServiceTrade Authentication Test
 * Tests if your ServiceTrade token is valid
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

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

async function testServiceTradeAuth() {
    log('\n🔐 Testing ServiceTrade Authentication...\n', 'blue');
    
    // Step 1: Get token from Supabase
    log('Step 1: Fetching token from Supabase...', 'yellow');
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
    );
    
    const agentId = 'agent_a1b8ba240d018a778575917bf0';
    
    const { data, error } = await supabase
        .from('servicetrade_tokens')
        .select('*')
        .eq('agent_id', agentId);
    
    if (error) {
        log(`✗ Supabase error: ${error.message}`, 'red');
        return;
    }
    
    if (!data || data.length === 0) {
        log(`✗ No token found for agent_id: ${agentId}`, 'red');
        log('\n💡 You need to add a ServiceTrade token to Supabase:', 'yellow');
        log('1. Log into ServiceTrade', 'yellow');
        log('2. Open browser DevTools (F12)', 'yellow');
        log('3. Go to Application > Cookies', 'yellow');
        log('4. Copy the PHPSESSID value', 'yellow');
        log('5. Add it to servicetrade_tokens table in Supabase', 'yellow');
        return;
    }
    
    const authToken = data[0].auth_token;
    log(`✓ Token found: ${authToken.substring(0, 20)}...`, 'green');
    
    // Step 2: Test ServiceTrade API
    log('\nStep 2: Testing ServiceTrade API...', 'yellow');
    
    try {
        const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
        
        log('Calling: https://api.servicetrade.com/api/vendor', 'blue');
        
        const response = await fetch('https://api.servicetrade.com/api/vendor', {
            method: 'GET',
            headers: {
                'Cookie': cookieValue,
                'Content-Type': 'application/json'
            }
        });
        
        log(`Response Status: ${response.status} ${response.statusText}`, 
            response.ok ? 'green' : 'red');
        
        if (response.ok) {
            const result = await response.json();
            log('\n✓ SUCCESS! ServiceTrade API is working', 'green');
            log('\nVendor Info:', 'blue');
            console.log(JSON.stringify(result, null, 2));
        } else {
            const errorText = await response.text();
            log('\n✗ FAILED! ServiceTrade returned an error', 'red');
            log('\nError Response:', 'red');
            console.log(errorText);
            
            if (response.status === 401 || response.status === 403) {
                log('\n💡 Your token is invalid or expired', 'yellow');
                log('Get a new PHPSESSID from ServiceTrade and update Supabase', 'yellow');
            } else if (response.status === 404) {
                log('\n💡 Possible issues:', 'yellow');
                log('- The API endpoint might have changed', 'yellow');
                log('- Your account might not have access to vendor info', 'yellow');
                log('- The token format might be incorrect', 'yellow');
            }
        }
    } catch (error) {
        log(`\n✗ Error: ${error.message}`, 'red');
    }
    
    log('\n');
}

testServiceTradeAuth().catch(error => {
    log('\n✗ Test failed:', 'red');
    console.error(error);
});
