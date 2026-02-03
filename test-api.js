/**
 * Simple API Testing Script
 * Run this after starting your server with: npm run dev
 */

const BASE_URL = 'http://localhost:3000';

// Colors for console output
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
    reset: '\x1b[0m'
};

function log(message, color = 'reset') {
    console.log(`LOG: ${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
    console.log('\n' + '='.repeat(60));
    log(title, 'blue');
    console.log('='.repeat(60));
}

async function testEndpoint(name, method, endpoint, body = null) {
    logSection(`Testing: ${name}`);
    log(`${method} ${BASE_URL}${endpoint}`, 'yellow');
    
    try {
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        
        if (body) {
            options.body = JSON.stringify(body);
            log('\nRequest Body:', 'yellow');
            console.log(JSON.stringify(body, null, 2));
        }
        
        const response = await fetch(`${BASE_URL}${endpoint}`, options);
        const data = await response.json();
        
        if (response.ok) {
            log('\n✓ SUCCESS', 'green');
            log(`Status: ${response.status}`, 'green');
            log('\nResponse:', 'green');
            console.log(JSON.stringify(data, null, 2));
            return { success: true, data };
        } else {
            log('\n✗ FAILED', 'red');
            log(`Status: ${response.status}`, 'red');
            log('\nError Response:', 'red');
            console.log(JSON.stringify(data, null, 2));
            return { success: false, data };
        }
    } catch (error) {
        log('\n✗ ERROR', 'red');
        log(`Error: ${error.message}`, 'red');
        if (error.message.includes('fetch failed')) {
            log('\n⚠ Is your server running? Start it with: npm run dev', 'yellow');
        }
        return { success: false, error: error.message };
    }
}

async function waitForServer(maxAttempts = 10) {
    log('\n⏳ Waiting for server to be ready...', 'yellow');
    
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const response = await fetch(`${BASE_URL}/health`);
            if (response.ok) {
                log('✓ Server is ready!\n', 'green');
                return true;
            }
        } catch (error) {
            // Server not ready yet
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    log('✗ Server did not start in time', 'red');
    log('Please start the server manually with: npm run dev', 'yellow');
    return false;
}

async function runTests() {
    log('\n🚀 Starting API Tests...', 'blue');
    
    // Wait for server to be ready
    const serverReady = await waitForServer();
    if (!serverReady) {
        process.exit(1);
    }
    
    // Test 1: Health Check
    await testEndpoint('Health Check', 'GET', '/health');
    
    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test 2: Get Customer
    const customerResult = await testEndpoint(
        'Get Customer Details',
        'POST',
        '/st-customer',
        {
            call: {
                from_number: '+15551234567',
                agent_id: 'agent_a1b8ba240d018a778575917bf0'
            }
        }
    );
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test 3: Get Jobs
    await testEndpoint(
        'Get Jobs',
        'POST',
        '/st-job',
        {
            call: {
                from_number: '+15551234567',
                agent_id: 'agent_a1b8ba240d018a778575917bf0'
            },
            args: {
                status: 'open'
            }
        }
    );
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test 4: Get Invoices
    await testEndpoint(
        'Get Invoices',
        'POST',
        '/st-invoice',
        {
            args: {
                fromPhoneNumber: '5551234567',
                agent_id: 'agent_a1b8ba240d018a778575917bf0',
                status: 'open'
            }
        }
    );
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test 5: Create Job (using test payload)
    const fs = require('fs');
    let testPayload;
    try {
        testPayload = JSON.parse(fs.readFileSync('test-payload.json', 'utf8'));
    } catch (error) {
        log('\n⚠ Could not read test-payload.json, using default payload', 'yellow');
        testPayload = {
            agent_id: 'agent_a1b8ba240d018a778575917bf0',
            call_id: 'call_test123',
            collected_dynamic_variables: {
                user_name: 'John Doe',
                user_email: 'john.doe@example.com',
                user_phone: '5551234567',
                serviceLineName: 'Plumbing',
                raw_input: '123 Main St, Austin, Texas, 78701',
                state: 'Texas'
            },
            call_analysis: {
                call_summary: 'Customer needs plumbing service for a clogged drain',
                appointment_date_utc: '2025-12-01',
                appointment_start_utc: '09:00:00'
            }
        };
    }
    
    await testEndpoint('Create Job', 'POST', '/st-create-job', testPayload);
    
    // Summary
    logSection('Tests Complete!');
    log('\n📝 Next Steps:', 'blue');
    log('1. Check the results above', 'yellow');
    log('2. If you see errors, read the error messages', 'yellow');
    log('3. Check your server logs in the other terminal', 'yellow');
    log('4. Verify data in ServiceTrade dashboard', 'yellow');
    log('\n💡 Tip: You can modify test-payload.json to test different scenarios\n', 'blue');
}

// Run the tests
runTests().catch(error => {
    log('\n✗ Test script failed:', 'red');
    console.error(error);
});
