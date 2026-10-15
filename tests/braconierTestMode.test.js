const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { REPO } = require('./harness');

// google-sheet/braconier-code.gs is GITIGNORED — it mirrors the deployed Apps Script and is
// simply absent on a fresh clone. Skip rather than crash, the same way the Adaptive suite
// does. (The shared harness still points at google-sheet/code.gs, a path that no longer
// exists; that is why its 67 cases skip. Not touched here.)
const SCRIPT = path.join(REPO, 'google-sheet', 'braconier-code.gs');
const available = fs.existsSync(SCRIPT);
const skip = available ? {} : { skip: 'google-sheet/braconier-code.gs not present' };

/**
 * Evaluate the real script with the Apps Script globals stubbed, then override CONFIG.
 *
 * Only the test-mode decision functions are exercised: which number counts as a test
 * caller, where its email goes, and what happens when the test is half-configured. Those
 * are pure, so no sheet or network stub has to be faithful.
 */
function load({ testNumbers = [], outbound = '', notify = '' } = {}) {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const noop = () => {};
    const sandbox = {
        console: { log: noop, warn: noop, error: noop },
        SpreadsheetApp: { openById: () => ({ getSheetByName: () => null }) },
        UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
        PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
        ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
        Utilities: { sleep: noop },
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) }
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'braconier-code.gs' });

    // CONFIG and SENDGRID_CONFIG are top-level `const`, so they are lexical bindings and
    // never become properties of the sandbox. Read them back through the context. The
    // objects themselves are mutable, which is all the overriding needs.
    const CONFIG = vm.runInContext('CONFIG', sandbox);
    CONFIG.TEST_OVERRIDE_NUMBERS = testNumbers;
    CONFIG.TEST_OUTBOUND_NUMBER = outbound;
    CONFIG.TEST_NOTIFICATION_EMAIL = notify;

    return {
        CONFIG,
        SENDGRID_CONFIG: vm.runInContext('SENDGRID_CONFIG', sandbox),
        isTestCaller: sandbox.isTestCaller,
        testEmailRecipient: sandbox.testEmailRecipient,
        isTestRecipient: sandbox.isTestRecipient,
        getRecipientEmail: sandbox.getRecipientEmail,
        getRecipientName: sandbox.getRecipientName
    };
}

const TEST_PHONE = '+14155201480';
const REAL_PHONE = '+13038758807';
const TEST_INBOX = 'subham.agarwal@justclara.ai';

// ------------------------------------------------------- who counts as a test caller

test('a listed number is a test caller in every format', skip, () => {
    const s = load({ testNumbers: [TEST_PHONE] });
    for (const form of ['+14155201480', '14155201480', '4155201480', '(415) 520-1480', '415-520-1480']) {
        assert.strictEqual(s.isTestCaller(form), true, `${form} should match`);
    }
});

test('an unlisted number is never a test caller', skip, () => {
    const s = load({ testNumbers: [TEST_PHONE] });
    assert.strictEqual(s.isTestCaller(REAL_PHONE), false);
    assert.strictEqual(s.isTestCaller(''), false);
    assert.strictEqual(s.isTestCaller(null), false);
});

test('an empty list means nobody is a test caller', skip, () => {
    // The shipped default. Until a number is added, production behaviour is untouched.
    const s = load({ testNumbers: [] });
    assert.strictEqual(s.isTestCaller(TEST_PHONE), false);
    assert.strictEqual(s.isTestCaller(REAL_PHONE), false);
});

test('an unusable list entry is ignored, not treated as a wildcard', skip, () => {
    const s = load({ testNumbers: ['', 'not a phone', '123'] });
    assert.strictEqual(s.isTestCaller(TEST_PHONE), false);
    assert.strictEqual(s.isTestCaller(REAL_PHONE), false);
});

// ------------------------------------------------------------- where the email goes

