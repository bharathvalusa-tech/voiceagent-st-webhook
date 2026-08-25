/**
 * The one phone-comparison key used across this service.
 *
 * Retell hands us E.164 ("+14169012663"), the Apps Script normalizes the sheet's
 * caller column to E.164 too, and ServiceTrade stores "(416) 901-2663",
 * "416-901-2663" or "416-408-2300 ext 450". Comparing any two of those requires
 * reducing all of them to the same thing: the last ten digits of the subscriber
 * number.
 *
 * EXTENSIONS MUST GO FIRST. Stripping non-digits before the extension leaves the
 * extension's digits glued to the number, and `slice(-10)` then reads the wrong
 * ten: "416-408-2300 ext 450" became "4082300450", a different — possibly real,
 * possibly colliding — number. 10 of the 359 Adaptive locations carry an
 * extension, in five different spellings.
 */

// Trailing "ext 450" / "ext. 4306" / "extension 202" / "x99", with or without the
// dot and with any spacing. Anchored at the end and required to end in digits, so
// a bare "ext" with nothing after it is left alone (it contributes no digits).
const EXTENSION_SUFFIX = /(?:extension|ext|x)[\s.]*\d+\s*$/i;

/**
 * @param {*} phone any phone-ish value
 * @returns {string} the last ten digits, or a shorter string when the input
 *   cannot yield ten. Callers guard on `.length !== 10`.
 */
const normalizePhone = (phone) => {
    const digits = String(phone || '')
        .replace(EXTENSION_SUFFIX, '')
        .replace(/[^\d]/g, '');

    // Drop the NANP country code before taking the tail, so an 11-digit
    // "14169012663" and a 10-digit "4169012663" agree.
    const national = digits.length === 11 && digits.startsWith('1')
        ? digits.slice(1)
        : digits;

    return national.slice(-10);
};

module.exports = { normalizePhone, EXTENSION_SUFFIX };
