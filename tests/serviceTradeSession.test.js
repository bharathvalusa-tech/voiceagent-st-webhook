const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadWithMocks, REPO } = require('./harness');

/**
 * ServiceTrade session self-healing.
 *
 * Everything here is offline: globalThis.fetch is stubbed, and Supabase and SendGrid are
 * replaced through loadWithMocks. The status codes the stubs return are the ones the live
 * API actually returns — recorded 2026-09-11 against api.servicetrade.com:
 *
 *   GET  /api/auth      dead session     -> 404 "No active session found for given auth token"
 *   GET  /api/location  dead session     -> 401
 *   POST /api/auth      wrong password   -> 403 "Invalid credentials provided"
 *   POST /api/auth      success          -> 200, data.authToken == the Set-Cookie PHPSESSID
 */

const AGENT = 'agent_c4123a0589c456c9f19e369340';

const jsonResponse = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
});

const AUTH_OK = { data: { authenticated: true, authToken: 'live-session' } };
const AUTH_DEAD = {
    messages: { error: ['No active session found for given auth token'] },
    data: { authenticated: false, authToken: null }
};

// ------------------------------------------------------------------ checkSession

const loadService = () => {
    delete require.cache[require.resolve(path.join(REPO, 'src/services/serviceTradeService'))];
    return require(path.join(REPO, 'src/services/serviceTradeService'));
};

test('checkSession reads the 404 that ServiceTrade returns for a dead session as expired', async () => {
    const service = loadService();
    globalThis.fetch = async () => jsonResponse(404, AUTH_DEAD);

    const result = await service.checkSession('dead-token');

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.expired, true, '404 on GET /auth is the expiry signal, not 401');
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.reason, 'No active session found for given auth token');
});

test('checkSession treats a 200 that says authenticated:false as expired', async () => {
    const service = loadService();
    globalThis.fetch = async () => jsonResponse(200, { data: { authenticated: false } });

    const result = await service.checkSession('token');

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.expired, true, 'the body flag decides, not the status alone');
});

test('checkSession does NOT call an outage an expiry', async () => {
    const service = loadService();
    globalThis.fetch = async () => jsonResponse(503, {});

    const result = await service.checkSession('token');

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.expired, false, 'a 503 must not burn a login and replace a good token');
});

test('checkSession reports a network failure as unverified, not expired', async () => {
    const service = loadService();
    globalThis.fetch = async () => { throw new Error('ETIMEDOUT'); };

    const result = await service.checkSession('token');

    assert.strictEqual(result.expired, false);
    assert.strictEqual(result.reason, 'ETIMEDOUT');
});

test('checkSession accepts a live session and validateSession still returns a boolean', async () => {
    const service = loadService();
    globalThis.fetch = async () => jsonResponse(200, AUTH_OK);

    assert.strictEqual((await service.checkSession('good')).valid, true);
    assert.strictEqual(await service.validateSession('good'), true, 'existing callers depend on the boolean form');
});

test('checkSession refuses an empty stored token without calling ServiceTrade', async () => {
    const service = loadService();
    let called = false;
    globalThis.fetch = async () => { called = true; return jsonResponse(200, AUTH_OK); };

    const result = await service.checkSession('   ');

    assert.strictEqual(result.expired, true);
    assert.strictEqual(called, false);
});

// ------------------------------------------------------------------ reAuthenticate

test('reAuthenticate takes the token from the response body', async () => {
    const service = loadService();
    globalThis.fetch = async () => jsonResponse(200, { data: { authToken: 'body-token' } }, {
        'set-cookie': 'PHPSESSID=cookie-token; Path=/; Secure'
    });

    assert.strictEqual(await service.reAuthenticate('u', 'p'), 'body-token');
});

test('reAuthenticate falls back to Set-Cookie when the body carries no token', async () => {
    const service = loadService();
    globalThis.fetch = async () => jsonResponse(200, { data: { authenticated: true } }, {
        'set-cookie': 'PHPSESSID=cookie-token; Path=/; Secure'
    });

    assert.strictEqual(await service.reAuthenticate('u', 'p'), 'cookie-token');
});

test('reAuthenticate succeeds when Set-Cookie is stripped entirely', async () => {
    const service = loadService();
    // The regression this guards: a proxy that drops Set-Cookie used to turn a successful
    // login into "no PHPSESSID found in Set-Cookie header", leaving the tenant expired.
    globalThis.fetch = async () => jsonResponse(200, { data: { authToken: 'body-token' } });

    assert.strictEqual(await service.reAuthenticate('u', 'p'), 'body-token');
});

