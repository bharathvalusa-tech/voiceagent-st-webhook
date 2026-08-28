const { createClient } = require('@supabase/supabase-js');
const config = require('./../config/environment');

/**
 * Mirrors the Adaptive Climates escalation into `escalation_chains` so the Clara dashboard
 * can show the dispatch timeline on the call record.
 *
 * This is a SIDE-CHANNEL. The Google Sheet remains the escalation state machine and the
 * ServiceTrade job still comes from the outbound post-call webhook; nothing here decides
 * anything. So every function below swallows its own failures — a dashboard write must
 * never fail an escalation webhook or delay a technician being dialled. Same contract as
 * notifySheet in routes/webhook/retellOutbound.js.
 *
 * Why this service writes at all, rather than posting to clara-lead-agent-server: two of
 * the facts the dashboard needs exist ONLY here, and only at the moment they happen —
 * `job_number` (from the ServiceTrade create) and the post-approval failure outcomes
 * (`no_match`, `error`, `inactive_job_failed`) that become "manual review". Retell cannot
 * see either. Writing straight to Postgres also means no public ingest endpoint and no
 * shared secret to keep in step.
 *
 * Scoped to config.escalationEmailAgentIds — the same allowlist that gates the
 * consolidated escalation email, so a tenant is either on this flow or off it.
 */

// A dedicated SERVICE-ROLE client, deliberately not the shared one in config/database.js.
// That client prefers SUPABASE_ANON_KEY, and `escalation_chains` has RLS enabled with no
// policy, so an anon write is denied outright. Kept separate so widening the privileges
// here cannot widen them for every other query in the service.
let client = null;
const getClient = () => {
    if (client) return client;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        console.warn('[escalation-store] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — dashboard mirror disabled');
        return null;
    }
    client = createClient(url, key, { auth: { persistSession: false } });
    return client;
};

const isEnabled = (agentId) =>
    Boolean(agentId) && config.escalationEmailAgentIds.includes(agentId);

/**
 * Open the chain.
 *
 * Called from the pre-flight location gate, which runs once per escalation and only for a
 * row that is genuinely about to dial — so this is also what makes "an escalation
 * happened" a well-defined statement. A call that never gets this far (not an emergency,
 * inside the alarm-monitor cooldown, no service address) has no row, and the dashboard
 * shows no escalation panel for it. Intended, not a gap.
 *
 * Idempotent: the gate fires once, but a retry must not reset a chain already
 * accumulating legs, so `calls` and `timeline` are only defaulted on insert.
 */
async function openEscalationChain({ agentId, inboundCallId, locationStatus }) {
    if (!isEnabled(agentId) || !inboundCallId) return;
    const db = getClient();
    if (!db) return;

    try {
        const { data: existing, error: readErr } = await db
            .from('escalation_chains')
            .select('inbound_call_id')
            .eq('inbound_call_id', inboundCallId)
            .maybeSingle();
        if (readErr) throw readErr;

        if (existing) {
            const { error } = await db
                .from('escalation_chains')
                .update({
                    outbound_agent_id: agentId,
                    location_status: locationStatus || null,
                    updated_at: new Date().toISOString()
                })
                .eq('inbound_call_id', inboundCallId);
            if (error) throw error;
            console.log(`[escalation-store] chain ${inboundCallId} already open — refreshed gate verdict`);
            return;
        }

        // inbound_agent_id is resolved from call_logs rather than trusted from here: it is
        // the tenancy key every dashboard read filters on, and looking it up is also what
        // stops a chain being written for a call the dashboard could never show.
        const { data: call, error: callErr } = await db
            .from('call_logs')
            .select('agent_id')
            .eq('call_id', inboundCallId)
            .maybeSingle();
        if (callErr) throw callErr;
        if (!call) {
            console.log(`[escalation-store] ${inboundCallId} not in call_logs — skipping chain`);
            return;
        }

        const { error } = await db.from('escalation_chains').insert({
            inbound_call_id: inboundCallId,
            inbound_agent_id: call.agent_id,
            outbound_agent_id: agentId,
            location_status: locationStatus || null,
            calls: [],
            timeline: [],
            first_call_at: new Date().toISOString()
        });
        if (error) throw error;
        console.log(`[escalation-store] opened chain ${inboundCallId}`);
    } catch (err) {
        console.error(`[escalation-store] openEscalationChain(${inboundCallId}) failed: ${err.message || err}`);
    }
}

