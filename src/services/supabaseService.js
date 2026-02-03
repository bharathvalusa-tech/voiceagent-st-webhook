const supabase = require('../config/database');

class SupabaseService {
    async getServiceTradeToken(agentId) {
        try {
            const { data, error } = await supabase
                .from('servicetrade_tokens')
                .select('*')
                .eq('agent_id', agentId);

            if (error) {
                throw new Error(`Supabase error: ${error.message}`);
            }

            return data;
        } catch (error) {
            console.error('Error fetching ServiceTrade token from Supabase:', error);
            throw error;
        }
    }

    async getJobConfig(agentId) {
        try {
            const { data, error } = await supabase
                .from('servicetrade_job_configs')
                .select('*')
                .eq('agent_id', agentId)
                .limit(1);

            if (error) {
                throw new Error(`Supabase error: ${error.message}`);
            }

            return data && data.length > 0 ? data[0] : null;
        } catch (error) {
            console.error('Error fetching job config from Supabase:', error);
            throw error;
        }
    }
}

module.exports = new SupabaseService();