test('reAuthenticate trims whitespace off the token', async () => {
    const service = loadService();
    globalThis.fetch = async () => jsonResponse(200, { data: { authToken: 'padded-token\n' } });

    assert.strictEqual(await service.reAuthenticate('u', 'p'), 'padded-token');
});

test('reAuthenticate surfaces the 403 wrong-password message verbatim', async () => {
    const service = loadService();
    globalThis.fetch = async () => jsonResponse(403, {
        messages: { error: ['Invalid credentials provided'] }
    });

    await assert.rejects(
        () => service.reAuthenticate('u', 'wrong'),
        /403 .*Invalid credentials provided/,
        'the operator has to be able to tell a wrong password from an expired session'
    );
});

// ------------------------------------------------------------------ resolveSessionForRow

const crypto = require('crypto');
const fingerprint = (u, p) => crypto.createHash('sha256').update(`${u}\n${p}`).digest('hex');

/**
 * Load the controller with Supabase and SendGrid replaced, and record every write.
 */
const loadController = ({ sessionValid = true, newToken = 'fresh-token' } = {}) => {
    const writes = { updates: [], failures: [], valid: [], alerts: [] };

    const controller = loadWithMocks(path.join(REPO, 'src/controllers/serviceTradeController'), {
        '../services/serviceTradeService': {
            checkSession: async () => (sessionValid
                ? { valid: true, expired: false, status: 200, reason: null }
                : { valid: false, expired: true, status: 404, reason: 'No active session found for given auth token' }),
            reAuthenticate: async () => newToken
        },
        '../services/supabaseService': {
            credentialsFingerprint: fingerprint,
            updateAuthToken: async (agentId, token, opts) => { writes.updates.push({ agentId, token, opts }); },
            markAuthFailure: async (agentId, status, reason) => { writes.failures.push({ agentId, status, reason }); },
            recordSessionValid: async (agentId, opts) => { writes.valid.push({ agentId, opts }); },
            getServiceTradeToken: async () => []
        },
        '../services/emailNotificationService': {
            sendInternalAlert: async (payload) => { writes.alerts.push(payload); }
        },
        '../utils/phone': { normalizePhone: (v) => v }
    });

    return { controller, writes };
};

const row = (overrides = {}) => ({
    agent_id: AGENT,
    Name: 'Adaptive Climates Inc.',
    auth_token: 'stored-token',
    st_username: 'st-user-fixture',
    st_password: 'secret',
    credentials_fingerprint: fingerprint('st-user-fixture', 'secret'),
    ...overrides
});

test('a valid session is reused, and the row is stamped rather than re-authenticated', async () => {
    const { controller, writes } = loadController({ sessionValid: true });

    const result = await controller.resolveSessionForRow(row());

    assert.strictEqual(result.outcome, 'valid');
    assert.strictEqual(result.token, 'stored-token');
    assert.strictEqual(writes.updates.length, 0, 'no login should be spent on a live session');
    assert.strictEqual(writes.valid.length, 1);
    assert.strictEqual(writes.alerts.length, 0, 'a healthy session is not an alert');
});

test('an expired session is renewed, persisted, and reported with old and new token', async () => {
    const { controller, writes } = loadController({ sessionValid: false, newToken: 'fresh-token' });

    const result = await controller.resolveSessionForRow(row());

    assert.strictEqual(result.outcome, 'healed');
    assert.strictEqual(result.token, 'fresh-token');
    assert.strictEqual(result.previousToken, 'stored-token');
    assert.strictEqual(writes.updates[0].token, 'fresh-token');
    assert.strictEqual(writes.updates[0].opts.status, 'healed');

    const alert = writes.alerts[0];
    assert.ok(alert, 'the heal has to be reported');
    assert.strictEqual(alert.session.oldToken, 'stored-token');
    assert.strictEqual(alert.session.newToken, 'fresh-token');
    assert.strictEqual(alert.session.selfHealed, true);
    assert.strictEqual(alert.session.statusCode, 404);
});

test('changed credentials force a new login even though the stored session still validates', async () => {
    const { controller, writes } = loadController({ sessionValid: true, newToken: 'fresh-token' });

    // Fingerprint of the OLD password, still on the row after someone edited st_password.
    const result = await controller.resolveSessionForRow(row({
        credentials_fingerprint: fingerprint('st-user-fixture', 'the-old-password')
    }));

    assert.strictEqual(result.outcome, 'healed', 'a token minted by credentials that no longer exist must be replaced');
    assert.strictEqual(result.token, 'fresh-token');
    assert.strictEqual(writes.alerts[0].session.credentialsChanged, true);
});