/**
 * Record one dispatch call as it ends, so the dashboard fills in DURING the emergency
 * rather than only once the chain is over — an escalation runs 5-20 minutes.
 *
 * `outcomeKey` is the discriminator nothing else can supply: no-answer, voicemail and a
 * human declining all arrive with servicetrade_job_created = false, and only this handler
 * can tell them apart. `jobNumber` likewise exists only here, at creation time.
 *
 * Merged server-side via the escalation_merge_leg RPC. `calls` has a second writer
 * (clara-lead-agent-server enriching from Retell), so a read-modify-write from here would
 * race it and drop one side's update.
 */
async function recordEscalationLeg({
    agentId, inboundCallId, outboundCallId, outcomeKey, terminal, locationStatus, jobNumber
}) {
    if (!isEnabled(agentId) || !inboundCallId || !outboundCallId) return;
    const db = getClient();
    if (!db) return;

    try {
        // The merge is an UPDATE keyed on inbound_call_id: with no chain row it matches
        // nothing and the leg vanishes without an error. That is the worst failure this
        // module can have, because it loses an escalation call that really happened and
        // reports success. So make sure the row exists first.
        //
        // It normally does — the location gate opens it before the first dial — but the
        // gate can fail to reach us, and it also skips when the inbound call has not yet
        // landed in call_logs (a different pipeline fills that, so it can lag). By the time
        // a leg ends, call_logs has usually caught up, which makes this a natural retry.
        await openEscalationChain({ agentId, inboundCallId, locationStatus });

        const { error } = await db.rpc('escalation_merge_leg', {
            p_inbound_call_id: inboundCallId,
            p_leg: {
                outbound_call_id: outboundCallId,
                outcome_key: outcomeKey || null,
                terminal: Boolean(terminal),
                location_status: locationStatus || null
            }
        });
        if (error) throw error;

        // Chain-level facts from the same event. Written separately because they belong to
        // the chain, not the leg, and are last-write-wins by nature.
        const patch = { outbound_agent_id: agentId, updated_at: new Date().toISOString() };
        if (jobNumber) {
            patch.job_number = jobNumber;
            patch.is_job_created = true;
        }
        if (locationStatus) patch.location_status = locationStatus;

        const { error: patchErr } = await db
            .from('escalation_chains')
            .update(patch)
            .eq('inbound_call_id', inboundCallId);
        if (patchErr) throw patchErr;

        console.log(`[escalation-store] recorded leg ${outboundCallId} (${outcomeKey || 'no key'}) on ${inboundCallId}`);
    } catch (err) {
        console.error(`[escalation-store] recordEscalationLeg(${outboundCallId}) failed: ${err.message || err}`);
    }
}

/**
 * Settle the chain.
 *
 * `outcome_trail` is sheet column AA verbatim, and it is the only source for the
 * chain-level events — the location-gate verdict wording, the alarm-monitor cadence note,
 * cooldown suppression. clara-lead-agent-server parses it into the timeline.
 *
 * `completion_reason` is deliberately NOT set here: distinguishing a technician declining
 * from an approved-but-failed job needs the terminal leg's outcome key, which the reading
 * side already derives (deriveCompletionReason). Writing a guess here would fight it.
 *
 * Inserts the chain when none exists. Not every emergency dials: the 45-minute cooldown for
 * automated alarm callers and the no-address terminal both end the escalation before the
 * pre-flight gate that opens the chain, and both record why in column AA. This used to be an
 * UPDATE only, so those outcomes matched zero rows, wrote nothing, and still logged success —
 * the reason a suppressed emergency showed nothing at all on the dashboard.
 */
