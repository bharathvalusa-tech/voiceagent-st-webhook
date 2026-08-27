const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');
const { loadWithMocks, REPO } = require('./harness');

const OUTBOUND_AGENT = 'agent_c4123a0589c456c9f19e369340';

/**
 * Mount POST /webhook/retell-outbound with ServiceTrade, Supabase, SendGrid and the
 * Apps Script notify all replaced, and capture what the handler tried to do.
 */
async function withWebhook(jobResult, run) {
    const notified = [];
    const alerts = [];

    // A real capture server, not a global.fetch swap: overriding global.fetch also
    // hijacks express/undici internals and makes the suite non-deterministic.
    const http = require('http');
    const sink = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            try { notified.push(JSON.parse(raw)); } catch { notified.push({ raw }); }
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
        });
    });
    sink.listen(0);
    await new Promise((r) => sink.once('listening', r));
    const sinkUrl = `http://127.0.0.1:${sink.address().port}/exec`;

    const router = loadWithMocks(path.join(REPO, 'src/routes/webhook/retellOutbound'), {
        // The dashboard mirror is stubbed out: this suite tests the webhook's own gate
        // logic, and the store holds a live service-role Supabase client. Without this the
        // suite would write test rows into the production escalation table.
        '../../services/escalationStore': {
            openEscalationChain: async () => {},
            recordEscalationLeg: async () => {},
            completeEscalationChain: async () => {}
        },
        '../../services/contextJobService': {
            createJobFromCallContext: async () => {
                if (jobResult instanceof Error) throw jobResult;
                return typeof jobResult === 'function' ? jobResult() : jobResult;
            }
        },
        '../../services/supabaseService': { getServiceTradeToken: async () => [{ Name: 'Adaptive' }] },
        '../../services/emailNotificationService': {
            sendJobNotification: async () => ({ sent: true }),
            sendInternalAlert: async (a) => { alerts.push(a); }
        },
        '../../config/environment': {
            ...require(path.join(REPO, 'src/config/environment')),
            adaptiveSheetExecUrl: sinkUrl
        }
    });

    const app = express();
    app.use(express.json());
    app.use('/webhook', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));

    try {
        return await run({ port: server.address().port, notified, alerts });
    } finally {
        server.close();
        sink.close();
    }
}

const payload = ({ approved, inactive, unmatched, callId = 'call_out_test' }) => ({
    event: 'call_analyzed',
    call: {
        call_id: callId,
        agent_id: OUTBOUND_AGENT,
        call_status: 'ended',
        disconnection_reason: 'user_hangup',
        retell_llm_dynamic_variables: {
            inbound_call_id: 'call_inbound_1',
            customer_name: 'Carlo Henry',
            customer_address: '9 Elmcrest Rd., Georgetown, ON',
            from_number: '+14169012663',
            call_summary: 'No heat',
            inactive_address: inactive ? 'true' : 'false',
            // Set by GAS when the pre-flight gate returned 'none'. The dispatch call is
            // placed anyway and the technician is told; this flag is how the post-call
            // webhook labels their answer without re-resolving anything.
            unmatched_address: unmatched ? 'true' : 'false'
        },
        call_analysis: { custom_analysis_data: { servicetrade_job_created: approved ? 'True' : 'False' } }
    }
});

