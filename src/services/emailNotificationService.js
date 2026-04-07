const sgMail = require('@sendgrid/mail');
const config = require('../config/environment');

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
    const explicitType = details.emergencyType || details.issueType;
    if (explicitType) return explicitType;

    if (details.serviceLineId && SERVICE_LINE_LABELS[details.serviceLineId]) {
        return SERVICE_LINE_LABELS[details.serviceLineId];
    }

    const haystack = [
        details.issueDescription,
        details.callSummary,
        details.locationName,
        details.companyName
    ].filter(Boolean).join(' ').toLowerCase();

    if (haystack.includes('sprinkler')) return 'Sprinkler';
    if (haystack.includes('alarm')) return 'Alarm';
    if (haystack.includes('fire')) return 'Fire Emergency';
    if (details.priority === 'Emergency') return 'Emergency Dispatch';
    return 'Service Request';
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
                `Phone: ${details.callerPhone}`
            ],
            rows: [
                renderDetailRow('Name', details.customerName),
                renderDetailRow('Phone', details.callerPhone)
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
    const textSections = [
        callerDetailsSection,
        serviceLocationSection,
        callSummarySection,
        actionSection
    ];

    return {
        subject: `New Service Request Logged - ${details.customerName} | ${details.emergencyType}`,
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
                actionCard
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
    const textSections = [
        callerDetailsSection,
        serviceLocationSection,
        callSummarySection,
        actionSection
    ];

    return {
        subject: `Service Request Needs Review - ${details.customerName} | ${details.emergencyType}`,
        text: buildTextBody({
            introLine: 'Hi Team,',
            sections: textSections,
            footerLines: [
                'Expected callback: Manual review needed',
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
                {
                    heading: 'Action Taken',
                    rows: actionCardRows
                }
            ],
            footerLines: [
                'Expected callback: Manual review needed',
                'Please review and take necessary action if required.',
                '<a href="https://www.justclara.ai/" style="color:#C0112E;font-weight:500;text-decoration:none;">CLARA.AI</a> &middot; The Only AI Trades Business Needs'
            ],
            jobLink: null,
            badgeText: 'Manual Review Needed'
        })
    };
};

class EmailNotificationService {
    constructor() {
        this.isConfigured = Boolean(config.sendgridApiKey);
        if (this.isConfigured) {
            sgMail.setApiKey(config.sendgridApiKey);
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

        const normalizedDetails = {
            ...details,
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

        await sgMail.send(mail);

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
