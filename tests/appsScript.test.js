const test = require('node:test');
const assert = require('node:assert');
const { loadAppsScript } = require('./harness');

// Column indices mirror the COLUMNS map in google-sheet/code.gs.
const C = {
    TIMESTAMP: 0, CALL_ID: 1, CALL_SUMMARY: 6, TRANSCRIPT: 7, FROM_NUMBER: 8,
    CUSTOMER_NAME: 9, SERVICE_ADDRESS: 10, EMAIL: 12, OUTBOUND_TO_NUMBER: 14,
    TECH_NAME: 15, IS_EMERGENCY: 17, MAKE_CALL: 18, RESPONSE_CALL_ID_1: 19,
    RESPONSE_CALL_ID_2: 20, RESPONSE_CALL_ID_3: 21, CALL_DECLINE_COUNTER: 22,
    LAST_CALL_TIME: 23, ESCALATION_COMPLETE: 24, IS_EMAIL_SENT: 25, OUTCOME: 26,
    JOB_NUMBER: 27, IS_JOB_CREATED: 28, LOCATION_STATUS: 29
};

const emergencyRow = (overrides = {}) => {
    const row = Array(30).fill('');
    row[C.TIMESTAMP] = new Date('2026-08-14T10:00:00Z');
    row[C.CALL_ID] = 'call_inbound_1';
    row[C.CALL_SUMMARY] = 'No heat in the building';
    row[C.FROM_NUMBER] = '+14169012663';
    row[C.CUSTOMER_NAME] = 'Carlo Henry';
    row[C.SERVICE_ADDRESS] = '365 Evans Avenue, Toronto, ON';
    row[C.EMAIL] = 'tech@example.com';
    row[C.OUTBOUND_TO_NUMBER] = '+15551110000';
    row[C.TECH_NAME] = 'On-call Tech';
    row[C.IS_EMERGENCY] = true;
    row[C.MAKE_CALL] = true;
    row[C.CALL_DECLINE_COUNTER] = 0;
    row[C.ESCALATION_COMPLETE] = false;
    row[C.IS_JOB_CREATED] = false;
    Object.entries(overrides).forEach(([k, v]) => { row[C[k]] = v; });
    return row;
};

// Routes the three outbound calls code.gs makes: the location gate, SendGrid, Retell.
const router = (matchStatus, opts = {}) => (url) => {
    if (url.includes('st-match-location')) {
        return {
            code: 200,
            body: JSON.stringify({
                data: {
                    status: matchStatus,
                    matched: matchStatus !== 'none',
                    locationId: matchStatus === 'none' ? null : 6398701,
                    locationName: matchStatus === 'none' ? null : '2213256 Ontario Ltd.',
                    locationStatus: matchStatus === 'inactive' ? 'inactive' : 'active',
                    matchedAddress: '71 Todd Rd., Georgetown, ON, L7G 4R8'
                }
            })
        };
    }
    if (url.includes('sendgrid')) return { code: 202, body: '' };
    if (url.includes('create-phone-call')) return { code: 201, body: JSON.stringify({ call_id: 'call_out_1' }) };
    if (url.includes('st-escalation-complete')) return { code: opts.escalationCode || 200, body: '{}' };
    return { code: 200, body: '{}' };
};

const dispatchVars = (fetches) => {
    const call = fetches.find((f) => f.url.includes('create-phone-call'));
    return call ? JSON.parse(call.options.payload).retell_llm_dynamic_variables : null;
};

test('inactive location DISPATCHES instead of ending the escalation', () => {
    const env = loadAppsScript({ rows: [emergencyRow()], fetchHandler: router('inactive') });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const row = env.grid[0];
    assert.ok(env.fetches.some((f) => f.url.includes('create-phone-call')), 'a dispatch call must be placed');
    assert.strictEqual(row[C.RESPONSE_CALL_ID_1], 'call_out_1');
    assert.strictEqual(row[C.ESCALATION_COMPLETE], false, 'row must NOT be terminal');
    assert.strictEqual(row[C.MAKE_CALL], true, 'escalation must stay live');
    assert.strictEqual(row[C.LOCATION_STATUS], 'inactive');
    assert.match(String(row[C.OUTCOME]), /INACTIVE ServiceTrade location/);
    assert.match(String(row[C.OUTCOME]), /dispatching anyway/);
    assert.ok(
        !env.fetches.some((f) => f.url.includes('st-escalation-complete')),
        'no terminal notification while the chain is still running'
    );
});