const post = (port, body) => fetch(`http://127.0.0.1:${port}/webhook/retell-outbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

const created = (over = {}) => ({
    status: 'created',
    job: { jobId: 99, jobNumber: '49942168' },
    matchedLocationId: 6398701,
    matchedLocationName: '2213256 Ontario Ltd.',
    matchTier: 1,
    locationStatus: 'active',
    matchedAddress: '9 Elmcrest Rd., Georgetown, ON, L7G 4R8',
    ...over
});

test('tech approves on an INACTIVE location → job created, flagged, terminal', async () => {
    await withWebhook(created({ locationStatus: 'inactive' }), async ({ port, notified }) => {
        const res = await post(port, payload({ approved: true, inactive: true, callId: 'c1' }));
        assert.strictEqual(res.status, 201);

        const update = notified.at(-1);
        assert.strictEqual(update.is_job_created, true);
        assert.strictEqual(update.job_number, '49942168');
        assert.strictEqual(update.terminal, true);
        assert.strictEqual(update.location_status, 'inactive');
        assert.match(update.outcome, /job created on an INACTIVE ServiceTrade location/);
    });
});

test('tech DECLINES on an unmatched address → terminal, labelled, AD untouched', async () => {
    await withWebhook(created(), async ({ port, notified }) => {
        const res = await post(port, payload({ approved: false, unmatched: true, callId: 'cu1' }));
        assert.strictEqual(res.status, 200);

        const update = notified.at(-1);
        assert.strictEqual(update.is_job_created, false);
        // The whole point of requirement 4: a human answered and said no, so the chain
        // ends. No further contacts are dialled about this emergency.
        assert.strictEqual(update.terminal, true);
        assert.match(update.outcome, /address NOT on file in ServiceTrade/);
        // Blank, NOT 'none': handleJobUpdate only overwrites column AD on
        // 'active'/'inactive', so blank preserves the 'none' the gate already wrote.
        assert.strictEqual(update.location_status, '');
    });
});

test('tech APPROVES on an unmatched address → terminal, and asks for a manual job', async () => {
    // POST /job needs a locationId and there is none, so the approval cannot create the
    // job. It still ends the escalation and tells the office what a human must do.
    await withWebhook({ status: 'no_match' }, async ({ port, notified }) => {
        const res = await post(port, payload({ approved: true, unmatched: true, callId: 'cu2' }));
        assert.strictEqual(res.status, 200);

        const update = notified.at(-1);
        assert.strictEqual(update.is_job_created, false);
        assert.strictEqual(update.terminal, true);
        assert.match(update.outcome, /tech APPROVED/);
        assert.match(update.outcome, /create the job manually/);
    });
});

test('a decline with no location flags at all keeps the plain outcome', async () => {
    await withWebhook(created(), async ({ port, notified }) => {
        await post(port, payload({ approved: false, callId: 'cu3' }));

        const update = notified.at(-1);
        assert.strictEqual(update.outcome, 'no job — tech declined');
        assert.strictEqual(update.terminal, true);
    });
});

test('tech approves on an ACTIVE location → the ordinary created outcome', async () => {
    await withWebhook(created(), async ({ port, notified }) => {
        await post(port, payload({ approved: true, inactive: false, callId: 'c2' }));

        const update = notified.at(-1);
        assert.strictEqual(update.outcome, 'job created — tech approved');
        assert.strictEqual(update.location_status, 'active');
    });
});

test('tech declines on an INACTIVE location → no job, flagged, terminal', async () => {
    await withWebhook(created(), async ({ port, notified }) => {
        await post(port, payload({ approved: false, inactive: true, callId: 'c3' }));

        const update = notified.at(-1);
        assert.strictEqual(update.is_job_created, false);
        assert.strictEqual(update.terminal, true);
        assert.strictEqual(update.location_status, 'inactive');
        assert.match(update.outcome, /tech declined \(INACTIVE ServiceTrade location\)/);
    });
});

test('tech declines on an ACTIVE location → the ordinary declined outcome', async () => {
    await withWebhook(created(), async ({ port, notified }) => {
        await post(port, payload({ approved: false, inactive: false, callId: 'c4' }));

        const update = notified.at(-1);
        assert.strictEqual(update.outcome, 'no job — tech declined');
        assert.strictEqual(update.location_status, '');
    });
});

test('ServiceTrade refusing an inactive location gets its own outcome, not a generic error', async () => {
    await withWebhook(new Error('400 location is inactive'), async ({ port, notified }) => {
        const res = await post(port, payload({ approved: true, inactive: true, callId: 'c5' }));
        assert.strictEqual(res.status, 500);

        const update = notified.at(-1);
        assert.strictEqual(update.is_job_created, false);
        assert.strictEqual(update.terminal, true);
        assert.match(update.outcome, /ServiceTrade rejected the job on an INACTIVE location/);
    });
});

test('a generic creation failure keeps the generic error outcome', async () => {
    await withWebhook(new Error('supabase down'), async ({ port, notified }) => {
        await post(port, payload({ approved: true, inactive: false, callId: 'c6' }));
        assert.strictEqual(notified.at(-1).outcome, 'no job — error creating job');
    });
});

test('no answer and voicemail stay non-terminal so the ladder continues', async () => {
    await withWebhook(created(), async ({ port, notified }) => {
        const noAnswer = payload({ approved: false, inactive: false, callId: 'c7' });
        noAnswer.call.disconnection_reason = 'dial_no_answer';
        await post(port, noAnswer);
        assert.strictEqual(notified.at(-1).terminal, false);
        assert.match(notified.at(-1).outcome, /no answer/);

        const voicemail = payload({ approved: false, inactive: false, callId: 'c8' });
        voicemail.call.call_analysis.custom_analysis_data.reached_voicemail = 'True';
        await post(port, voicemail);
        assert.strictEqual(notified.at(-1).terminal, false);
        assert.match(notified.at(-1).outcome, /reached voicemail/);
    });
});

test('an unexpected throw reports terminal:true so the chain cannot hang', async () => {
    // Throw AFTER the inner try/catch around job creation, so only the outer catch runs.
    const exploding = () => ({ status: 'created', get job() { throw new Error('boom'); } });
    await withWebhook(exploding, async ({ port, notified }) => {
        const res = await post(port, payload({ approved: true, inactive: false, callId: 'c9' }));

        assert.strictEqual(res.status, 500);
        const update = notified.at(-1);
        assert.strictEqual(update.terminal, true, 'the outer catch must mark the row terminal');
        assert.strictEqual(update.outcome, 'no job — error creating job');
    });
});
