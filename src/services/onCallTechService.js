const config = require('../config/environment');

/**
 * The ServiceTrade user id of the technician currently on call.
 *
 * WHY THIS EXISTS. Jobs were being created with an appointment but no technician on it:
 * `createJob` accepts `techIds`, forwards them to the appointment
 * (serviceTradeService.createAppointment), and nothing ever passed any — so every
 * appointment landed unassigned and a dispatcher had to attach someone by hand.
 *
 * The rota is not static, so there is nothing to put in `servicetrade_job_configs`.
 * `/api/assignments` already resolves it — the same endpoint the inbound webhook uses to
 * fill the escalation sheet's technician columns — and the `id` it returns is a real
 * ServiceTrade user id (verified: 2173647235448386 is an active `isTech` user at Adaptive
 * Climates Inc.), so it can go straight into `techIds`.
 *
 * OPT-IN. With ONCALL_ASSIGNMENTS_URL unset this returns [] and job creation is byte
 * identical to before, so no other tenant is affected by a service that only knows about
 * one ServiceTrade job id.
 *
 * NEVER THROWS. An unassigned job is a dispatcher's five-second fix; a job that failed to
 * create because a lookup timed out is a missed emergency. Every failure path returns [].
 */
const ONCALL_TIMEOUT_MS = 8000;

const normalizeName = (value) => String(value || '').trim().toLowerCase();

// code.gs falls back to this label when the row has no technician name, and it still means
// "the person on duty" — so it matches the rota rather than failing to.
const GENERIC_ONCALL_LABEL = 'on-call technician';

/**
 * @param {string} [approvedByName]  Who actually took the dispatch call, from the outbound
 *   call's `contact_name`. Steps 1-3 of the ladder ring the on-call technician; steps 4-6
 *   ring John McLean and Alex Kovachev, who are escalation contacts rather than the
 *   technician for this shift. When one of THEM approves the job, it is created with no
 *   technician at all (owner's decision) rather than assigning someone who never took the
 *   call. Omit the argument to assign the on-call technician unconditionally.
 *
 *   Matched by NAME against the rota's own answer rather than a hardcoded list of
 *   fallback contacts, so adding or changing an escalation contact needs no change here.
 */
async function resolveOnCallTechIds(approvedByName) {
    const url = config.onCallAssignmentsUrl;
    if (!url) return [];

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(ONCALL_TIMEOUT_MS) });
        if (!res.ok) {
            console.warn(`[oncall-tech] assignments returned ${res.status} — job will be unassigned`);
            return [];
        }

        const body = await res.json();
        const assignments = Array.isArray(body && body.assignments) ? body.assignments : [];

        // `techs` is null-padded to two entries by the endpoint, so walk it rather than
        // indexing [0].
        for (const assignment of assignments) {
            const techs = (assignment && Array.isArray(assignment.techs)) ? assignment.techs : [];
            for (const tech of techs) {
                const id = tech && tech.id;
                if (id === null || id === undefined || id === '') continue;
                const numeric = Number(id);
                if (!Number.isFinite(numeric) || numeric <= 0) continue;

                const approver = normalizeName(approvedByName);
                const onCall = normalizeName(tech.name);
                if (approver && approver !== onCall && approver !== GENERIC_ONCALL_LABEL) {
                    console.log(`[oncall-tech] "${approvedByName}" approved, not on-call ${tech.name || 'technician'} — job left unassigned`);
                    return [];
                }

                console.log(`[oncall-tech] assigning ${tech.name || 'technician'} (${numeric})`);
                return [numeric];
            }
        }

        console.warn('[oncall-tech] nobody on duty right now — job will be unassigned');
        return [];
    } catch (error) {
        console.warn(`[oncall-tech] lookup failed: ${error.message || error} — job will be unassigned`);
        return [];
    }
}

module.exports = { resolveOnCallTechIds };