test('a row that has never been fingerprinted is backfilled, not re-authenticated', async () => {
    const { controller, writes } = loadController({ sessionValid: true });

    const result = await controller.resolveSessionForRow(row({ credentials_fingerprint: null }));

    assert.strictEqual(result.outcome, 'valid', 'null means "never recorded", which is not "changed"');
    assert.strictEqual(writes.updates.length, 0);
    assert.strictEqual(writes.valid[0].opts.backfillFingerprint, true);
});

test('a stored token with a trailing newline is trimmed before use', async () => {
    const { controller } = loadController({ sessionValid: true });

    const result = await controller.resolveSessionForRow(row({ auth_token: 'padded-token\n' }));

    assert.strictEqual(result.token, 'padded-token', 'a newline in the token travels into the Cookie header');
});

test('no stored credentials means a loud failure and an alert that says why', async () => {
    const { controller, writes } = loadController({ sessionValid: false });

    await assert.rejects(
        () => controller.resolveSessionForRow(row({ st_username: null, st_password: null, credentials_fingerprint: null })),
        /no credentials are stored/
    );

    assert.strictEqual(writes.failures[0].status, 'no_credentials');
    assert.strictEqual(writes.alerts[0].session.selfHealed, false);
});

test('an unreachable ServiceTrade keeps the stored token instead of replacing it', async () => {
    const { writes } = loadController();
    const controller = loadWithMocks(path.join(REPO, 'src/controllers/serviceTradeController'), {
        '../services/serviceTradeService': {
            checkSession: async () => ({ valid: false, expired: false, status: 503, reason: '503 Service Unavailable' }),
            reAuthenticate: async () => { throw new Error('reAuthenticate must not be called during an outage'); }
        },
        '../services/supabaseService': {
            credentialsFingerprint: fingerprint,
            updateAuthToken: async () => { throw new Error('no write expected'); },
            markAuthFailure: async (agentId, status, reason) => { writes.failures.push({ agentId, status, reason }); },
            recordSessionValid: async () => {},
            getServiceTradeToken: async () => []
        },
        '../services/emailNotificationService': { sendInternalAlert: async () => {} },
        '../utils/phone': { normalizePhone: (v) => v }
    });

    const result = await controller.resolveSessionForRow(row());

    assert.strictEqual(result.token, 'stored-token');
    assert.strictEqual(writes.failures.at(-1).status, 'unverified');
});

// ------------------------------------------------------------------ alert email

test('the alert masks tokens by default and names both of them', async () => {
    const sent = [];
    const emailService = loadWithMocks(path.join(REPO, 'src/services/emailNotificationService'), {
        '@sendgrid/mail': { setApiKey: () => {}, send: async (mail) => { sent.push(mail); } },
        '../config/environment': {
            sendgridApiKey: 'SG.test',
            notificationEmailFrom: 'developer@justclara.ai',
            notificationEmailFromName: 'CLARA.AI',
            internalAlertRecipients: ['ops@justclara.ai'],
            alertTokensFull: false,
            matchingThresholds: { confidence: 80, fuzzySimilarity: 0.8, nameSimilarity: 0.6 }
        }
    });

    await emailService.sendInternalAlert({
        agentId: AGENT,
        companyName: 'Adaptive Climates Inc.',
        errorType: '404 — ServiceTrade session expired and was renewed',
        errorMessage: 'No active session found for given auth token',
        session: {
            oldToken: 'abcdefghijklmnopqrstuvwxyz',
            newToken: 'zyxwvutsrqponmlkjihgfedcba',
            selfHealed: true,
            statusCode: 404,
            reason: 'No active session found for given auth token'
        }
    });

    const mail = sent[0];
    assert.ok(mail, 'an alert should have been sent');
    assert.match(mail.subject, /CLARA RECOVERED.*404.*renewed automatically/);
    assert.match(mail.text, /auth_token before: abcd\.\.\.wxyz/);
    assert.match(mail.text, /auth_token after:  zyxw\.\.\.dcba/);
    assert.ok(!mail.text.includes('abcdefghijklmnopqrstuvwxyz'), 'a live PHPSESSID must not be emailed in full');
    assert.match(mail.html, /Session renewed by the backend/);
});

test('isSessionAuthError recognises every shape ServiceTrade rejects a session with', () => {
    const emailService = require(path.join(REPO, 'src/services/emailNotificationService'));

    assert.ok(emailService.isSessionAuthError('ServiceTrade API error: 401 Unauthorized'));
    assert.ok(emailService.isSessionAuthError('No active session found for given auth token'), '404 wording used to be missed entirely');
    assert.ok(emailService.isSessionAuthError('ServiceTrade re-auth failed: 403 Invalid credentials provided'));
    assert.ok(!emailService.isSessionAuthError('Customer not found'));
});
