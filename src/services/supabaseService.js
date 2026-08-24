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

    async updateAuthToken(agentId, newToken) {
        try {
            const { error } = await supabase
                .from('servicetrade_tokens')
                .update({ auth_token: newToken })
                .eq('agent_id', agentId);

            if (error) {
                throw new Error(`Supabase error: ${error.message}`);
            }
        } catch (error) {
            console.error('Error updating ServiceTrade token in Supabase:', error);
            throw error;
        }
    }

    /**
     * `agent_id -> st_username` for the given agents, in one read.
     *
     * Used to relate the agent whose ServiceTrade session we are holding to the agent
     * whose rows are mirrored. For Adaptive those are two different agents that
     * authenticate as the SAME ServiceTrade user, so the username is the link — and it
     * is a fact in the database rather than a mapping someone has to declare and keep
     * correct.
     */
    async getTokenUsernames(agentIds) {
        if (!agentIds || agentIds.length === 0) return new Map();

        const { data, error } = await supabase
            .from('servicetrade_tokens')
            .select('agent_id, st_username')
            .in('agent_id', agentIds);

        if (error) {
            throw new Error(`Supabase error: ${error.message}`);
        }

        return new Map((data || []).map((row) => [row.agent_id, row.st_username || null]));
    }

    /**
     * Every mirrored location for one tenant, from `servicetrade_locations`.
     *
     * READ ONLY on this side. The mirror is WRITTEN by the Supabase Edge Function
     * (supabase/functions/sync-locations); this service consumes it as the phone-index
     * fallback when ServiceTrade is unreachable.
     *
     * Asks for the columns that build a phone -> location entry and nothing else.
     * `raw_response` is the untouched GET /location payload, so `primaryContact`'s
     * phone/mobile/alternate numbers come along — 107 further distinct numbers on the
     * Adaptive account, which the flat columns alone would lose.
     */
    async getLocationsForAgent(agentId) {
        const { data, error } = await supabase
            .from('servicetrade_locations')
            .select('servicetrade_id,name,phone_number,street,city,state,postal_code,status,raw_response')
            .eq('agent_id', agentId);

        if (error) {
            throw new Error(`Supabase error: ${error.message}`);
        }

        return data || [];
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