test('inactive location puts inactive_address=true and a spoken note on the dispatch call', () => {
    const env = loadAppsScript({ rows: [emergencyRow()], fetchHandler: router('inactive') });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const vars = dispatchVars(env.fetches);
    assert.strictEqual(vars.inactive_address, 'true');
    assert.match(vars.location_status_note, /marked inactive in ServiceTrade/);
    assert.match(vars.location_status_note, /2213256 Ontario Ltd\./);
    assert.match(vars.location_status_note, /still log the job/);
});

test('active location sends inactive_address=false and an empty note', () => {
    const env = loadAppsScript({ rows: [emergencyRow()], fetchHandler: router('matched') });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const vars = dispatchVars(env.fetches);
    assert.strictEqual(vars.inactive_address, 'false');
    assert.strictEqual(vars.location_status_note, '');
    assert.strictEqual(env.grid[0][C.LOCATION_STATUS], 'active');
});

// Reversed deliberately. This used to assert "no location match is terminal and places
// no call", which meant nobody was ever dialled about the emergency — the office got an
// email and the caller got nothing. An address that is not on file is a bookkeeping gap,
// not evidence the emergency is fake, so the technician is dialled, told, and decides.
test('an unmatched address DISPATCHES instead of ending the escalation', () => {
    const env = loadAppsScript({ rows: [emergencyRow()], fetchHandler: router('none') });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const row = env.grid[0];
    assert.ok(env.fetches.some((f) => f.url.includes('create-phone-call')), 'a dispatch call must be placed');
    assert.strictEqual(row[C.RESPONSE_CALL_ID_1], 'call_out_1');
    assert.strictEqual(row[C.ESCALATION_COMPLETE], false, 'row must NOT be terminal');
    assert.strictEqual(row[C.MAKE_CALL], true, 'escalation must stay live');
    assert.strictEqual(row[C.LOCATION_STATUS], 'none');
    assert.match(String(row[C.OUTCOME]), /NOT on file/);
    // The client email is sent when the row reaches a terminal state, which this is not.
    assert.ok(!env.fetches.some((f) => f.url.includes('st-escalation-complete')),
        'no client email while the chain is still live');
});

test('an unmatched address puts unmatched_address=true and a spoken note on the dispatch call', () => {
    const env = loadAppsScript({ rows: [emergencyRow()], fetchHandler: router('none') });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const vars = dispatchVars(env.fetches);
    assert.strictEqual(vars.unmatched_address, 'true');
    assert.strictEqual(vars.inactive_address, 'false', 'the two flags are mutually exclusive');
    assert.match(vars.location_status_note, /not on file in ServiceTrade/);
});

test('an active location sends unmatched_address=false', () => {
    const env = loadAppsScript({ rows: [emergencyRow()], fetchHandler: router('matched') });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const vars = dispatchVars(env.fetches);
    assert.strictEqual(vars.unmatched_address, 'false');
    assert.strictEqual(vars.inactive_address, 'false');
    assert.strictEqual(vars.location_status_note, '');
});

// ------------------------------------------------- technician email redirection

const techMail = (env) => {
    const call = env.fetches.find((f) => f.url.includes('sendgrid'));
    return call ? JSON.parse(call.options.payload) : null;
};

test('TEST_NOTIFICATION_EMAIL alone redirects the technician email', () => {
    // Set on its own, with no test callers configured, it diverts EVERY row. This is the
    // testing mode: you receive what the on-call technician would have received.
    const env = loadAppsScript({
        rows: [emergencyRow()],
        fetchHandler: router('matched'),
        config: { TEST_NOTIFICATION_EMAIL: 'tester@example.com', TEST_OVERRIDE_NUMBERS: [] }
    });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const mail = techMail(env);
    assert.ok(mail, 'the email is still sent');
    assert.strictEqual(mail.personalizations[0].to[0].email, 'tester@example.com');
    assert.strictEqual(mail.personalizations[0].cc, undefined,
        'CC is suppressed so the client addresses never get a brief the tech did not');
    assert.match(mail.subject, /\[REDIRECTED — REAL EMERGENCY\]/,
        'a diverted REAL row must be unmistakable in the inbox');
});

