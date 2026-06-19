const express = require('express');
const router = express.Router();
const serviceTradeService = require('../../services/serviceTradeService');
const supabaseService = require('../../services/supabaseService');
const { sendSuccessResponse, sendErrorResponse } = require('../../utils/responseHelper');

/**
 * POST /auth/servicetrade/refresh
 * Manually trigger a session re-authentication for an agent.
 * Requires st_username and st_password to be set in servicetrade_tokens.
 *
 * Body: { "agent_id": "agent_xxx" }
 * Response: { "agent_id": "...", "refreshed": true }
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
        const tokenData = await supabaseService.getServiceTradeToken(agent_id);
        if (!tokenData || tokenData.length === 0) {
            return sendErrorResponse(res, `No ServiceTrade token found for agent ${agent_id}`, 404);
        }

        const { auth_token, st_username, st_password } = tokenData[0];

        // Check if session is still valid first
        const isValid = await serviceTradeService.validateSession(auth_token);
        if (isValid) {
            return sendSuccessResponse(res, { agent_id, refreshed: false }, 'Session is still valid — no refresh needed');
        }

        // Session expired — re-authenticate
        if (!st_username || !st_password) {
            return sendErrorResponse(
                res,
                `Session expired but no credentials stored for agent ${agent_id}. ` +
                `Set st_username and st_password in servicetrade_tokens to enable auto-reauth.`,
                422
            );
        }

        const newToken = await serviceTradeService.reAuthenticate(st_username, st_password);
        await supabaseService.updateAuthToken(agent_id, newToken);

        console.log(`✅ [${agent_id}] Manual refresh: new session stored.`);
        return sendSuccessResponse(res, { agent_id, refreshed: true }, 'Session refreshed successfully');

    } catch (error) {
        console.error(`❌ [${agent_id}] Session refresh failed:`, error.message);
        return sendErrorResponse(res, error.message, 500);
    }
});

module.exports = router;
