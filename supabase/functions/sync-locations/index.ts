// Hourly ServiceTrade -> Supabase location mirror, as a Supabase Edge Function.
//
// Scheduled by pg_cron (db/supabase-sync-locations-cron.sql). There is deliberately
// NO bespoke shared secret: Supabase verifies the JWT on this function's URL, so the
// pg_cron job authenticates with the project's own service-role key and nothing new
// has to be invented, stored in two places, or rotated in lockstep.
//
// The Node service (voiceagent-st-webhook) only READS the mirror, as the phone-index
// fallback when ServiceTrade is unreachable. This function is the only writer.
//
// Deploy (the `supabase login` access token authenticates YOU to the Management API —
// it is a developer credential, nothing the function itself uses at runtime):
//   supabase login
//   supabase link --project-ref tpvserzjhmyxjssabokm
//   supabase functions deploy sync-locations
//   supabase secrets set LOCATION_SYNC_AGENT_IDS="agent_efbe503faedf1bf516f961979f"
//
// Run by hand:
//   curl -X POST https://<ref>.supabase.co/functions/v1/sync-locations \
//        -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
//        -H "Content-Type: application/json" -d '{"full":true}'

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const ST_BASE = 'https://api.servicetrade.com/api';

// Re-fetch a little of what we already have. Absorbs clock skew between ServiceTrade
// and this function, and a single missed run, at the cost of re-upserting a handful of
// unchanged rows.
const WATERMARK_OVERLAP_SECONDS = 2 * 60 * 60;

type Tenant = {
  // The agent id the mirrored rows are keyed by. The ONLY thing that has to be
  // configured; everything below is derived.
  agentId: string;
  // `company_id` is NOT NULL on both tables and is NOT ServiceTrade's company id
  // (that arrives per record as servicetrade_company_id). It is read off the rows
  // already stored for this agent rather than declared — `public.companies` disagrees
  // with the mirror for 3 of 5 agents, so it is not a usable source.
  companyId: number;
  // Which servicetrade_tokens row to authenticate with. Resolved by shared
  // `st_username`, preferring a row whose session is already live — see
  // resolveSessionAgent() for why minting a second session would be dangerous.
  stAgentId: string;
};

function parseAgentIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Everything the sync needs for one agent, read out of the data.
 *
 * Returns null when the agent has no mirrored rows: `company_id` is NOT NULL and there
 * is nothing to infer it from, so a brand-new tenant needs its first rows seeded by
 * hand rather than guessed at here.
 */
async function deriveTenant(db: SupabaseClient, agentId: string): Promise<Tenant | null> {
  const { data, error } = await db
    .from('servicetrade_locations')
    .select('company_id')
    .eq('agent_id', agentId)
    .limit(1);

  if (error) throw new Error(`company_id lookup failed for ${agentId}: ${error.message}`);
  if (!data || data.length === 0 || data[0].company_id === null) {
    console.error(`[sync-locations] ${agentId}: no mirrored rows, so no company_id to derive — skipping`);
    return null;
  }

  const stAgentId = await resolveSessionAgent(db, agentId);
  return { agentId, companyId: Number(data[0].company_id), stAgentId };
}

/**
 * Which agent's token row to authenticate as.
 *
 * ServiceTrade appears to allow ONE session per user: the Adaptive inbound and outbound
 * agents share an `st_username`, and the inbound row's session is dead while the
 * outbound row's is live — consistent with the later login having invalidated the
 * earlier one. So logging in as the mirror agent could kill the session the live call
 * path is using, mid-emergency.
 *
 * Therefore: among every token row sharing this agent's username, prefer one whose
 * session already validates and reuse it. Re-authenticate only when none does, and then
 * against the row that was already the freshest candidate.
 */