test('with no test inbox set, the real technician is emailed and CC applies', () => {
    const env = loadAppsScript({
        rows: [emergencyRow()],
        fetchHandler: router('matched'),
        config: { TEST_NOTIFICATION_EMAIL: '', TEST_OVERRIDE_NUMBERS: [] }
    });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const mail = techMail(env);
    assert.notStrictEqual(mail.personalizations[0].to[0].email, 'tester@example.com');
    assert.ok(mail.personalizations[0].cc && mail.personalizations[0].cc.length > 0,
        'production keeps the CC list');
    assert.ok(!/REDIRECTED/.test(mail.subject));
});

test('a test number with no inbox configured sends nothing at all', () => {
    // Fails closed on purpose: falling back to the real technician would page them for
    // what the tester meant to keep to themselves.
    const env = loadAppsScript({
        rows: [emergencyRow()],
        fetchHandler: router('matched'),
        config: { TEST_NOTIFICATION_EMAIL: '', TEST_OVERRIDE_NUMBERS: ['+14169012663'] }
    });
    const sent = env.sandbox.sendTechnicianEmergencyEmail(
        'realtech@adaptiveclimates.com', 'Real Tech', 'Carlo', '71 Todd Rd',
        '+14169012663', 'No heat', 'transcript', 'call_1', new Date().toISOString(), 'active'
    );

    assert.strictEqual(sent, false);
    assert.ok(!env.fetches.some((f) => f.url.includes('sendgrid')), 'no email leaves the building');
});

test('one knob does everything: call routing, both emails, and the row tag', () => {
    // TEST_OVERRIDE_NUMBERS is the single switch. A call from a listed number must dial
    // that number back, tag the row, and divert both emails — with nothing else set.
    const env = loadAppsScript({
        rows: [emergencyRow()],
        fetchHandler: router('matched'),
        config: {
            TEST_OVERRIDE_NUMBERS: ['+14169012663'],
            TEST_NOTIFICATION_EMAIL: 'tester@example.com'
        }
    });

    // The ladder dials the test number, never the real contact.
    const target = env.sandbox.getCallTarget(1, 0, '+14165551234', 'Real Tech', '+14169012663');
    assert.strictEqual(target.phone, '+14169012663', 'the test number is dialled');
    assert.strictEqual(target.name, 'Real Tech', 'the contact name is kept for the trail');

    // The technician email goes to the test inbox only.
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);
    const mail = techMail(env);
    assert.strictEqual(mail.personalizations[0].to[0].email, 'tester@example.com');
    assert.strictEqual(mail.personalizations[0].cc, undefined);

    // And the client email carries the test inbox to the endpoint that sends it.
    env.sandbox.notifyEscalationComplete(env.sheet, 2, 'created');
    const notify = env.fetches.find((f) => f.url.includes('st-escalation-complete'));
    assert.ok(notify, 'the endpoint is notified');
    assert.strictEqual(JSON.parse(notify.options.payload).test_email, 'tester@example.com');
});

test('a real row carries no test_email, so the client email is untouched', () => {
    const env = loadAppsScript({
        rows: [emergencyRow()],
        fetchHandler: router('matched'),
        config: { TEST_OVERRIDE_NUMBERS: [], TEST_NOTIFICATION_EMAIL: '' }
    });
    env.sandbox.notifyEscalationComplete(env.sheet, 2, 'created');

    const notify = env.fetches.find((f) => f.url.includes('st-escalation-complete'));
    assert.strictEqual(JSON.parse(notify.options.payload).test_email, '');
});

