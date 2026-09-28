const test = require('node:test');
const assert = require('node:assert');

const { resolveCustomerVerdict, asLocationId } = require('../src/services/customerVerdictService');

const AGENT = 'agent_41010d0d8c1f46cf1d9dfcddbf';

// The call that produced this module. Pre-greeting lookup verified Steve Rupp of Centennial
// Realty Advisors and found TWO candidate sites, so it shipped no location id; the agent never
// ran the branch that picks one; the post-call analyser then wrote is_existing_customer false.
const ROW_745 = {
    from_number: '+17206412497',
    retell_llm_dynamic_variables: {
        st_lookup_ok: 'true',
        st_customer_verified: 'true',
        st_customer_reason: 'needs_location',
        st_needs_location: 'true',
        st_location_options: '151 DETROIT ST, DENVER, CO, 80206 | 151 Clayton Lane, Denver, CO, 80206',
        st_location_id: '',
        st_location_name: '',
        st_company_name: 'Centennial Realty Advisors',
        st_contact_name: 'Steve Rupp'
    },
    transcript_with_tool_calls: [
        { role: 'agent', content: 'Thank you for calling Bracaan-yur.' },
        { role: 'tool_call_result', content: 'not json at all' }
    ]
};

const neverCalled = () => { throw new Error('verify() must not be called'); };

/** A verify() that records its arguments and answers from a script, one entry per call. */
const scripted = (...responses) => {
    const calls = [];
    const fn = async (args) => {
        calls.push(args);
        const next = responses[calls.length - 1];
        if (typeof next === 'function') return next(args);
        return next;
    };
    fn.calls = calls;
    return fn;
};

const vars = (overrides) => ({ st_lookup_ok: 'true', st_customer_verified: 'false', ...overrides });

test('the post-call search runs even when the call already said verified', async () => {
    const verify = scripted(
        { vars: vars({ st_customer_verified: 'true', st_needs_location: 'true', st_location_id: '' }) },
        { vars: vars({ st_customer_verified: 'true', st_location_id: '1495446205462720' }) }
    );

    const verdict = await resolveCustomerVerdict({
        call: ROW_745,
        dynamicVars: { intakeComplete: 'true' },
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '151 Detroit Street, Denver, CO 80206',
        verify
    });

    assert.strictEqual(verdict.searched, true);
    assert.strictEqual(verdict.verified, true);
    // Pass 1 by caller ID, pass 2 with the address to break the tie between the two sites.
    assert.strictEqual(verify.calls.length, 2);
    assert.deepStrictEqual(verify.calls[0], { agentId: AGENT, rawTerm: '7206412497', spokenLocation: '', attempt: 1 });
    assert.strictEqual(verify.calls[1].spokenLocation, '151 Detroit Street, Denver, CO 80206');
    // The id the call itself never resolved.
    assert.strictEqual(verdict.locationId, '1495446205462720');
});

test('the post-call search runs even when the call said NOT verified', async () => {
    const verify = scripted({ vars: vars({ st_customer_verified: 'true', st_location_id: '1495451106949312' }) });

    const verdict = await resolveCustomerVerdict({
        call: {
            from_number: '+17206412497',
            retell_llm_dynamic_variables: { st_lookup_ok: 'true', st_customer_verified: 'false', st_customer_reason: 'no_contact_match' }
        },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify
    });

    assert.strictEqual(verify.calls.length, 1);
    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.source, 'post_call_search');
    assert.strictEqual(verdict.locationId, '1495451106949312');
});

test('the post-call search runs even when caller_details already stored a verdict', async () => {
    const verify = scripted({ vars: vars({ st_customer_verified: 'true', st_location_id: '999' }) });

    const verdict = await resolveCustomerVerdict({
        call: ROW_745,
        dynamicVars: { customerVerified: 'true', locationId: '1495446205462720' },
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify
    });

    assert.strictEqual(verify.calls.length, 1);
    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.source, 'caller_details');
    // What the caller heard read back outranks what the search found afterwards.
    assert.strictEqual(verdict.locationId, '1495446205462720');
});

test('a search that finds nothing cannot refuse a caller the call verified', async () => {
    // Branch 3 of the prompt: the caller rang from an unregistered mobile and was verified
    // mid-call on a DIFFERENT number they stated. A caller-ID search will never find them.
    const verify = scripted({ vars: vars({ st_customer_verified: 'false', st_customer_reason: 'no_contact_match' }) });

    const verdict = await resolveCustomerVerdict({
        call: {
            from_number: '+13035559999',
            transcript_with_tool_calls: [
                { role: 'tool_call_result', content: JSON.stringify({ data: { st_customer_verified: 'true', st_location_id: '4242' } }) }
            ]
        },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify
    });

    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.source, 'st_customer_tool_result');
    assert.strictEqual(verdict.locationId, '4242');
});