async function completeEscalationChain(body = {}) {
    const agentId = body.agent_id || body.agentId || '';
    const inboundCallId = body.inbound_call_id || body.call_id || '';
    if (!isEnabled(agentId) || !inboundCallId) return;
    const db = getClient();
    if (!db) return;

    try {
        const patch = {
            escalation_complete: true,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        if (body.outcome_trail) patch.outcome_trail = body.outcome_trail;
        if (body.location_status) patch.location_status = body.location_status;
        if (body.job_number) patch.job_number = body.job_number;
        if (body.is_job_created === true || body.is_job_created === 'true') {
            patch.is_job_created = true;
        }

        // Existence check before the write, the same shape openEscalationChain uses. An UPDATE
        // that matches nothing is not an error in PostgREST, so without this a terminal that
        // never dialled wrote nothing and still logged success.
        const { data: existing, error: existingErr } = await db
            .from('escalation_chains')
            .select('inbound_call_id')
            .eq('inbound_call_id', inboundCallId)
            .maybeSingle();
        if (existingErr) throw existingErr;

        if (!existing) {
            // The escalation ended before the first dial — cooldown suppression, or a call
            // that never captured a service address. Record it with no legs: the outcome
            // trail is the whole story, and the dashboard reads chain-level events from it
            // exactly as it does for a chain that dialled.
            const { data: call, error: callErr } = await db
                .from('call_logs')
                .select('agent_id')
                .eq('call_id', inboundCallId)
                .maybeSingle();
            if (callErr) throw callErr;
            if (!call) {
                console.log(`[escalation-store] ${inboundCallId} not in call_logs — skipping chain`);
                return;
            }

            const { error: insertErr } = await db.from('escalation_chains').insert({
                inbound_call_id: inboundCallId,
                inbound_agent_id: call.agent_id,
                outbound_agent_id: agentId,
                calls: [],
                timeline: [],
                first_call_at: null,
                ...patch
            });
            if (insertErr) throw insertErr;
            console.log(
                `[escalation-store] recorded no-dispatch chain ${inboundCallId} (${body.reason || 'no reason'})`
            );
            return;
        }

        const { error } = await db
            .from('escalation_chains')
            .update(patch)
            .eq('inbound_call_id', inboundCallId);
        if (error) throw error;

        // The Apps Script hands us the dispatch call ids it placed, so record any we do
        // not already have. Each leg is normally captured live from its own post-call
        // webhook; this closes the case where one of those never arrived, using the
        // escalation's own record of what it dialled.
        //
        // NOT a complete list: the sheet has three id slots and the third is reused from
        // the third attempt onward, so a four-attempt chain reports only three ids. It is
        // a floor, not a ceiling — clara-lead-agent-server reconciles against Retell for
        // the rest. The merge is keyed on outbound_call_id, so re-recording a leg already
        // captured live is a no-op rather than a duplicate.
        const ids = Array.isArray(body.response_call_ids) ? body.response_call_ids : [];
        for (const id of ids) {
            const outboundCallId = String(id || '').trim();
            if (!outboundCallId) continue;
            const { error: legErr } = await db.rpc('escalation_merge_leg', {
                p_inbound_call_id: inboundCallId,
                p_leg: { outbound_call_id: outboundCallId }
            });
            if (legErr) {
                console.warn(`[escalation-store] could not record leg ${outboundCallId}: ${legErr.message}`);
            }
        }

        console.log(`[escalation-store] completed chain ${inboundCallId} (${body.reason || 'no reason'}), ${ids.length} leg id(s) from the sheet`);
    } catch (err) {
        console.error(`[escalation-store] completeEscalationChain(${inboundCallId}) failed: ${err.message || err}`);
    }
}

module.exports = { openEscalationChain, recordEscalationLeg, completeEscalationChain };
