const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

/**
 * Load google-sheet/code.gs into a sandbox with the Apps Script globals stubbed.
 *
 * There is no way to run Apps Script locally, and no test suite in the repo, so the
 * escalation state machine is exercised by evaluating the real source against fake
 * SpreadsheetApp / UrlFetchApp / PropertiesService / LockService objects and asserting
 * on what it wrote and what it called.
 */
function loadAppsScript({ rows = [], fetchHandler, properties = {} } = {}) {
    const source = fs.readFileSync(path.join(REPO, 'google-sheet', 'code.gs'), 'utf8');

    const NUM_COLS = 30;
    const grid = rows.map((r) => {
        const row = Array.from({ length: NUM_COLS }, (_, i) => (r[i] === undefined ? '' : r[i]));
        return row;
    });

    const flushes = { count: 0 };
    const fetches = [];

    const makeRange = (rowIdx, colIdx, numRows, numCols) => ({
        getValue: () => (grid[rowIdx - 2] ? grid[rowIdx - 2][colIdx - 1] : ''),
        setValue: (v) => {
            while (grid.length < rowIdx - 1) grid.push(Array(NUM_COLS).fill(''));
            if (!grid[rowIdx - 2]) grid[rowIdx - 2] = Array(NUM_COLS).fill('');
            grid[rowIdx - 2][colIdx - 1] = v;
        },
        getValues: () => {
            const out = [];
            for (let r = 0; r < numRows; r++) {
                const src = grid[rowIdx - 2 + r] || Array(NUM_COLS).fill('');
                out.push(src.slice(colIdx - 1, colIdx - 1 + numCols));
            }
            return out;
        },
        setValues: (vals) => {
            vals.forEach((v, r) => {
                if (!grid[rowIdx - 2 + r]) grid[rowIdx - 2 + r] = Array(NUM_COLS).fill('');
                v.forEach((cell, c) => { grid[rowIdx - 2 + r][colIdx - 1 + c] = cell; });
            });
        }
    });

    const sheet = {
        getRange: (a, b, c, d) => makeRange(a, b, c || 1, d || 1),
        getLastRow: () => grid.length + 1,
        getLastColumn: () => NUM_COLS,
        getMaxColumns: () => NUM_COLS,
        appendRow: (r) => grid.push(r)
    };

    const sandbox = {
        console,
        JSON,
        Date,
        Math,
        String,
        Number,
        Boolean,
        Object,
        Array,
        parseInt,
        parseFloat,
        isNaN,
        encodeURIComponent,
        RegExp,
        Error,
        SpreadsheetApp: {
            getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, getSheets: () => [sheet] }),
            openById: () => ({ getSheetByName: () => sheet, getSheets: () => [sheet] }),
            flush: () => { flushes.count += 1; }
        },
        UrlFetchApp: {
            fetch: (url, options) => {
                fetches.push({ url, options });
                const res = fetchHandler ? fetchHandler(url, options) : { code: 200, body: '{}' };
                return {
                    getResponseCode: () => res.code,
                    getContentText: () => res.body
                };
            }
        },
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: (k) => (k in properties ? properties[k] : null),
                setProperty: (k, v) => { properties[k] = v; },
                deleteProperty: (k) => { delete properties[k]; },
                getProperties: () => ({ ...properties })
            })
        },
        LockService: {
            getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} })
        },
        Utilities: {
            formatDate: (date, tz, fmt) => {
                const pad = (n) => String(n).padStart(2, '0');
                const d = new Date(date);
                return fmt
                    .replace('dd', pad(d.getUTCDate()))
                    .replace('MM', pad(d.getUTCMonth() + 1))
                    .replace('yyyy', d.getUTCFullYear())
                    .replace('HH', pad(d.getUTCHours()))
                    .replace('hh', pad(d.getUTCHours() % 12 || 12))
                    .replace('mm', pad(d.getUTCMinutes()))
                    .replace('ss', pad(d.getUTCSeconds()))
                    .replace(' a z', '');
            }
        },
        ContentService: {
            MimeType: { JSON: 'application/json' },
            createTextOutput: (t) => ({ setMimeType: () => ({ getContent: () => t }, { getContent: () => t }), getContent: () => t })
        },
        ScriptApp: {
            getProjectTriggers: () => [],
            newTrigger: () => ({
                timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) })
            }),
            deleteTrigger: () => {}
        }
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'code.gs' });

    return { sandbox, sheet, grid, flushes, fetches, properties };
}

/** Load a Node module with selected dependencies replaced. */
function loadWithMocks(modulePath, mocks) {
    const resolved = require.resolve(modulePath);
    const Module = require('module');
    const original = Module.prototype.require;
    const mockKeys = Object.keys(mocks);

    delete require.cache[resolved];
    for (const key of mockKeys) {
        try { delete require.cache[require.resolve(key, { paths: [path.dirname(resolved)] })]; } catch {}
    }

    Module.prototype.require = function patched(id) {
        if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
        return original.apply(this, arguments);
    };
    try {
        return require(resolved);
    } finally {
        Module.prototype.require = original;
        delete require.cache[resolved];
    }
}

module.exports = { loadAppsScript, loadWithMocks, REPO };
