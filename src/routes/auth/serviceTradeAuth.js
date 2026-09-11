const express = require('express');
const router = express.Router();
const serviceTradeService = require('../../services/serviceTradeService');
const supabaseService = require('../../services/supabaseService');
const emailNotificationService = require('../../services/emailNotificationService');
const { resolveSessionForRow } = require('../../controllers/serviceTradeController');
const config = require('../../config/environment');
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');

// Read-only probe used to prove a session against a real resource, not just against
// GET /auth. The two are not the same check: a dead session answers /auth with 404 and every
// other endpoint with 401, so /auth alone leaves the interesting half untested. limit=1 keeps
// it to a single row.
const TEST_ENDPOINT = '/location?limit=1';

const maskToken = (token) => emailNotificationService.maskToken(token);

/**
 * Prove a token against a real ServiceTrade resource. Never throws — the caller reports the
 * outcome either way.
 */
const probeTestEndpoint = async (authToken) => {
    try {
        const response = await fetch(`${serviceTradeService.baseUrl}${TEST_ENDPOINT}`, {
            method: 'GET',
            headers: {
                'Cookie': `PHPSESSID=${String(authToken || '').trim()}`,
                'Content-Type': 'application/json'
            }
        });
        return { ok: response.ok, status: response.status, error: null };
    } catch (error) {
        return { ok: false, status: null, error: error.message };
    }
};

/**
 * The sweep can re-issue every tenant's ServiceTrade session, and CORS on this app is `*`.
 * So it is gated on a shared secret, and an unset secret CLOSES the route rather than
 * opening it — failing shut is the only safe default for something whose failure mode is
 * "anyone on the internet can churn every production login".
 *
 * The schedule lives in Supabase pg_cron, not vercel.json — the Vercel project is on Hobby,
 * which caps crons at one a day. db/supabase-servicetrade-session-sweep-cron.sql builds the
 * Authorization header from a Vault secret that must equal this CRON_SECRET.
 * `x-cron-secret` is there for calling it by hand.
 */
const authorizeSweep = (req, res) => {
    if (!config.cronSecret) {
        sendErrorResponse(res, 'CRON_SECRET is not configured — refusing to run the session sweep unauthenticated', 503);
        return false;
    }

    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const header = req.headers['x-cron-secret'] || '';
    if (bearer !== config.cronSecret && header !== config.cronSecret) {
        sendErrorResponse(res, 'Unauthorized', 401);
        return false;
    }
    return true;
};

/**
 * POST /auth/servicetrade/refresh
 *
 * Force a session check for one agent. Re-authenticates when the stored session is dead, or
 * when st_username/st_password changed after the token was issued.
 *
 * Body: { "agent_id": "agent_xxx" }
 */
router.post('/refresh', async (req, res) => {
    const { agent_id } = req.body;

    if (!agent_id) {
        return sendErrorResponse(res, 'agent_id is required', 400);
    }
    if (!agent_id.includes('agent_')) {
        return sendErrorResponse(res, 'agent_id should start with agent_', 400);
    }

    try {
        const rows = await supabaseService.getServiceTradeToken(agent_id);
        if (!rows || rows.length === 0) {
            return sendErrorResponse(res, `No ServiceTrade token found for agent ${agent_id}`, 404);
        }

        const result = await resolveSessionForRow(rows[0]);
        const probe = await probeTestEndpoint(result.token);

        return sendSuccessResponse(res, {
            agent_id,
            name: result.agentName,
            refreshed: result.outcome === 'healed',
            outcome: result.outcome,
            reason: result.reason,
            servicetrade_status: result.status,
            auth_token_before: maskToken(result.previousToken),
            auth_token_after: maskToken(result.token),
            test_endpoint: TEST_ENDPOINT,
            test_endpoint_status: probe.status,
            verified: probe.ok
        }, result.outcome === 'healed' ? 'Session renewed' : 'Session was already valid');
    } catch (error) {
        console.error(`❌ [${agent_id}] Session refresh failed:`, error.message);
        return sendErrorResponse(res, error.message, 500);
    }
});

/**
 * GET|POST /auth/servicetrade/refresh-all
 *
 * The scheduled sweep. Walks every row of servicetrade_tokens, proves each session against
 * ServiceTrade, renews the dead ones, then proves the result again against a real endpoint.
 *
 * Per-request healing (`resolveSession` in controllers/serviceTradeController) already keeps
 * a session alive for any tenant taking calls. This exists for the ones that are not: a
 * session dying overnight is otherwise found by the first caller of the morning, and the
 * whole point is that no request is ever the one that finds out.
 *
 * POST is what pg_net sends; GET is kept so it can be triggered from a browser or curl.
 */