test('a test caller\'s email is diverted to the test inbox', skip, () => {
    const s = load({ testNumbers: [TEST_PHONE], notify: TEST_INBOX });
    assert.strictEqual(s.getRecipientEmail({ from_number: TEST_PHONE, email: 'tech@braconier.com' }), TEST_INBOX);
    assert.strictEqual(s.getRecipientName({ from_number: TEST_PHONE, email: 'tech@braconier.com' }), 'Test');
});

test('a real caller still reaches the technician', skip, () => {
    const s = load({ testNumbers: [TEST_PHONE], notify: TEST_INBOX });
    assert.strictEqual(s.getRecipientEmail({ from_number: REAL_PHONE, email: 'tech@braconier.com' }), 'tech@braconier.com');
    assert.strictEqual(s.getRecipientName({ from_number: REAL_PHONE, email: 'tech@braconier.com' }), 'Technician');
});

test('a real caller with no technician email reaches the dispatch team', skip, () => {
    const s = load({ testNumbers: [TEST_PHONE], notify: TEST_INBOX });
    const to = s.getRecipientEmail({ from_number: REAL_PHONE, email: '' });
    assert.strictEqual(to, s.SENDGRID_CONFIG.CC_EMAIL[0]);
    assert.strictEqual(s.getRecipientName({ from_number: REAL_PHONE, email: '' }), 'Dispatch Team');
});

// ------------------------------------------------------------------- failing closed

test('a half-configured test sends nowhere rather than to the client', skip, () => {
    // THE RULE THAT MATTERS. A test number set with no TEST_NOTIFICATION_EMAIL must not
    // fall back to the technician or to dispatch@braconier.com.
    const s = load({ testNumbers: [TEST_PHONE], notify: '' });
    const to = s.getRecipientEmail({ from_number: TEST_PHONE, email: 'tech@braconier.com' });

    assert.strictEqual(to, '', 'no recipient at all');
    assert.notStrictEqual(to, s.SENDGRID_CONFIG.CC_EMAIL[0], 'never the dispatch team');
    assert.notStrictEqual(to, 'tech@braconier.com', 'never the technician');
});

test('an address that is not an address is not a usable test inbox', skip, () => {
    const s = load({ testNumbers: [TEST_PHONE], notify: 'not-an-email' });
    assert.strictEqual(s.testEmailRecipient(), '');
    assert.strictEqual(s.getRecipientEmail({ from_number: TEST_PHONE }), '');
});

// ------------------------------------------------------------------ CC suppression

test('the client CC is suppressed on a test send', skip, () => {
    const s = load({ testNumbers: [TEST_PHONE], notify: TEST_INBOX });
    assert.strictEqual(s.isTestRecipient(TEST_INBOX), true);
    assert.strictEqual(s.isTestRecipient(TEST_INBOX.toUpperCase()), true, 'case must not matter');
});

test('the client CC still applies to a real send', skip, () => {
    const s = load({ testNumbers: [TEST_PHONE], notify: TEST_INBOX });
    assert.strictEqual(s.isTestRecipient('tech@braconier.com'), false);
    assert.strictEqual(s.isTestRecipient(s.SENDGRID_CONFIG.CC_EMAIL[0]), false);
});

test('with no test inbox configured, nothing is treated as a test recipient', skip, () => {
    const s = load({ testNumbers: [], notify: '' });
    assert.strictEqual(s.isTestRecipient(''), false);
    assert.strictEqual(s.isTestRecipient('anyone@anywhere.com'), false);
});

// ---------------------------------------------------------------- the shipped state

test('the script ships with test mode off', skip, () => {
    // Read the real file, not an overridden sandbox: a committed test number would divert
    // a real emergency to a test handset.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(source, /TEST_OVERRIDE_NUMBERS:\s*\[\s*\]/, 'TEST_OVERRIDE_NUMBERS must ship empty');
    assert.match(source, /TEST_OUTBOUND_NUMBER:\s*''/, 'TEST_OUTBOUND_NUMBER must ship empty');
    assert.match(source, /TEST_NOTIFICATION_EMAIL:\s*''/, 'TEST_NOTIFICATION_EMAIL must ship empty');
});
