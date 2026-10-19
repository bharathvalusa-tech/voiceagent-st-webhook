const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { REPO } = require('./harness');

// google-sheet/braconier-code.gs is GITIGNORED (it mirrors the deployed Apps Script), so
// skip on a fresh clone — same rule as braconierTestMode.test.js.
const SCRIPT = path.join(REPO, 'google-sheet', 'braconier-code.gs');
const skip = fs.existsSync(SCRIPT) ? {} : { skip: 'google-sheet/braconier-code.gs not present' };

function load({ testNumbers = [], fetched = [] } = {}) {
    const noop = () => {};
    const sandbox = {
        console: { log: noop, warn: noop, error: noop },
        SpreadsheetApp: { openById: () => ({ getSheetByName: () => null }) },
        UrlFetchApp: {
            fetch: (url, options) => {
                fetched.push({ url, options });
                return { getResponseCode: () => 200, getContentText: () => '{}' };
            }
        },
        PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
        ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
        Utilities: { sleep: noop },
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'braconier-code.gs' });
    const CONFIG = vm.runInContext('CONFIG', sandbox);
    CONFIG.TEST_OVERRIDE_NUMBERS = testNumbers;
    return { s: sandbox, CONFIG };
}

// One row, cells keyed by 1-based column — enough for getRange(row, col).get/setValue.
function fakeSheet() {
    const cells = {};
    return {
        cells,
        getRange: (row, col) => ({
            getValue: () => cells[col] ?? '',
            setValue: (v) => { cells[col] = v; }
        })
    };
}

const passing = {
    outboundEnabled: true, isEmergency: true, customerOk: true,
    isIntakeComplete: true, skipOutboundCall: false, writerSaysDispatch: true
};

test('a dispatchable row has no skip reason', skip, () => {
    const { s } = load();
    assert.strictEqual(s.dispatchSkipReason(passing), '');
});

test('an unverified caller is named as the reason — call_ea34e0ada', skip, () => {
    // Emergency, intake complete, but the sheet writer saw no verified lookup. Before the
    // note, the row showed only make_call FALSE and looked identical to a success.
    const { s } = load();
    assert.strictEqual(
        s.dispatchSkipReason({ ...passing, customerOk: false }),
        'no technician called: caller not verified as an existing customer'
    );
});

test('every failed condition is listed, not just the first', skip, () => {
    const { s } = load();
    const reason = s.dispatchSkipReason({ ...passing, isEmergency: false, isIntakeComplete: false });
    assert.match(reason, /not an emergency/);
    assert.match(reason, /intake incomplete/);
});

test('the sheet writer saying no is reported only when nothing else failed', skip, () => {
    const { s } = load();
    assert.match(s.dispatchSkipReason({ ...passing, writerSaysDispatch: false }), /sheet writer sent make_call false/);
    assert.doesNotMatch(
        s.dispatchSkipReason({ ...passing, isEmergency: false, writerSaysDispatch: false }),
        /sheet writer/
    );
});

test('stopping the loop writes make_call FALSE and the reason in NOTE', skip, () => {
    const { s, CONFIG } = load();
    const sheet = fakeSheet();
    s.stopDispatch(sheet, 2, 'stopped after call 1');
    assert.strictEqual(sheet.cells[CONFIG.COLUMNS.MAKE_CALL + 1], false);
    assert.strictEqual(sheet.cells[CONFIG.COLUMNS.NOTE + 1], 'dispatch: stopped after call 1');
});

test('dispatch notes append and keep a [TEST_ROW] tag', skip, () => {
    const { s, CONFIG } = load();
    const sheet = fakeSheet();
    sheet.cells[CONFIG.COLUMNS.NOTE + 1] = '[TEST_ROW]';
    s.noteDispatch(sheet, 2, 'technician call 1 placed (call_x)');
    s.noteDispatch(sheet, 2, 'stopped after call 1');
    assert.strictEqual(
        sheet.cells[CONFIG.COLUMNS.NOTE + 1],
        '[TEST_ROW] | dispatch: technician call 1 placed (call_x) | dispatch: stopped after call 1'
    );
});

test('nothing but stopDispatch turns make_call off inside the loop', skip, () => {
    // Every FALSE must carry a reason. A bare setValue(false) on MAKE_CALL in
    // processCallRow would bring back the unexplained FALSE.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const body = source.slice(source.indexOf('function processCallRow'), source.indexOf('function formatPhoneNumber'));
    assert.doesNotMatch(body, /MAKE_CALL \+ 1\)\.setValue\(false\)/);
});

// ------------------------------------------------------------- test rows ring once only

const TEST_PHONE = '+14155201480';

function rowFrom(CONFIG, fromNumber, counter) {
    const row = new Array(CONFIG.COLUMNS.INTAKE_COMPLETE + 1).fill('');
    row[CONFIG.COLUMNS.FROM_NUMBER] = fromNumber;
    row[CONFIG.COLUMNS.EMERGENCY_TYPE] = 'Plumbing';
    row[CONFIG.COLUMNS.RESPONSE_CALL_ID_1] = 'call_first';
    row[CONFIG.COLUMNS.CALL_DECLINE_COUNTER] = counter;
    return row;
}

test('a test row stops after its one call instead of climbing to the manager', skip, () => {
    // Before: calls 2 and 3 went to the test handset, then makeOutboundCallToManager
    // rang the REAL fallback manager for a test call.
    const fetched = [];
    const { s, CONFIG } = load({ testNumbers: [TEST_PHONE], fetched });
    for (const counter of [1, 2, 3]) {
        const sheet = fakeSheet();
        s.processCallRow(sheet, 2, rowFrom(CONFIG, TEST_PHONE, counter));
        assert.strictEqual(sheet.cells[CONFIG.COLUMNS.MAKE_CALL + 1], false, `counter ${counter}`);
        assert.match(sheet.cells[CONFIG.COLUMNS.NOTE + 1], /test row: one call/);
    }
    assert.strictEqual(fetched.length, 0, 'nothing dialled, nothing looked up');
});

test('the fallback manager is never dialled for a test caller', skip, () => {
    const fetched = [];
    const { s, CONFIG } = load({ testNumbers: [TEST_PHONE], fetched });
    const id = s.makeOutboundCallToManager(rowFrom(CONFIG, TEST_PHONE, 3), { phone: '+17202068014', name: 'Manager' });
    assert.strictEqual(id, null);
    assert.strictEqual(fetched.length, 0);
});

test('a real caller still climbs the ladder', skip, () => {
    // The test stop must not touch production rows.
    const fetched = [];
    const { s, CONFIG } = load({ testNumbers: [TEST_PHONE], fetched });
    const sheet = fakeSheet();
    s.processCallRow(sheet, 2, rowFrom(CONFIG, '+13038758807', 1));
    assert.notStrictEqual(sheet.cells[CONFIG.COLUMNS.MAKE_CALL + 1], false);
    assert.ok(fetched.some((f) => /create-phone-call/.test(f.url)), 'call 2 placed');
});