async function resolveSessionAgent(db: SupabaseClient, agentId: string): Promise<string> {
  const { data: own, error: ownError } = await db
    .from('servicetrade_tokens')
    .select('st_username')
    .eq('agent_id', agentId)
    .limit(1);
  if (ownError) throw new Error(`token read failed for ${agentId}: ${ownError.message}`);

  const username = own?.[0]?.st_username;
  if (!username) return agentId;

  const { data: siblings, error } = await db
    .from('servicetrade_tokens')
    .select('agent_id, auth_token')
    .eq('st_username', username);
  if (error) throw new Error(`sibling token read failed: ${error.message}`);

  for (const row of siblings || []) {
    if (!row.auth_token) continue;
    const probe = await fetch(`${ST_BASE}/auth`, {
      method: 'GET',
      headers: { Cookie: `PHPSESSID=${row.auth_token}`, 'Content-Type': 'application/json' }
    });
    if (probe.ok) {
      if (row.agent_id !== agentId) {
        console.log(`[sync-locations] ${agentId}: reusing the live session on ${row.agent_id} (same st_username)`);
      }
      return row.agent_id;
    }
  }

  console.log(`[sync-locations] ${agentId}: no live session among ${(siblings || []).length} row(s) for this user — will re-authenticate`);
  return agentId;
}

// --------------------------------------------------------------- ServiceTrade auth

/**
 * A usable PHPSESSID for this agent.
 *
 * Mirrors the Node service's getAuthToken: validate the stored session, and only
 * re-authenticate when it has actually expired. Both runtimes write back to the same
 * `servicetrade_tokens` row, so the validate-first order matters — it keeps a healthy
 * session shared instead of each side minting a new one and invalidating the other's.
 */
async function getAuthToken(db: SupabaseClient, agentId: string): Promise<string> {
  const { data, error } = await db
    .from('servicetrade_tokens')
    .select('auth_token, st_username, st_password')
    .eq('agent_id', agentId)
    .limit(1);

  if (error) throw new Error(`servicetrade_tokens read failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`no servicetrade_tokens row for ${agentId}`);

  const { auth_token, st_username, st_password } = data[0];

  const probe = await fetch(`${ST_BASE}/auth`, {
    method: 'GET',
    headers: { Cookie: `PHPSESSID=${auth_token}`, 'Content-Type': 'application/json' }
  });
  if (probe.ok) return auth_token;

  console.log(`[sync-locations] ${agentId}: session expired, re-authenticating`);
  if (!st_username || !st_password) {
    throw new Error(
      `session expired for ${agentId} and no credentials stored — ` +
      `set st_username and st_password in servicetrade_tokens`
    );
  }

  const res = await fetch(`${ST_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: st_username, password: st_password })
  });
  if (!res.ok) {
    throw new Error(`ServiceTrade re-auth failed: ${res.status} ${res.statusText}`);
  }

  const match = (res.headers.get('set-cookie') || '').match(/PHPSESSID=([^;]+)/);
  if (!match) throw new Error('re-auth succeeded but no PHPSESSID in Set-Cookie');

  const { error: writeError } = await db
    .from('servicetrade_tokens')
    .update({ auth_token: match[1] })
    .eq('agent_id', agentId);
  if (writeError) throw new Error(`token write-back failed: ${writeError.message}`);

  return match[1];
}

// ------------------------------------------------------------- ServiceTrade fetches

/**
 * Paged fetch of one collection.
 *
 * THE FILTER NAME IS LOAD-BEARING. `updatedAfter` is what ServiceTrade honours —
 * measured on the Adaptive account, 24 of 394 locations for the last 30 days, and 6
 * of 382 companies. `updatedSince` returns EVERYTHING and `updated_after` returns a
 * 500. Unknown query params are dropped silently, so a misspelling degrades to a full
 * fetch that still looks like a working incremental sync. Pass `epoch = null` to fetch
 * everything deliberately.
 */
async function fetchPaged(
  authToken: string,
  collection: 'location' | 'company',
  epoch: number | null
): Promise<Record<string, any>[]> {
  const headers = { Cookie: `PHPSESSID=${authToken}`, 'Content-Type': 'application/json' };
  const filter = epoch && epoch > 0 ? `&updatedAfter=${Math.floor(epoch)}` : '';
  const key = collection === 'location' ? 'locations' : 'companies';

  const page = async (n: number) => {
    const res = await fetch(`${ST_BASE}/${collection}?page=${n}&limit=1000${filter}`, { headers });
    if (!res.ok) throw new Error(`ServiceTrade ${collection} page ${n}: ${res.status} ${res.statusText}`);
    const { data } = await res.json();
    return data || {};
  };

  const first = await page(1);
  const totalPages = first.totalPages || 1;
  if (totalPages <= 1) return first[key] || [];

  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) => page(i + 2))
  );
  return [first[key] || [], ...rest.map((d: Record<string, any>) => d[key] || [])].flat();
}

