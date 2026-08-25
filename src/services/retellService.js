const config = require('../config/environment');

// Comfortably longer than a healthy get-call, short enough that a stall cannot hold
// the escalation email hostage.
const GET_CALL_TIMEOUT_MS = 8000;

class RetellService {
    constructor() {
        this.apiKey = config.retellApiKey;
        this.baseUrl = 'https://api.retellai.com/v2';
    }

    async getCall(callId) {
        // A timeout, because the escalation email awaits one of these per dispatch call
        // before it can be composed. Without it a stalled Retell request holds up the
        // client notification indefinitely. The caller already treats a failure as
        // `unavailable: true`, so this degrades to a missing recording, not a missing
        // email.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), GET_CALL_TIMEOUT_MS);
        try {
            const response = await fetch(`${this.baseUrl}/get-call/${callId}`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                },
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Retell API error: ${response.status} ${response.statusText}`);
            }

            const callData = await response.json();
            return callData;
        } catch (error) {
            console.error('Error fetching call from Retell:', error);
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }
}

module.exports = new RetellService();