test('a search that finds nothing DOES refuse when the call asserted nothing', async () => {
    const verify = scripted({ vars: vars({ st_customer_verified: 'false', st_customer_reason: 'no_contact_match' }) });

    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+13035559999' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify
    });

    assert.strictEqual(verdict.verified, false);
    assert.strictEqual(verdict.locationId, '');
});

test('the address pass may add a location id but never a verdict', async () => {
    // Pass 2 fails to match the address decisively, which resolveCustomer reports as
    // st_customer_verified false. That is a statement about the address, not the contact.
    const verify = scripted(
        { vars: vars({ st_customer_verified: 'true', st_needs_location: 'true' }) },
        { vars: vars({ st_customer_verified: 'false', st_customer_reason: 'location_unresolved' }) }
    );

    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+17206412497' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: 'somewhere the matcher cannot place',
        verify
    });

    assert.strictEqual(verify.calls.length, 2);
    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.locationId, '');
});

test('the address pass is skipped when the first pass already named the site', async () => {
    const verify = scripted({ vars: vars({ st_customer_verified: 'true', st_needs_confirmation: 'true', st_location_id: '1495451106949312' }) });

    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+17206412497' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '1801 California Street, Denver, CO 80202',
        verify
    });

    assert.strictEqual(verify.calls.length, 1);
    assert.strictEqual(verdict.locationId, '1495451106949312');
});

test('the address pass is skipped when the call captured no address', async () => {
    const verify = scripted({ vars: vars({ st_customer_verified: 'true', st_needs_location: 'true' }) });

    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+17206412497' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify
    });

    assert.strictEqual(verify.calls.length, 1);
    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.locationId, '');
});

test('a verified st_customer response WITH a location id beats an earlier one without', async () => {
    const call = {
        from_number: '+13035551234',
        transcript_with_tool_calls: [
            { role: 'tool_call_result', content: JSON.stringify({ data: { st_customer_verified: 'true', st_location_id: '' } }) },
            { role: 'tool_call_result', content: JSON.stringify({ data: { st_customer_verified: 'true', st_location_id: '2251436687301761' } }) },
            // The shape that erases the good answer from collected_dynamic_variables.
            { role: 'tool_call_result', content: JSON.stringify({ data: { st_customer_verified: 'false', st_customer_reason: 'no_contact_match' } }) }
        ]
    };

    const verdict = await resolveCustomerVerdict({
        call, dynamicVars: {}, agentId: AGENT, allowLookup: false, verify: neverCalled
    });

    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.source, 'st_customer_tool_result');
    assert.strictEqual(verdict.locationId, '2251436687301761');
});

test('a flat tool response, with no data wrapper, is read too', async () => {
    const call = {
        transcript_with_tool_calls: [
            { role: 'tool_call_result', content: JSON.stringify({ st_customer_verified: true, st_location_id: 999 }) }
        ]
    };

    const verdict = await resolveCustomerVerdict({
        call, dynamicVars: {}, agentId: AGENT, allowLookup: false, verify: neverCalled
    });

    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.locationId, '999');
});

test('a ServiceTrade outage is NOT a refusal', async () => {
    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+13035551234' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify: async () => ({ vars: { st_lookup_ok: 'false', st_customer_verified: 'false', st_customer_reason: 'lookup_error' } })
    });

    assert.strictEqual(verdict.verified, null);
    assert.strictEqual(verdict.source, 'post_call_search_unavailable');
    assert.strictEqual(verdict.searched, true);
});

test('a thrown search leaves the old behaviour in place rather than blocking', async () => {
    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+13035551234' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify: async () => { throw new Error('ECONNRESET'); }
    });

    assert.strictEqual(verdict.verified, null);
    assert.strictEqual(verdict.source, 'post_call_search_unavailable');
});

test('a thrown ADDRESS pass keeps the verification the first pass earned', async () => {
    const verify = scripted(
        { vars: vars({ st_customer_verified: 'true', st_needs_location: 'true' }) },
        () => { throw new Error('ECONNRESET'); }
    );

    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+17206412497' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '151 Detroit Street, Denver, CO 80206',
        verify
    });

    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.locationId, '');
});