test('a test row with no inbox sends NO client email at all', () => {
    // Fails closed. Emailing the real client about a test emergency is the worst outcome.
    const env = loadAppsScript({
        rows: [emergencyRow()],
        fetchHandler: router('matched'),
        config: { TEST_OVERRIDE_NUMBERS: ['+14169012663'], TEST_NOTIFICATION_EMAIL: '' }
    });
    env.sandbox.notifyEscalationComplete(env.sheet, 2, 'created');

    assert.ok(!env.fetches.some((f) => f.url.includes('st-escalation-complete')),
        'the endpoint is never called, so the real client cannot be emailed');
});

test('the technician email is subject-flagged when the address is not on file', () => {
    const env = loadAppsScript({ rows: [emergencyRow()], fetchHandler: router('none') });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const mail = env.fetches.find((f) => f.url.includes('sendgrid'));
    assert.ok(mail, 'a technician email must be sent');
    assert.match(JSON.parse(mail.options.payload).subject, /\[ADDRESS NOT ON FILE\]/);
});

test('gate failure fails open, dials, and says so in the trail', () => {
    const env = loadAppsScript({
        rows: [emergencyRow()],
        fetchHandler: (url) => (url.includes('st-match-location')
            ? { code: 500, body: 'boom' }
            : router('matched')(url))
    });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    assert.ok(env.fetches.some((f) => f.url.includes('create-phone-call')));
    assert.strictEqual(env.grid[0][C.LOCATION_STATUS], 'failed_open');
    assert.match(String(env.grid[0][C.OUTCOME]), /failed open/);
});

test('later ladder steps repeat the inactive note from column AD', () => {
    const env = loadAppsScript({
        rows: [emergencyRow({
            RESPONSE_CALL_ID_1: 'call_out_1',
            CALL_DECLINE_COUNTER: 1,
            LAST_CALL_TIME: new Date(Date.now() - 60 * 60 * 1000),
            LOCATION_STATUS: 'inactive'
        })],
        fetchHandler: (url) => {
            if (url.includes('get-call')) {
                return { code: 200, body: JSON.stringify({ call_status: 'ended', disconnection_reason: 'dial_no_answer' }) };
            }
            return router('inactive')(url);
        }
    });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const vars = dispatchVars(env.fetches);
    assert.ok(vars, 'step 2 must dial');
    assert.strictEqual(vars.inactive_address, 'true');
    assert.match(vars.location_status_note, /marked inactive in ServiceTrade/);
});

test('outcome lines carry a timestamp', () => {
    const env = loadAppsScript({ rows: [emergencyRow()] });
    env.sandbox.appendOutcome(env.sheet, 2, 'call1 - answered');

    assert.match(String(env.grid[0][C.OUTCOME]), /^\[\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\] call1 - answered$/);
});

test('timestamps do not defeat exact-duplicate suppression', () => {
    const env = loadAppsScript({ rows: [emergencyRow()] });
    env.sandbox.appendOutcome(env.sheet, 2, 'call1 - no job — tech declined');
    env.sandbox.appendOutcome(env.sheet, 2, 'call1 - no job — tech declined');
    env.sandbox.appendOutcome(env.sheet, 2, 'call1 - no job — tech declined');

    const lines = String(env.grid[0][C.OUTCOME]).split('\n');
    assert.strictEqual(lines.length, 1, `expected 1 line, got ${lines.length}: ${JSON.stringify(lines)}`);
});

test('a genuinely different line is still appended', () => {
    const env = loadAppsScript({ rows: [emergencyRow()] });
    env.sandbox.appendOutcome(env.sheet, 2, 'call1 - answered');
    env.sandbox.appendOutcome(env.sheet, 2, 'call1 - no job — tech declined');

    assert.strictEqual(String(env.grid[0][C.OUTCOME]).split('\n').length, 2);
});

test('an unstamped legacy line is not re-appended after stamping was added', () => {
    const env = loadAppsScript({ rows: [emergencyRow({ OUTCOME: 'call1 - answered' })] });
    env.sandbox.appendOutcome(env.sheet, 2, 'call1 - answered');

    assert.strictEqual(String(env.grid[0][C.OUTCOME]), 'call1 - answered');
});