// ------------------------------------------------------------------- row mapping

const asString = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function locationRow(loc: Record<string, any>, tenant: Tenant) {
  const address = loc.address || {};
  return {
    agent_id: tenant.agentId,
    company_id: tenant.companyId,
    servicetrade_id: loc.id,
    servicetrade_company_id: loc.company?.id ?? null,
    name: asString(loc.name),
    ref_number: asString(loc.refNumber),
    phone_number: asString(loc.phoneNumber),
    street: asString(address.street),
    city: asString(address.city),
    state: asString(address.state),
    postal_code: asString(address.postalCode),
    status: asString(loc.status),
    raw_response: loc,
    updated_at: new Date().toISOString()
  };
}

function companyRow(company: Record<string, any>, tenant: Tenant) {
  const address = company.address || {};
  return {
    agent_id: tenant.agentId,
    company_id: tenant.companyId,
    servicetrade_id: company.id,
    name: asString(company.name),
    status: asString(company.status),
    ref_number: asString(company.refNumber),
    street: asString(address.street),
    city: asString(address.city),
    state: asString(address.state),
    postal_code: asString(address.postalCode),
    country: address.country ?? null,
    phone_number: asString(company.phoneNumber),
    raw_response: company,
    updated_at: new Date().toISOString()
  };
}

// ------------------------------------------------------------------- watermark

/**
 * Highest `raw_response.updated` already stored for this tenant.
 *
 * Derived from the data rather than kept in a state table, so there is nothing that
 * can drift out of step with what was actually written. Null means "sync everything".
 */
async function watermark(db: SupabaseClient, table: string, agentId: string): Promise<number | null> {
  const { data, error } = await db.from(table).select('raw_response').eq('agent_id', agentId);
  if (error) throw new Error(`${table} watermark read failed: ${error.message}`);
  if (!data || data.length === 0) return null;

  const epochs = data
    .map((row: Record<string, any>) => Number(row.raw_response?.updated))
    .filter((n: number) => Number.isFinite(n) && n > 0);

  return epochs.length > 0 ? Math.max(...epochs) : null;
}

// ------------------------------------------------------------------- the sync

/**
 * Companies first, and not only the ones the watermark asks for.
 *
 * `servicetrade_locations.servicetrade_company_id` has a foreign key to
 * `servicetrade_companies`, so a location whose company is absent is rejected — and
 * the whole batch with it. An incremental company fetch alone is not enough: a
 * company created before the watermark whose LOCATION changed after it appears in
 * neither the stored rows nor the incremental page. That was the live case here — 31
 * of the 340 companies referenced by the 394 locations were missing from the original
 * one-time load, and the first sync attempt failed outright on the constraint.
 */
async function syncCompanies(
  db: SupabaseClient,
  tenant: Tenant,
  authToken: string,
  locations: Record<string, any>[],
  full: boolean
) {
  const mark = full ? null : await watermark(db, 'servicetrade_companies', tenant.agentId);
  const since = mark ? mark - WATERMARK_OVERLAP_SECONDS : null;

  const fetched = await fetchPaged(authToken, 'company', since);
  const byId = new Map<number, Record<string, any>>(
    fetched.filter((c: Record<string, any>) => c?.id).map((c: Record<string, any>) => [c.id, c])
  );

  const referenced = new Set(
    locations.map((l) => l.company?.id).filter(Boolean)
  );
  const { data: storedRows, error } = await db
    .from('servicetrade_companies')
    .select('servicetrade_id')
    .eq('agent_id', tenant.agentId);
  if (error) throw new Error(`stored company ids read failed: ${error.message}`);
  const stored = new Set((storedRows || []).map((r: Record<string, any>) => r.servicetrade_id));

  const missing = [...referenced].filter((id) => !stored.has(id) && !byId.has(id));
  let gapFilled = 0;
  if (missing.length > 0) {
    // One request, one page for an account this size. Cheaper than reasoning about
    // which watermark should have caught them.
    const everyCompany = await fetchPaged(authToken, 'company', null);
    const missingSet = new Set(missing);
    for (const c of everyCompany as Record<string, any>[]) {
      if (c?.id && missingSet.has(c.id)) {
        byId.set(c.id, c);
        gapFilled += 1;
      }
    }
    console.log(`[sync-locations] ${tenant.agentId}: gap-filled ${gapFilled}/${missing.length} companies the watermark missed`);
  }

  const rows = [...byId.values()].map((c) => companyRow(c, tenant));
  if (rows.length > 0) {
    const { error: upsertError } = await db
      .from('servicetrade_companies')
      .upsert(rows, { onConflict: 'agent_id,servicetrade_id' });
    if (upsertError) throw new Error(`company upsert failed: ${upsertError.message}`);
  }

  return { fetched: fetched.length, upserted: rows.length, gap_filled: gapFilled, updated_after: since };
}

