const config = require('../config/environment');

class RetellService {
    constructor() {
        this.apiKey = config.retellApiKey;
        this.baseUrl = 'https://api.retellai.com/v2';
    }

    async getCall(callId) {
        try {
            const response = await fetch(`${this.baseUrl}/get-call/${callId}`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                }
            });

            if (!response.ok) {
                throw new Error(`Retell API error: ${response.status} ${response.statusText}`);
            }

            const callData = await response.json();
            return callData;
        } catch (error) {
            console.error('Error fetching call from Retell:', error);
            throw error;
        }
    }
}

module.exports = new RetellService();
