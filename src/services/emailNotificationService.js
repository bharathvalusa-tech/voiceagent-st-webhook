const sgMail = require('@sendgrid/mail');
const config = require('../config/environment');
const retellService = require('./retellService');

const DEFAULT_APP_URL = 'https://app.servicetrade.com/auth';
const BRAND_DASHBOARD_URL = 'https://voice.justclara.ai/dashboard';
const SERVICE_LINE_LABELS = {
    1: 'Fire Alarm',
    5: 'Sprinkler'
};

const normalizeBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    }
    return false;
};

const parseEmailList = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) {
        return [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))];
    }

    return [...new Set(
        String(value)
            .split(/[;,]/)
            .map((entry) => entry.trim())
            .filter(Boolean)
    )];
};

const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatTimestampCentral = (value) => {
    const date = value ? new Date(value) : new Date();
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short'
    }).format(date);
};

const formatAddress = (value) => {
    if (!value) return 'Not provided';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        return [
            value.street,
            value.city,
            value.state,
            value.postalCode || value.zip
        ].filter(Boolean).join(', ') || 'Not provided';
    }
    return String(value);
};

const toTitleCase = (value) => String(value || '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');

const inferEmergencyType = (details = {}) => {
    // Explicit, captured type — present as-is (it is fact, not a guess).
    const explicitType = details.emergencyType || details.issueType;
    if (explicitType) return explicitType;

    if (details.serviceLineId && SERVICE_LINE_LABELS[details.serviceLineId]) {
        return SERVICE_LINE_LABELS[details.serviceLineId];
    }

    // Everything below is a heuristic guess from the text — label it as inferred
    // so the reader does not mistake a keyword match for a confirmed category.
    const haystack = [
        details.issueDescription,
        details.callSummary,
        details.locationName,
        details.companyName
    ].filter(Boolean).join(' ').toLowerCase();

    if (haystack.includes('sprinkler')) return 'Sprinkler (inferred)';
    if (haystack.includes('alarm')) return 'Alarm (inferred)';
    if (haystack.includes('fire')) return 'Fire Emergency (inferred)';
    if (details.priority === 'Emergency') return 'Emergency Dispatch (inferred)';
    return 'Service Request (inferred)';
};

const normalizeServiceTradeJobLink = (value) => {
    if (!value) return null;

    const link = String(value).trim();
    if (!link) return null;

    return link
        .replace('https://app.servicetrade.com/api/job/', 'https://app.servicetrade.com/job/')
        .replace('/api/job/', '/job/');
};

const buildServiceTradeJobLink = (details = {}) => {
    if (details.jobLink) return normalizeServiceTradeJobLink(details.jobLink);
    if (details.jobUri) return normalizeServiceTradeJobLink(details.jobUri);

    const { jobId, authData = {} } = details;
    if (authData && typeof authData.job_url_template === 'string' && authData.job_url_template.includes('{{jobId}}')) {
        return normalizeServiceTradeJobLink(authData.job_url_template.replace('{{jobId}}', String(jobId)));
    }

    if (authData && typeof authData.job_url_template === 'string' && authData.job_url_template.includes('{jobId}')) {
        return normalizeServiceTradeJobLink(authData.job_url_template.replace('{jobId}', String(jobId)));
    }

    if (authData && typeof authData.app_url === 'string' && authData.app_url.trim()) {
        return normalizeServiceTradeJobLink(authData.app_url.trim());
    }

    if (authData && typeof authData.portal_url === 'string' && authData.portal_url.trim()) {
        return normalizeServiceTradeJobLink(authData.portal_url.trim());
    }

    return DEFAULT_APP_URL;
};

const formatCandidateList = (candidates = []) => {
    if (!Array.isArray(candidates) || candidates.length === 0) return 'Not available';

    return candidates.map((candidate, index) => {
        const parts = [
            `${index + 1}. ${candidate.locationName || 'Unknown location'}`,
            candidate.companyName ? `Company: ${candidate.companyName}` : null,
            candidate.address ? `Address: ${formatAddress(candidate.address)}` : null,
            candidate.tierReason ? `Reason: ${candidate.tierReason}` : null
        ].filter(Boolean);
        return parts.join(' | ');
    }).join('\n');
};