test('an agent outside the allowlist never triggers a search', async () => {
    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+14165550000' },
        dynamicVars: {},
        agentId: 'agent_adaptive',
        allowLookup: false,
        verify: neverCalled
    });

    assert.strictEqual(verdict.verified, null);
    assert.strictEqual(verdict.source, 'none');
    assert.strictEqual(verdict.searched, false);
});

test('a number that is not ten digits is never searched', async () => {
    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+1' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        verify: neverCalled
    });

    assert.strictEqual(verdict.verified, null);
    assert.strictEqual(verdict.searched, false);
});

test('caller_details false is an absence, not a verdict — the search still decides', async () => {
    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+17206412497' },
        dynamicVars: { customerVerified: 'false' },
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify: async () => ({ vars: vars({ st_customer_verified: 'true', st_location_id: '77' }) })
    });

    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.source, 'post_call_search');
    assert.strictEqual(verdict.locationId, '77');
});

test('asLocationId rejects everything that is not digits', () => {
    assert.strictEqual(asLocationId('1495446205462720'), '1495446205462720');
    assert.strictEqual(asLocationId(' 42 '), '42');
    assert.strictEqual(asLocationId(1234), '1234');
    assert.strictEqual(asLocationId('{{st_location_id}}'), '');
    assert.strictEqual(asLocationId('Centennial Realty Advisors'), '');
    assert.strictEqual(asLocationId('1.49545E+15'), '');
    assert.strictEqual(asLocationId(''), '');
    assert.strictEqual(asLocationId(null), '');
});

// --- The analyser said false, but ServiceTrade has the number -------------------------
//
// One field decides it: the ServiceTrade company's own `customer` flag. These four cases are
// what "there IS a contact for that number" can actually mean.

test('a customer contact on ONE site: the analyser false is overruled', async () => {
    const verdict = await resolveCustomerVerdict({
        call: {
            from_number: '+13038758807',
            retell_llm_dynamic_variables: { st_lookup_ok: 'true', st_customer_verified: 'false' }
        },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '1801 California Street, Denver, CO 80202',
        verify: async () => ({
            vars: vars({
                st_customer_verified: 'true',
                st_customer_reason: 'needs_confirmation',
                st_needs_confirmation: 'true',
                st_location_id: '1495451106949312'
            })
        })
    });

    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.locationId, '1495451106949312');
});

test('a customer contact with NO location on file is still a customer', async () => {
    // resolveCustomer answers this `st_customer_verified: false, reason location_unresolved`
    // so the in-call agent stops promising dispatch. The job gate asks a different question:
    // ServiceTrade matched the contact and their company carries the customer flag.
    const verify = scripted({ vars: vars({ st_customer_verified: 'false', st_customer_reason: 'location_unresolved', st_contact_id: '1635940312996225', st_company_name: 'Centennial Realty Advisors' }) });

    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+17206412497' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '151 Detroit Street, Denver, CO 80206',
        verify
    });

    assert.strictEqual(verdict.verified, true);
    // No id — the address matcher downstream decides where the job lands.
    assert.strictEqual(verdict.locationId, '');
    // Not an ambiguity, so no second pass.
    assert.strictEqual(verify.calls.length, 1);
});

test('a contact whose company is NOT a ServiceTrade customer is still refused', async () => {
    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+13035551234' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify: async () => ({ vars: vars({ st_customer_verified: 'false', st_customer_reason: 'company_not_customer' }) })
    });

    assert.strictEqual(verdict.verified, false);
});

test('no contact on that number at all is refused', async () => {
    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+13035551234' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: '',
        verify: async () => ({ vars: vars({ st_customer_verified: 'false', st_customer_reason: 'no_contact_match' }) })
    });

    assert.strictEqual(verdict.verified, false);
});

test('a spoken address that matches nothing never downgrades the account', async () => {
    // Pass 2's own `location_unresolved` must NOT be read as pass 1's. Pass 1 already
    // verified; the address simply could not be placed.
    const verify = scripted(
        { vars: vars({ st_customer_verified: 'true', st_needs_location: 'true' }) },
        { vars: vars({ st_customer_verified: 'false', st_customer_reason: 'location_unresolved' }) }
    );

    const verdict = await resolveCustomerVerdict({
        call: { from_number: '+17206412497' },
        dynamicVars: {},
        agentId: AGENT,
        allowLookup: true,
        spokenLocation: 'the big building on the corner',
        verify
    });

    assert.strictEqual(verify.calls.length, 2);
    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.locationId, '');
});
