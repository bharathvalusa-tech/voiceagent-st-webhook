const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadWithMocks, REPO } = require('./harness');

const OUTBOUND_AGENT = 'agent_c4123a0589c456c9f19e369340';
const baseConfig = require(path.join(REPO, 'src/config/environment'));

/**
 * A minimal fake of the supabase-js query builder, capturing what the store tried to do.
 *
 * Only the shapes escalationStore actually uses are modelled: from().select().eq()
 * .maybeSingle(), from().insert(), from().update().eq(), and rpc(). Anything else would be
 * asserting on a library rather than on our code.
 */
function fakeSupabase({ chainExists = false, callLog = { agent_id: 'agent_efbe' } } = {}) {
    const calls = { inserts: [], updates: [], rpcs: [], selects: [] };

    const table = (name) => ({
        select() {
            const q = {
                eq(col, val) { calls.selects.push({ table: name, col, val }); return q; },
                async maybeSingle() {
                    if (name === 'escalation_chains') {
                        return { data: chainExists ? { inbound_call_id: 'x' } : null, error: null };
                    }
                    return { data: callLog, error: null };
                }
            };
            return q;
        },
        async insert(row) { calls.inserts.push({ table: name, row }); return { error: null }; },
        update(patch) {
            return {
                async eq(col, val) {
                    calls.updates.push({ table: name, patch, col, val });
                    return { error: null };
                }
            };
        }
    });

    return {
        calls,
        client: {
            from: table,
            async rpc(fn, args) { calls.rpcs.push({ fn, args }); return { error: null }; }
        }
    };
}

function loadStore(fake, configOverrides = {}) {
    return loadWithMocks(path.join(REPO, 'src/services/escalationStore'), {
        '@supabase/supabase-js': { createClient: () => fake.client },
        './../config/environment': {
            ...baseConfig,
            escalationEmailAgentIds: [OUTBOUND_AGENT],
            ...configOverrides
        }
    });
}

// The store builds its own service-role client from the environment.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';

test('opening a chain resolves the tenant from call_logs, not from the payload', async () => {
    // inbound_agent_id is the key every dashboard read filters on. Trusting it from the
    // caller would let a chain be written against the wrong tenant.
    const fake = fakeSupabase({ callLog: { agent_id: 'agent_efbe503faedf1bf516f961979f' } });
    const store = loadStore(fake);

    await store.openEscalationChain({
        agentId: OUTBOUND_AGENT,
        inboundCallId: 'call_inbound_1',
        locationStatus: 'inactive'
    });

    assert.strictEqual(fake.calls.inserts.length, 1);
    const row = fake.calls.inserts[0].row;
    assert.strictEqual(row.inbound_call_id, 'call_inbound_1');
    assert.strictEqual(row.inbound_agent_id, 'agent_efbe503faedf1bf516f961979f');
    assert.strictEqual(row.outbound_agent_id, OUTBOUND_AGENT);
    assert.strictEqual(row.location_status, 'inactive');
    assert.deepStrictEqual(row.calls, []);
});

test('a call that is not in call_logs gets no chain', async () => {
    // The dashboard could never show it, so writing a chain would strand a row nothing
    // can read. This is also the second Adaptive guard.
    const fake = fakeSupabase({ callLog: null });
    const store = loadStore(fake);

    await store.openEscalationChain({ agentId: OUTBOUND_AGENT, inboundCallId: 'call_unknown' });

    assert.strictEqual(fake.calls.inserts.length, 0);
});

test('re-opening an existing chain refreshes the verdict but does not reset it', async () => {
    // The gate fires once, but a retry must not wipe legs already recorded.
    const fake = fakeSupabase({ chainExists: true });
    const store = loadStore(fake);

    await store.openEscalationChain({
        agentId: OUTBOUND_AGENT,
        inboundCallId: 'call_inbound_1',
        locationStatus: 'active'
    });

    assert.strictEqual(fake.calls.inserts.length, 0, 'must not insert a second row');
    assert.strictEqual(fake.calls.updates.length, 1);
    const patch = fake.calls.updates[0].patch;
    assert.strictEqual(patch.location_status, 'active');
    assert.ok(!('calls' in patch), 'must never overwrite the legs array');
    assert.ok(!('timeline' in patch));
});