const runSweep = async (req, res) => {
    if (!authorizeSweep(req, res)) return;

    const startedAt = Date.now();
    let rows;
    try {
        rows = await supabaseService.getAllServiceTradeTokens();
    } catch (error) {
        return sendErrorResponse(res, `Could not read servicetrade_tokens: ${error.message}`, 500);
    }

    const results = [];
    for (const row of rows) {
        const entry = {
            agent_id: row.agent_id,
            name: row.Name || null,
            st_username: row.st_username || null,
            has_credentials: Boolean(row.st_username && row.st_password),
            auth_token_before: maskToken(row.auth_token),
            auth_token_after: null,
            outcome: null,
            servicetrade_status: null,
            reason: null,
            test_endpoint_status: null,
            verified: false
        };

        try {
            const result = await resolveSessionForRow(row);
            entry.outcome = result.outcome;
            entry.reason = result.reason;
            entry.servicetrade_status = result.status;
            entry.auth_token_after = maskToken(result.token);

            const probe = await probeTestEndpoint(result.token);
            entry.test_endpoint_status = probe.status;
            entry.verified = probe.ok;

            if (!probe.ok) {
                entry.outcome = 'unverified';
                entry.reason = `${TEST_ENDPOINT} returned ${probe.status ?? probe.error}`;
            }
        } catch (error) {
            // resolveSessionForRow has already recorded the failure and alerted. The sweep
            // carries on: one tenant with bad credentials must not stop the others being
            // checked.
            entry.outcome = 'failed';
            entry.reason = error.message;
        }

        results.push(entry);
    }

    const summary = {
        checked: results.length,
        valid: results.filter((r) => r.outcome === 'valid').length,
        healed: results.filter((r) => r.outcome === 'healed').length,
        unverified: results.filter((r) => r.outcome === 'unverified').length,
        failed: results.filter((r) => r.outcome === 'failed').length,
        duration_ms: Date.now() - startedAt
    };

    console.log(`🔄 ServiceTrade session sweep: ${JSON.stringify(summary)}`);

    // One digest, not one email per tenant, and nothing at all when every session was already
    // valid — an hourly "all fine" is how an alert channel gets muted.
    const notable = results.filter((r) => r.outcome !== 'valid');
    if (notable.length > 0) {
        await emailNotificationService.sendInternalAlert({
            agentId: 'scheduled-sweep',
            companyName: `${notable.length} of ${results.length} ServiceTrade tenants`,
            errorType: 'Scheduled ServiceTrade session sweep',
            errorMessage: notable
                .map((r) => `${r.name || r.agent_id}: ${r.outcome} — ${r.reason || 'no detail'} (${r.auth_token_before} -> ${r.auth_token_after || 'unchanged'})`)
                .join(' | '),
            session: {
                oldToken: null,
                newToken: null,
                selfHealed: summary.failed === 0 && summary.unverified === 0,
                statusCode: null,
                reason: `healed ${summary.healed}, failed ${summary.failed}, unverified ${summary.unverified}, already valid ${summary.valid}`,
                verified: summary.failed === 0 && summary.unverified === 0
            }
        });
    }

    return sendSuccessResponse(res, { summary, results }, 'ServiceTrade session sweep complete');
};

router.get('/refresh-all', runSweep);
router.post('/refresh-all', runSweep);

/**
 * GET /auth/servicetrade/status
 *
 * Read-only. What the database currently believes about every tenant's session. Touches
 * ServiceTrade not at all, so it is cheap to poll and safe to open in a browser.
 */
router.get('/status', async (req, res) => {
    try {
        const rows = await supabaseService.getAllServiceTradeTokens();
        return sendSuccessResponse(res, {
            tenants: rows.map((row) => ({
                agent_id: row.agent_id,
                name: row.Name || null,
                st_username: row.st_username || null,
                can_self_heal: Boolean(row.st_username && row.st_password),
                auth_token: maskToken(row.auth_token),
                fingerprinted: Boolean(row.credentials_fingerprint),
                last_auth_status: row.last_auth_status ?? null,
                last_auth_checked_at: row.last_auth_checked_at ?? null,
                last_auth_error: row.last_auth_error ?? null,
                last_modified: row.last_modified ?? null
            }))
        }, 'ServiceTrade session status');
    } catch (error) {
        return sendErrorResponse(res, error.message, 500);
    }
});

module.exports = router;