async function syncTenant(db: SupabaseClient, tenant: Tenant, full: boolean) {
  const started = Date.now();
  const mark = full ? null : await watermark(db, 'servicetrade_locations', tenant.agentId);
  const since = mark ? mark - WATERMARK_OVERLAP_SECONDS : null;

  const authToken = await getAuthToken(db, tenant.stAgentId);
  const locations = await fetchPaged(authToken, 'location', since);

  const companies = await syncCompanies(db, tenant, authToken, locations, full);

  const rows = locations.filter((l) => l?.id).map((l) => locationRow(l, tenant));
  if (rows.length > 0) {
    const { error } = await db
      .from('servicetrade_locations')
      .upsert(rows, { onConflict: 'agent_id,servicetrade_id' });
    if (error) throw new Error(`location upsert failed: ${error.message}`);
  }

  // Only the full pass can see an absence, and it REPORTS rather than deletes. A
  // location vanishing from the API is more likely a permissions or paging anomaly
  // than a real deletion, and a job created against a row we deleted is
  // unrecoverable.
  let missingIds: number[] = [];
  if (full) {
    const returned = new Set(rows.map((r) => r.servicetrade_id));
    const { data: storedRows, error } = await db
      .from('servicetrade_locations')
      .select('servicetrade_id')
      .eq('agent_id', tenant.agentId);
    if (error) throw new Error(`stored location ids read failed: ${error.message}`);
    missingIds = (storedRows || [])
      .map((r: Record<string, any>) => r.servicetrade_id)
      .filter((id: number) => !returned.has(id));
  }

  const result = {
    agent_id: tenant.agentId,
    mode: full ? 'full' : 'incremental',
    watermark: mark,
    updated_after: since,
    fetched: locations.length,
    upserted: rows.length,
    companies,
    missing_from_api: missingIds.length,
    missing_ids: missingIds.slice(0, 25),
    duration_ms: Date.now() - started
  };

  console.log(`[sync-locations] ${JSON.stringify(result)}`);
  return result;
}

// ------------------------------------------------------------------- entrypoint

Deno.serve(async (req) => {
  // No hand-rolled auth check. verify_jwt is on for this function, so Supabase has
  // already rejected anything without a valid project key before we get here.
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  const agentIds = parseAgentIds(Deno.env.get('LOCATION_SYNC_AGENT_IDS'));
  if (agentIds.length === 0) {
    return Response.json(
      { success: false, message: 'LOCATION_SYNC_AGENT_IDS is unset' },
      { status: 500 }
    );
  }

  // Reconcile in full at 00:00 UTC, incremental every other hour. `{"full":true}`
  // forces it for a manual catch-up.
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* no body is normal for the cron call */ }
  const full = body.full === true || body.full === 'true' || new Date().getUTCHours() === 0;

  const results: unknown[] = [];
  const failures: unknown[] = [];

  // Sequential on purpose: two tenants must not refresh ServiceTrade sessions
  // concurrently, and there are single digits of them.
  for (const agentId of agentIds) {
    try {
      const tenant = await deriveTenant(db, agentId);
      if (!tenant) {
        failures.push({ agent_id: agentId, error: 'no mirrored rows — company_id cannot be derived' });
        continue;
      }
      results.push(await syncTenant(db, tenant, full));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[sync-locations] ${agentId} failed: ${message}`);
      failures.push({ agent_id: agentId, error: message });
    }
  }

  // A non-2xx is for humans running this by hand. pg_net will not notice either way —
  // it records the request as sent the moment it is queued — which is why every run
  // logs its counts above.
  const status = failures.length > 0 ? 500 : 200;
  return Response.json(
    { success: failures.length === 0, mode: full ? 'full' : 'incremental', tenants: results, failures },
    { status }
  );
});
