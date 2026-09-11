const crypto = require('crypto');
const supabase = require('../config/database');

/**
 * SHA-256 of the credential pair that minted a token.
 *
 * Stored next to `auth_token` so a username or password edited by hand in the Supabase
 * table editor is detectable on the next read, without the service ever having to compare
 * (or log) the password itself. A mismatch means the stored token belongs to credentials
 * that no longer exist, so it is discarded even when ServiceTrade still accepts it.
 */
const credentialsFingerprint = (username, password) => {
    if (!username || !password) return null;
    return crypto.createHash('sha256').update(`${username}\n${password}`).digest('hex');
};

// Columns added by db/servicetrade_tokens_session_health.sql. Writes carrying them are
// retried without them when the migration has not been run yet — see updateAuthToken.
const SESSION_HEALTH_COLUMNS = [
    'last_modified',
    'credentials_fingerprint',
    'last_auth_status',
    'last_auth_checked_at',
    'last_auth_error'
];

// PostgREST reports an unknown column as PGRST204, and the message names the column.
const isMissingColumnError = (error) => {
    if (!error) return false;
    const text = `${error.code || ''} ${error.message || ''}`;
    return /PGRST204/.test(text) || /column .* does not exist/i.test(text) || /Could not find the .* column/i.test(text);
};

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

    /**
     * Persist a token and the health facts that go with it.
     *
     * `status` is what the row should read afterwards: 'valid' when an existing session was
     * merely re-proven, 'healed' when a dead one was replaced.
     *
     * The session-health columns are best-effort. This code can reach production before
     * db/servicetrade_tokens_session_health.sql has been run in the Supabase editor, and a
     * write naming a column that does not exist fails the WHOLE update — which would stop
     * the token being saved at all and turn a working self-heal into a hard outage. So an
     * unknown-column failure retries with just `auth_token`, and says so in the log.
     */
    async updateAuthToken(agentId, newToken, { username = null, password = null, status = 'healed' } = {}) {
        const now = new Date().toISOString();
        const patch = {
            auth_token: newToken,
            last_modified: now,
            last_auth_status: status,
            last_auth_checked_at: now,
            last_auth_error: null
        };

        const fingerprint = credentialsFingerprint(username, password);
        if (fingerprint) patch.credentials_fingerprint = fingerprint;

        let { error } = await supabase
            .from('servicetrade_tokens')
            .update(patch)
            .eq('agent_id', agentId);

        if (error && isMissingColumnError(error)) {
            console.warn(
                `⚠️ [${agentId}] servicetrade_tokens is missing the session-health columns ` +
                `(${SESSION_HEALTH_COLUMNS.join(', ')}). Saving auth_token only. ` +
                `Run db/servicetrade_tokens_session_health.sql. Supabase said: ${error.message}`
            );
            ({ error } = await supabase
                .from('servicetrade_tokens')
                .update({ auth_token: newToken })
                .eq('agent_id', agentId));
        }

        if (error) {
            console.error('Error updating ServiceTrade token in Supabase:', error);
            throw new Error(`Supabase error: ${error.message}`);
        }
    }

    /**
     * Record why a session could not be established, without touching auth_token.
     *
     * Deliberately swallows its own failure: this is bookkeeping on an error path, and a
     * write that fails here must not replace the real error the caller is about to report.
     */
    async markAuthFailure(agentId, status, reason) {
        const { error } = await supabase
            .from('servicetrade_tokens')
            .update({
                last_modified: new Date().toISOString(),
                last_auth_status: status,
                last_auth_checked_at: new Date().toISOString(),
                last_auth_error: reason ? String(reason).slice(0, 500) : null
            })
            .eq('agent_id', agentId);

        if (error && !isMissingColumnError(error)) {
            console.error(`Error recording auth failure for ${agentId}:`, error.message);
        }
    }

    /**
     * Stamp a session that was checked and found already valid.
     *
     * Also backfills `credentials_fingerprint` on a row that has never had one, so the
     * next credential edit is detectable. No token is issued and auth_token is untouched.
     */
    async recordSessionValid(agentId, { username = null, password = null, backfillFingerprint = false } = {}) {
        const now = new Date().toISOString();
        const patch = {
            last_modified: now,
            last_auth_status: 'valid',
            last_auth_checked_at: now,
            last_auth_error: null
        };

        if (backfillFingerprint) {
            const fingerprint = credentialsFingerprint(username, password);
            if (fingerprint) patch.credentials_fingerprint = fingerprint;
        }

        const { error } = await supabase
            .from('servicetrade_tokens')
            .update(patch)
            .eq('agent_id', agentId);

        if (error && !isMissingColumnError(error)) {
            console.error(`Error recording valid session for ${agentId}:`, error.message);
        }
    }

    /**
     * Every ServiceTrade tenant row, for the scheduled session sweep.
     *
     * Returns credentialed and credential-less rows alike: a row that CANNOT heal itself is
     * exactly what the sweep has to report, so filtering it out here would hide it.
     */
    async getAllServiceTradeTokens() {
        const { data, error } = await supabase
            .from('servicetrade_tokens')
            .select('*')
            .order('Name', { ascending: true });

        if (error) {
            throw new Error(`Supabase error: ${error.message}`);
        }

        return data || [];
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

const service = new SupabaseService();
service.credentialsFingerprint = credentialsFingerprint;

module.exports = service;