test('handleJobUpdate creates the job on an inactive location and records the flag', () => {
    const env = loadAppsScript({
        rows: [emergencyRow({ RESPONSE_CALL_ID_1: 'call_out_1', CALL_DECLINE_COUNTER: 1, LOCATION_STATUS: 'inactive' })],
        fetchHandler: router('inactive')
    });

    env.sandbox.handleJobUpdate({
        action: 'job_update',
        inbound_call_id: 'call_inbound_1',
        outbound_call_id: 'call_out_1',
        is_job_created: true,
        job_number: '49942168',
        outcome: 'job created on an INACTIVE ServiceTrade location — tech approved; office review needed',
        terminal: true,
        location_status: 'inactive'
    });

    const row = env.grid[0];
    assert.strictEqual(row[C.IS_JOB_CREATED], true);
    assert.strictEqual(row[C.JOB_NUMBER], '49942168');
    assert.strictEqual(row[C.LOCATION_STATUS], 'inactive');
    assert.strictEqual(row[C.ESCALATION_COMPLETE], true);
    assert.match(String(row[C.OUTCOME]), /JOB CREATED #49942168/);

    const notify = env.fetches.find((f) => f.url.includes('st-escalation-complete'));
    assert.ok(notify, 'client email must be triggered');
    assert.strictEqual(JSON.parse(notify.options.payload).location_status, 'inactive');
});

test('the post-call location status overrides the pre-flight verdict', () => {
    const env = loadAppsScript({
        rows: [emergencyRow({ RESPONSE_CALL_ID_1: 'call_out_1', CALL_DECLINE_COUNTER: 1, LOCATION_STATUS: 'active' })],
        fetchHandler: router('matched')
    });

    env.sandbox.handleJobUpdate({
        action: 'job_update', inbound_call_id: 'call_inbound_1', outbound_call_id: 'call_out_1',
        is_job_created: true, job_number: '1', outcome: 'job created', terminal: true,
        location_status: 'inactive'
    });

    assert.strictEqual(env.grid[0][C.LOCATION_STATUS], 'inactive');
});

test('a blank location_status leaves column AD untouched', () => {
    const env = loadAppsScript({
        rows: [emergencyRow({ RESPONSE_CALL_ID_1: 'call_out_1', CALL_DECLINE_COUNTER: 1, LOCATION_STATUS: 'inactive' })],
        fetchHandler: router('inactive')
    });

    env.sandbox.handleJobUpdate({
        action: 'job_update', inbound_call_id: 'call_inbound_1', outbound_call_id: 'call_out_1',
        is_job_created: false, job_number: '', outcome: 'no job — no answer; nobody reached', terminal: false
    });

    assert.strictEqual(env.grid[0][C.LOCATION_STATUS], 'inactive');
});

test('a repeated job_update is ignored and writes no second trail line', () => {
    const env = loadAppsScript({
        rows: [emergencyRow({ RESPONSE_CALL_ID_1: 'call_out_1', CALL_DECLINE_COUNTER: 1 })],
        fetchHandler: router('matched')
    });
    const payload = {
        action: 'job_update', inbound_call_id: 'call_inbound_1', outbound_call_id: 'call_out_1',
        is_job_created: true, job_number: '49942168', outcome: 'job created — tech approved', terminal: true
    };

    env.sandbox.handleJobUpdate(payload);
    const second = env.sandbox.handleJobUpdate(payload);
    const third = env.sandbox.handleJobUpdate(payload);

    assert.strictEqual(JSON.parse(second.getContent()).status, 'ignored_duplicate');
    assert.strictEqual(JSON.parse(third.getContent()).status, 'ignored_duplicate');
    const created = String(env.grid[0][C.OUTCOME]).split('\n').filter((l) => l.includes('JOB CREATED'));
    assert.strictEqual(created.length, 1, `expected 1 JOB CREATED line, got ${created.length}`);
});

test('voicemail keeps the chain alive; a decline ends it', () => {
    const mk = () => loadAppsScript({
        rows: [emergencyRow({ RESPONSE_CALL_ID_1: 'call_out_1', CALL_DECLINE_COUNTER: 1 })],
        fetchHandler: router('matched')
    });

    const vm = mk();
    vm.sandbox.handleJobUpdate({
        action: 'job_update', inbound_call_id: 'call_inbound_1', outbound_call_id: 'call_out_1',
        is_job_created: false, job_number: '', outcome: 'no job — reached voicemail; no technician contact',
        terminal: false
    });
    assert.strictEqual(vm.grid[0][C.ESCALATION_COMPLETE], false, 'voicemail must not be terminal');

    const dec = mk();
    dec.sandbox.handleJobUpdate({
        action: 'job_update', inbound_call_id: 'call_inbound_1', outbound_call_id: 'call_out_1',
        is_job_created: false, job_number: '', outcome: 'no job — tech declined (INACTIVE ServiceTrade location)',
        terminal: true
    });
    assert.strictEqual(dec.grid[0][C.ESCALATION_COMPLETE], true, 'a decline must be terminal');
});

test('classifyCall treats every voicemail signal as no-answer', () => {
    const env = loadAppsScript({ rows: [emergencyRow()] });
    const cases = [
        ['disconnection_reason=voicemail_reached', { call_status: 'ended', disconnection_reason: 'voicemail_reached' }],
        ['call_analysis.in_voicemail', { call_status: 'ended', disconnection_reason: 'user_hangup', call_analysis: { in_voicemail: true } }],
        ['agent verdict reached_voicemail', { call_status: 'ended', disconnection_reason: 'user_hangup', call_analysis: { custom_analysis_data: { reached_voicemail: 'true' } } }],
        ['untagged 8s greeting', { call_status: 'ended', disconnection_reason: 'unknown_reason', duration_ms: 8000, call_analysis: { in_voicemail: true } }]
    ];
    for (const [label, call] of cases) {
        assert.strictEqual(env.sandbox.classifyCall(call), 'no_answer', label);
    }
    assert.strictEqual(
        env.sandbox.classifyCall({ call_status: 'ended', disconnection_reason: 'user_hangup' }),
        'answered',
        'a real pickup is still answered'
    );
});

test('a blank service address is terminal before any dial', () => {
    const env = loadAppsScript({ rows: [], fetchHandler: router('matched') });
    env.sandbox.doPost({
        postData: {
            contents: JSON.stringify({
                call_id: 'call_no_addr', direction: 'inbound', isitEmergency: 'TRUE',
                customerName: 'Someone', fromNumber: '+14169012663', serviceAddress: '',
                email: 'tech@example.com', phone: '+15551110000', techName: 'Tech'
            })
        }
    });

    const row = env.grid[0];
    assert.ok(row, 'a row must be created');
    assert.strictEqual(row[C.ESCALATION_COMPLETE], true);
    assert.strictEqual(row[C.MAKE_CALL], false);
    assert.ok(!env.fetches.some((f) => f.url.includes('create-phone-call')), 'no dispatch call');
    assert.match(String(row[C.OUTCOME]), /service address/i);
});

test('exactly one technician email goes out, to the on-call tech', () => {
    const env = loadAppsScript({ rows: [emergencyRow()], fetchHandler: router('inactive') });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const mails = env.fetches.filter((f) => f.url.includes('sendgrid'));
    assert.strictEqual(mails.length, 1, `expected 1 technician email, got ${mails.length}`);
    const body = JSON.parse(mails[0].options.payload);
    const recipients = body.personalizations[0].to.map((t) => t.email);
    assert.deepStrictEqual(recipients, ['tech@example.com']);
    assert.match(body.subject, /^\[INACTIVE LOCATION\] /, `subject was: ${body.subject}`);
});

test('an active location gets no inactive prefix on the technician email', () => {
    const env = loadAppsScript({ rows: [emergencyRow()], fetchHandler: router('matched') });
    env.sandbox.processEscalationRowWithEmail(env.sheet, 2, env.grid[0]);

    const mail = env.fetches.find((f) => f.url.includes('sendgrid'));
    assert.ok(!JSON.parse(mail.options.payload).subject.includes('INACTIVE'));
});