test('a leg is merged through the RPC, never by read-modify-write', async () => {
    // `calls` has a second writer (clara enriching from Retell). Merging client-side
    // would race it and silently drop one side.
    const fake = fakeSupabase();
    const store = loadStore(fake);

    await store.recordEscalationLeg({
        agentId: OUTBOUND_AGENT,
        inboundCallId: 'call_inbound_1',
        outboundCallId: 'call_out_2',
        outcomeKey: 'declined_inactive',
        terminal: true,
        locationStatus: 'inactive'
    });

    assert.strictEqual(fake.calls.rpcs.length, 1);
    const { fn, args } = fake.calls.rpcs[0];
    assert.strictEqual(fn, 'escalation_merge_leg');
    assert.strictEqual(args.p_inbound_call_id, 'call_inbound_1');
    assert.strictEqual(args.p_leg.outbound_call_id, 'call_out_2');
    assert.strictEqual(args.p_leg.outcome_key, 'declined_inactive');
    assert.strictEqual(args.p_leg.terminal, true);
});

test('the job number is captured on the leg that created it', async () => {
    // This is the only moment job_number exists — ServiceTrade returned it a few frames
    // up, and nothing downstream (Retell included) can see it.
    const fake = fakeSupabase();
    const store = loadStore(fake);

    await store.recordEscalationLeg({
        agentId: OUTBOUND_AGENT,
        inboundCallId: 'call_inbound_1',
        outboundCallId: 'call_out_2',
        outcomeKey: 'created',
        terminal: true,
        jobNumber: 'J-10482'
    });

    const patch = fake.calls.updates.find((u) => u.patch.job_number);
    assert.ok(patch, 'job_number must be written');
    assert.strictEqual(patch.patch.job_number, 'J-10482');
    assert.strictEqual(patch.patch.is_job_created, true);
});

test('a leg with no job does not claim one', async () => {
    const fake = fakeSupabase();
    const store = loadStore(fake);

    await store.recordEscalationLeg({
        agentId: OUTBOUND_AGENT,
        inboundCallId: 'call_inbound_1',
        outboundCallId: 'call_out_1',
        outcomeKey: 'no_answer',
        terminal: false
    });

    for (const u of fake.calls.updates) {
        assert.ok(!('job_number' in u.patch), 'must not write a job number');
        assert.ok(!('is_job_created' in u.patch), 'must not flag a job as created');
    }
});

test('completion writes the sheet trail but never guesses completion_reason', async () => {
    // Telling a decline from an approved-but-failed job needs the terminal leg's outcome
    // key, which the reading side derives. A guess here would fight it.
    const fake = fakeSupabase();
    const store = loadStore(fake);
    const trail = '[26/08 09:15:41] location matched (Four Seasons) — dispatching';

    await store.completeEscalationChain({
        agent_id: OUTBOUND_AGENT,
        inbound_call_id: 'call_inbound_1',
        reason: 'created',
        outcome_trail: trail,
        is_job_created: 'true',
        job_number: 'J-10482'
    });

    assert.strictEqual(fake.calls.updates.length, 1);
    const patch = fake.calls.updates[0].patch;
    assert.strictEqual(patch.outcome_trail, trail);
    assert.strictEqual(patch.escalation_complete, true);
    assert.strictEqual(patch.is_job_created, true, 'the string "true" must coerce');
    assert.ok(!('completion_reason' in patch), 'completion_reason is derived on read');
});

test('an agent outside the escalation allowlist is never mirrored', async () => {
    const fake = fakeSupabase();
    const store = loadStore(fake);

    await store.openEscalationChain({ agentId: 'agent_someone_else', inboundCallId: 'call_x' });
    await store.recordEscalationLeg({
        agentId: 'agent_someone_else',
        inboundCallId: 'call_x',
        outboundCallId: 'call_y',
        outcomeKey: 'declined'
    });
    await store.completeEscalationChain({ agent_id: 'agent_someone_else', inbound_call_id: 'call_x' });

    assert.strictEqual(fake.calls.inserts.length, 0);
    assert.strictEqual(fake.calls.rpcs.length, 0);
    assert.strictEqual(fake.calls.updates.length, 0);
});

test('a missing call id is dropped rather than written as a keyless chain', async () => {
    const fake = fakeSupabase();
    const store = loadStore(fake);

    await store.openEscalationChain({ agentId: OUTBOUND_AGENT, inboundCallId: '' });
    await store.recordEscalationLeg({
        agentId: OUTBOUND_AGENT, inboundCallId: 'call_x', outboundCallId: ''
    });

    assert.strictEqual(fake.calls.inserts.length, 0);
    assert.strictEqual(fake.calls.rpcs.length, 0);
});

test('a database error never propagates to the caller', async () => {
    // The escalation does not depend on this record. A throw here would fail a live
    // escalation webhook and could stop a technician being dialled.
    const fake = fakeSupabase();
    fake.client.rpc = async () => ({ error: { message: 'permission denied' } });
    const store = loadStore(fake);

    await store.recordEscalationLeg({
        agentId: OUTBOUND_AGENT,
        inboundCallId: 'call_x',
        outboundCallId: 'call_y',
        outcomeKey: 'no_answer'
    });
});