const buildTextBody = ({ introLine, sections, footerLines }) => {
    const lines = [introLine, ''];

    sections.forEach((section) => {
        lines.push(section.heading);
        section.lines.forEach((line) => lines.push(line));
        lines.push('');
    });

    footerLines.forEach((line) => lines.push(line));
    return lines.join('\n').trim();
};

const renderLabel = (label) => `
    <div style="color:#C0112E;font-size:12px;line-height:1.4;letter-spacing:0.5px;text-transform:uppercase;font-weight:600;margin-bottom:6px;">
        ${escapeHtml(label)}
    </div>
`;

const renderValue = (value, options = {}) => `
    <div style="color:#2A2A2A;font-size:15px;line-height:1.55;${options.monospace ? 'font-family:SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace;' : ''}">
        ${escapeHtml(value)}
    </div>
`;

const renderDetailRow = (label, value, options = {}) => `
    <div style="margin:0 0 14px 0;">
        ${renderLabel(label)}
        ${renderValue(value, options)}
    </div>
`;

const renderCardHtml = (heading, rows) => `
    <div style="background:#FFFFFF;border:0.5px solid #EDEDED;border-radius:12px;padding:18px 20px;margin:0 0 16px 0;">
        <div style="color:#1A1A1A;font-size:18px;font-weight:600;line-height:1.35;margin-bottom:14px;">${escapeHtml(heading)}</div>
        ${rows.join('')}
    </div>
`;

const buildHtmlBody = ({ details, cards, footerLines, jobLink, badgeText }) => {
    const renderedCards = cards.map((card) => renderCardHtml(card.heading, card.rows)).join('');
    const footerText = footerLines.map((line) => `<div style="margin:4px 0;">${line}</div>`).join('');
    const actionButton = jobLink ? `
        <div style="margin:0 0 22px 0;">
            <a href="${escapeHtml(jobLink)}" style="display:inline-block;background:#C0112E;color:#FFFFFF;text-decoration:none;padding:14px 24px;border-radius:10px;font-size:15px;font-weight:600;">
                Open ServiceTrade Job
            </a>
        </div>
    ` : '';

    return `
        <div style="margin:0;padding:24px;background:#F5F5F5;font-family:Arial,sans-serif;">
            <div style="max-width:700px;margin:0 auto;background:#FFFFFF;border:0.5px solid #EDEDED;border-radius:12px;overflow:hidden;">
                <div style="background:#FFF5F6;border-bottom:2px solid #F5C0C8;padding:24px 28px;">
                    <a href="${BRAND_DASHBOARD_URL}" style="display:inline-block;color:#C0112E;font-size:11px;letter-spacing:1px;text-transform:uppercase;text-decoration:none;font-weight:600;">
                        CLARA.AI
                    </a>
                    <div style="color:#1A1A1A;font-size:28px;line-height:1.2;font-weight:500;margin-top:10px;">
                        ${escapeHtml(details.customerName)} | ${escapeHtml(details.emergencyType)}
                    </div>
                    <div style="margin-top:14px;">
                        <span style="display:inline-block;background:#FFE8EC;border:1px solid #F5C0C8;color:#A00E26;padding:8px 14px;border-radius:20px;font-size:13px;font-weight:600;">
                            ${escapeHtml(badgeText)}
                        </span>
                    </div>
                </div>
                <div style="background:#FFFFFF;padding:24px 24px 8px 24px;">
                    <div style="color:#4A4A4A;font-size:17px;line-height:1.6;margin:0 0 18px 0;">
                        Hi Team, a new service request has been received by Clara.
                    </div>
                    ${actionButton}
                    ${renderedCards}
                    <div style="padding:4px 2px 24px 2px;color:#9A9A9A;font-size:12px;line-height:1.6;">
                        ${footerText}
                    </div>
                </div>
            </div>
        </div>
    `;
};

/**
 * WS-6: fetch each escalation (dispatch) call so the email can show what happened on
 * every attempt, not just the final verdict. Best-effort and parallel — a call that
 * cannot be fetched still gets a line, just without its summary or transcript, because
 * a missing recording must never cost the client their notification.
 */
const fetchEscalationCalls = async (callIds = []) => {
    const ids = [...new Set(callIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (ids.length === 0) return [];

    return Promise.all(ids.map(async (id, index) => {
        try {
            const call = await retellService.getCall(id);
            return {
                step: index + 1,
                callId: id,
                toNumber: call.to_number || '',
                summary: (call.call_analysis && call.call_analysis.call_summary) || '',
                transcript: call.transcript || '',
                recordingUrl: call.recording_url || '',
                disconnectionReason: call.disconnection_reason || ''
            };
        } catch (e) {
            console.warn(`[EmailNotificationService] escalation call ${id} could not be fetched: ${e.message || e}`);
            return { step: index + 1, callId: id, unavailable: true };
        }
    }));
};

/**
 * The escalation history card: the sheet's outcome trail verbatim, then one block per
 * dispatch call. Returns null when there is nothing to show, so non-escalation emails
 * (every other tenant) are completely unaffected.
 */
const buildEscalationSection = (details) => {
    const trail = String(details.outcomeTrail || '').trim();
    const calls = Array.isArray(details.escalationCalls) ? details.escalationCalls : [];
    if (!trail && calls.length === 0) return null;

    const lines = [];
    const rows = [];

    if (trail) {
        lines.push('Timeline:', ...trail.split('\n').map((l) => `  ${l}`));
        rows.push(`
            <div style="margin:0 0 14px 0;">
                ${renderLabel('Timeline')}
                <div style="color:#2A2A2A;font-size:15px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(trail)}</div>
            </div>
        `);
    }

    calls.forEach((call) => {
        const label = `Call ${call.step}${call.toNumber ? ` — ${call.toNumber}` : ''}`;

        if (call.unavailable) {
            lines.push(`${label}: details unavailable`);
            rows.push(renderDetailRow(label, 'Call details unavailable'));
            return;
        }

        const parts = [];
        if (call.disconnectionReason) parts.push(`Outcome: ${call.disconnectionReason}`);
        if (call.summary) parts.push(`Summary: ${call.summary}`);
        if (call.recordingUrl) parts.push(`Recording: ${call.recordingUrl}`);
        if (call.transcript) parts.push(`Transcript:\n${call.transcript}`);
        if (parts.length === 0) parts.push('No answer — nothing recorded');

        lines.push(`${label}:`, ...parts.map((p) => `  ${p}`));

        const recordingHtml = call.recordingUrl
            ? `<div style="margin:6px 0;"><a href="${escapeHtml(call.recordingUrl)}" style="color:#C0112E;font-weight:500;text-decoration:none;">Listen to recording</a></div>`
            : '';
        const transcriptHtml = call.transcript
            ? `<div style="margin:8px 0 0 0;color:#4A4A4A;font-size:13px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(call.transcript)}</div>`
            : '';

        rows.push(`
            <div style="margin:0 0 14px 0;">
                ${renderLabel(label)}
                ${renderValue(call.disconnectionReason || 'No answer — nothing recorded')}
                ${call.summary ? `<div style="margin:6px 0;color:#2A2A2A;font-size:14px;line-height:1.5;">${escapeHtml(call.summary)}</div>` : ''}
                ${recordingHtml}
                ${transcriptHtml}
            </div>
        `);
    });

    return { heading: 'Escalation Timeline', lines, rows };
};

const isInactiveLocation = (details) =>
    String((details && details.locationStatus) || '').trim().toLowerCase() === 'inactive';

/**
 * Flag card for a deactivated ServiceTrade location.
 *
 * A job on an inactive location is created, not blocked — the technician was told on the
 * dispatch call and approved anyway. This card exists so the office sees the location
 * record needs attention, and it renders on BOTH the created and the not-created email.
 *
 * locationName / matchedAddress are optional: the Apps Script sends only the status,
 * because the matched-location detail is already in the outcome trail rendered by the
 * Escalation Timeline card and did not justify two more sheet columns.
 */
const buildInactiveLocationSection = (details) => {
    if (!isInactiveLocation(details)) return null;

    const name = String(details.locationName || '').trim();
    const address = String(details.matchedAddress || '').trim();

    const lines = [
        'This address matches a location marked INACTIVE in ServiceTrade.',
        'Dispatch went ahead and the technician was told on the call.'
    ];
    const rows = [renderDetailRow('Status', 'Inactive in ServiceTrade')];

    if (name) {
        lines.push(`Location: ${name}`);
        rows.push(renderDetailRow('Location', name));
    }
    if (address) {
        lines.push(`Matched address: ${address}`);
        rows.push(renderDetailRow('Matched Address', address));
    }
    lines.push('Please review the location record.');
    rows.push(renderDetailRow('Action', 'Please review the location record in ServiceTrade'));

    return { heading: '⚠️ Inactive ServiceTrade Location', lines, rows };
};

// The flag goes in the SUBJECT because the office triages these from the inbox.
const locationFlagPrefix = (details) => {
    if (isInactiveLocation(details)) return '[Inactive Location] ';
    if (isUnmatchedLocation(details)) return '[Address Not On File] ';
    return '';
};

const isUnmatchedLocation = (details) =>
    String((details && details.locationStatus) || '').trim().toLowerCase() === 'none';

/**
 * Flag card for an address that is on no ServiceTrade location at all.
 *
 * The sibling of the inactive card, and for the same reason: dispatch went ahead and
 * the technician decided. The difference is what the office has to DO. An inactive
 * location still has an id, so the job exists and only the record needs review. Here
 * there is no locationId, POST /job cannot run, and the job only exists if someone
 * creates it by hand — so this card asks for that outright.
 */
const buildUnmatchedLocationSection = (details) => {
    if (!isUnmatchedLocation(details)) return null;

    const address = String(details.serviceAddress || details.matchedAddress || '').trim();

    const lines = [
        'This address does not match any location in ServiceTrade.',
        'Dispatch went ahead and the technician was told on the call.'
    ];
    const rows = [renderDetailRow('Status', 'Not on file in ServiceTrade')];

    if (address) {
        lines.push(`Address given by the caller: ${address}`);
        rows.push(renderDetailRow('Address Given', address));
    }

    lines.push('No job could be created automatically — a location record is needed first.');
    rows.push(renderDetailRow('Action', 'Create the location, then the job, in ServiceTrade'));

    return { heading: '⚠️ Address Not On File In ServiceTrade', lines, rows };
};

const buildBaseSections = (details) => {
    const jobLink = details.jobId ? buildServiceTradeJobLink(details) : null;

    return {
        jobLink,
        callSummarySection: {
            heading: 'Call Summary',
            lines: [
                `Type: ${details.emergencyType}`,
                `Priority: ${details.priority}`,
                `Issue: ${details.issueDescription || 'Not provided'}`
            ],
            rows: [
                renderDetailRow('Type', details.emergencyType),
                renderDetailRow('Priority', details.priority),
                renderDetailRow('Issue', details.issueDescription || 'Not provided')
            ]
        },
        callerDetailsSection: {
            heading: 'Caller Details',
            lines: [
                `Name: ${details.customerName}`,
                `Phone: ${details.callerPhone}`,
                `Call ID: ${details.callId || 'Not available'}`
            ],
            rows: [
                renderDetailRow('Name', details.customerName),
                renderDetailRow('Phone', details.callerPhone),
                renderDetailRow('Call ID', details.callId || 'Not available', { monospace: true })
            ]
        },
        serviceLocationSection: {
            heading: 'Service Location',
            lines: [
                `Address: ${details.serviceAddress}`,
                `Location Name: ${details.locationName || 'Not available'}`,
                `Company: ${details.companyName || 'Not available'}`
            ],
            rows: [
                renderDetailRow('Address', details.serviceAddress),
                renderDetailRow('Location Name', details.locationName || 'Not available'),
                renderDetailRow('Company', details.companyName || 'Not available')
            ]
        },
    };
};

const composeJobCreatedEmail = (details) => {
    const {
        callerDetailsSection,
        serviceLocationSection,
        callSummarySection,
        jobLink
    } = buildBaseSections(details);
    const actionLines = ['Job created in ServiceTrade'];
    if (details.jobNumber) actionLines.push(`Job Number: ${details.jobNumber}`);
    actionLines.push(`Call Time: ${details.timestampCentral} (Central Time)`);

    const actionSection = {
        heading: 'Action Taken',
        lines: actionLines
    };
    const actionCardRows = actionLines.map((line) => {
        const [label, ...rest] = line.split(': ');
        if (rest.length > 0) {
            const isMonospace = label.toLowerCase().includes('job number');
            return renderDetailRow(label, rest.join(': '), isMonospace ? { monospace: true } : {});
        }

        return `<div style="color:#2A2A2A;font-size:15px;line-height:1.55;margin:0 0 6px 0;">${escapeHtml(line)}</div>`;
    });
    const actionCard = {
        heading: 'Action Taken',
        rows: actionCardRows
    };
    // Present only for the Adaptive escalation flow; null everywhere else.
    const escalationSection = buildEscalationSection(details);
    // At most one of these applies — an address is either on a location or it is not.
    const inactiveSection = buildInactiveLocationSection(details)
        || buildUnmatchedLocationSection(details);
    const textSections = [
        callerDetailsSection,
        serviceLocationSection,
        callSummarySection,
        actionSection,
        ...(inactiveSection ? [inactiveSection] : []),
        ...(escalationSection ? [escalationSection] : [])
    ];

    return {
        // The flag goes in the SUBJECT, not only the body: the office triages these from
        // the inbox, and a job logged against a deactivated location needs picking out
        // without opening it.
        subject: `${locationFlagPrefix(details)}New Service Request Logged - ${details.customerName} | ${details.emergencyType}`,
        text: buildTextBody({
            introLine: 'Hi Team,',
            sections: textSections,
            footerLines: [
                'Expected callback: Within 10 minutes',
                '',
                'Please review and take necessary action if required.',
                '-- CLARA.AI'
            ]
        }),
        html: buildHtmlBody({
            details,
            cards: [
                callerDetailsSection,
                serviceLocationSection,
                callSummarySection,
                actionCard,
                ...(inactiveSection ? [inactiveSection] : []),
                ...(escalationSection ? [escalationSection] : [])
            ],
            footerLines: [
                'Expected callback: Within 10 minutes',
                'Please review and take necessary action if required.',
                '<a href="https://www.justclara.ai/" style="color:#C0112E;font-weight:500;text-decoration:none;">CLARA.AI</a> &middot; The Only AI Trades Business Needs'
            ],
            jobLink,
            badgeText: details.priority === 'Emergency' ? 'Emergency Job Created' : 'Service Request Logged'
        }),
        jobLink
    };
};

const composeJobNotCreatedEmail = (details) => {
    const {
        callerDetailsSection,
        serviceLocationSection,
        callSummarySection
    } = buildBaseSections(details);
    const actionSection = {
        heading: 'Action Taken',
        lines: [
            'Job was not created in ServiceTrade',
            `Reason: ${details.reasonLabel}`,
            `System Message: ${details.reasonMessage}`
        ]
    };

    if (details.topCandidatesText !== 'Not available') {
        actionSection.lines.push(`Top Candidates:\n${details.topCandidatesText}`);
    }

    if (details.validationSummary) {
        actionSection.lines.push(`Validation Details: ${details.validationSummary}`);
    }
    actionSection.lines.push(`Call Time: ${details.timestampCentral} (Central Time)`);

    const actionCardRows = [
        `<div style="color:#2A2A2A;font-size:15px;line-height:1.55;margin:0 0 6px 0;">Job was not created in ServiceTrade</div>`,
        renderDetailRow('Reason', details.reasonLabel),
        renderDetailRow('System Message', details.reasonMessage)
    ];
    if (details.topCandidatesText !== 'Not available') {
        actionCardRows.push(renderDetailRow('Top Candidates', details.topCandidatesText));
    }
    if (details.validationSummary) {
        actionCardRows.push(renderDetailRow('Validation Details', details.validationSummary));
    }
    actionCardRows.push(renderDetailRow('Call Time', `${details.timestampCentral} (Central Time)`));
    // Present only for the Adaptive escalation flow; null everywhere else.
    const escalationSection = buildEscalationSection(details);
    // At most one of these applies — an address is either on a location or it is not.
    const inactiveSection = buildInactiveLocationSection(details)
        || buildUnmatchedLocationSection(details);
    const textSections = [
        callerDetailsSection,
        serviceLocationSection,
        callSummarySection,
        actionSection,
        ...(inactiveSection ? [inactiveSection] : []),
        ...(escalationSection ? [escalationSection] : [])
    ];

    const isNotServiceCall = details.reasonCode === 'not_a_service_call';
    const inactivePrefix = locationFlagPrefix(details);
    const subject = isNotServiceCall
        ? `${inactivePrefix}Not a Service Call - ${details.customerName} | ${details.emergencyType}`
        : `${inactivePrefix}Service Request Needs Review - ${details.customerName} | ${details.emergencyType}`;
    const badgeText = isNotServiceCall ? 'Not a Service Call' : 'Manual Review Needed';

    return {
        subject,
        text: buildTextBody({
            introLine: 'Hi Team,',
            sections: textSections,
            footerLines: [
                'Please review and take necessary action if required.',
                '-- CLARA.AI'
            ]
        }),
        html: buildHtmlBody({
            details,
            cards: [
                callerDetailsSection,
                serviceLocationSection,
                callSummarySection,
                {
                    heading: 'Action Taken',
                    rows: actionCardRows
                },
                ...(inactiveSection ? [inactiveSection] : []),
                ...(escalationSection ? [escalationSection] : [])
            ],
            footerLines: [
                'Please review and take necessary action if required.',
                '<a href="https://www.justclara.ai/" style="color:#C0112E;font-weight:500;text-decoration:none;">CLARA.AI</a> &middot; The Only AI Trades Business Needs'
            ],
            jobLink: null,
            badgeText
        })
    };
};

// Recipients of internal error/alert emails, configurable via the
// INTERNAL_ALERT_RECIPIENTS env var (see src/config/environment.js).
const INTERNAL_ALERT_RECIPIENTS = config.internalAlertRecipients;

class EmailNotificationService {
    constructor() {
        this.isConfigured = Boolean(config.sendgridApiKey);
        if (this.isConfigured) {
            sgMail.setApiKey(config.sendgridApiKey);
        }
    }

    async sendInternalAlert({ callId, agentId, companyName, errorType, errorMessage }) {
        if (!this.isConfigured) return;

        const isUnauthorized = /401|unauthorized/i.test(errorMessage || '');
        const subject = isUnauthorized
            ? `[CLARA ALERT] 401 Unauthorized — ServiceTrade token expired | ${companyName || agentId}`
            : `[CLARA ALERT] Webhook error — ${errorType || 'Unknown'} | ${companyName || agentId}`;

        const timestamp = formatTimestampCentral(Date.now());
        const html = `
            <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#F5F5F5;">
                <div style="background:#FFFFFF;border:0.5px solid #EDEDED;border-radius:12px;overflow:hidden;">
                    <div style="background:#FFF3CD;border-bottom:2px solid #FFC107;padding:20px 24px;">
                        <div style="color:#C0112E;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:600;">CLARA.AI — Internal Alert</div>
                        <div style="color:#1A1A1A;font-size:22px;font-weight:600;margin-top:8px;">⚠ Webhook Processing Error</div>
                    </div>
                    <div style="padding:24px;">
                        <div style="margin-bottom:14px;"><div style="color:#C0112E;font-size:12px;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Error Type</div><div style="font-size:15px;color:#2A2A2A;">${escapeHtml(errorType || 'Internal Error')}</div></div>
                        <div style="margin-bottom:14px;"><div style="color:#C0112E;font-size:12px;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Error Message</div><div style="font-size:15px;color:#2A2A2A;font-family:monospace;">${escapeHtml(errorMessage || 'No message')}</div></div>
                        <div style="margin-bottom:14px;"><div style="color:#C0112E;font-size:12px;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Company / Agent</div><div style="font-size:15px;color:#2A2A2A;">${escapeHtml(companyName || 'Unknown')} &mdash; <span style="font-family:monospace;">${escapeHtml(agentId || 'N/A')}</span></div></div>
                        <div style="margin-bottom:14px;"><div style="color:#C0112E;font-size:12px;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Call ID</div><div style="font-size:15px;color:#2A2A2A;font-family:monospace;">${escapeHtml(callId || 'N/A')}</div></div>
                        <div style="margin-bottom:14px;"><div style="color:#C0112E;font-size:12px;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Time (Central)</div><div style="font-size:15px;color:#2A2A2A;">${escapeHtml(timestamp)}</div></div>
                        ${isUnauthorized ? `<div style="background:#FFF3CD;border:1px solid #FFC107;border-radius:8px;padding:12px 16px;margin-top:8px;color:#856404;font-size:14px;">The ServiceTrade session token has expired or is invalid. Please log in to ServiceTrade and update the <strong>auth_token</strong> in Supabase for this agent.</div>` : ''}
                    </div>
                    <div style="padding:0 24px 20px;color:#9A9A9A;font-size:12px;">
                        <a href="${BRAND_DASHBOARD_URL}" style="color:#C0112E;text-decoration:none;font-weight:500;">CLARA.AI</a> &middot; The Only AI Trades Business Needs
                    </div>
                </div>
            </div>
        `;

        const text = [
            'CLARA.AI — Internal Webhook Alert',
            '',
            `Error Type: ${errorType || 'Internal Error'}`,
            `Error Message: ${errorMessage || 'No message'}`,
            `Company / Agent: ${companyName || 'Unknown'} — ${agentId || 'N/A'}`,
            `Call ID: ${callId || 'N/A'}`,
            `Time (Central): ${timestamp}`,
            isUnauthorized ? '\nACTION REQUIRED: ServiceTrade token has expired. Update auth_token in Supabase.' : ''
        ].join('\n').trim();

        try {
            await sgMail.send({
                to: INTERNAL_ALERT_RECIPIENTS,
                from: { email: config.notificationEmailFrom, name: config.notificationEmailFromName },
                subject,
                text,
                html
            });
        } catch (alertError) {
            console.error(JSON.stringify({ level: 'error', message: 'Failed to send internal alert email', error: alertError.message }));
        }
    }

    isNotificationEnabled(settings = {}, outcome = 'job_created') {
        if (!this.isConfigured) return false;
        if (!normalizeBoolean(settings.send_job_email)) return false;

        if (outcome === 'job_not_created') {
            return normalizeBoolean(settings.send_job_fail_email);
        }

        return true;
    }

    async sendJobNotification({ settings = {}, outcome, details = {}, overrideTo = null, overrideCc = null }) {
        console.log(`[EmailNotificationService] sendJobNotification triggered — outcome: ${outcome}, callId: ${details.callId || 'N/A'}`);
        if (!this.isNotificationEnabled(settings, outcome) && !overrideTo) {
            return { sent: false, skipped: true, reason: 'notifications_disabled' };
        }

        if (!this.isConfigured) {
            return { sent: false, skipped: true, reason: 'sendgrid_not_configured' };
        }

        const to = overrideTo ? parseEmailList(overrideTo) : parseEmailList(settings.emailto);
        const cc = overrideTo ? parseEmailList(overrideCc) : parseEmailList(settings.ccmail);

        if (to.length === 0) {
            return { sent: false, skipped: true, reason: 'no_recipients' };
        }

        // WS-6 (Adaptive escalation only): pull each dispatch call from Retell so the
        // email can show the full escalation history. Done here rather than in the
        // compose helpers because those are synchronous. No ids -> no fetch, so every
        // other caller is untouched.
        const escalationCalls = await fetchEscalationCalls(details.escalationCallIds);

        const normalizedDetails = {
            ...details,
            escalationCalls,
            customerName: details.customerName || 'Unknown Caller',
            callerPhone: details.callerPhone || 'Not provided',
            serviceAddress: formatAddress(details.serviceAddress),
            emergencyType: inferEmergencyType(details),
            priority: details.priority || 'Non-Emergency',
            timestampCentral: formatTimestampCentral(details.timestamp),
            reasonLabel: details.reasonLabel || toTitleCase(details.reasonCode || 'manual_review_required'),
            reasonMessage: details.reasonMessage || 'Manual review required before dispatch',
            topCandidatesText: formatCandidateList(details.topCandidates),
            validationSummary: details.validationSummary || null
        };

        const message = outcome === 'job_created'
            ? composeJobCreatedEmail(normalizedDetails)
            : composeJobNotCreatedEmail(normalizedDetails);

        const mail = {
            to,
            cc: cc.length > 0 ? cc : undefined,
            from: {
                email: config.notificationEmailFrom,
                name: config.notificationEmailFromName
            },
            subject: message.subject,
            text: message.text,
            html: message.html,
            customArgs: {
                outcome: String(outcome),
                callId: String(details.callId || ''),
                agentId: String(details.agentId || '')
            }
        };

        console.log(`[EmailNotificationService] Sending email — to: ${to.join(', ')}${cc.length > 0 ? `, cc: ${cc.join(', ')}` : ''}, subject: "${mail.subject}"`);
        try {
            await sgMail.send(mail);
        } catch (err) {
            const sgError = err.response?.body?.errors?.[0]?.message || err.message;
            console.error(`[EmailNotificationService] SendGrid send failed — ${sgError}`, err);
            throw err;
        }

        return {
            sent: true,
            to,
            cc,
            subject: message.subject,
            jobLink: message.jobLink || null
        };
    }
}

module.exports = new EmailNotificationService();
