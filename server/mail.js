// Transactional email via Resend. Patterned on server/stripe.js: the app boots
// fine with no key set — sendMail() then logs a warning and resolves false, so
// callers (which fire-and-forget) never break.
//
//   fly secrets set RESEND_API_KEY=re_xxx
//
// Sending domain madein.school is verified in Resend; any address on it works.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'CGL Requests <noreply-requests@madein.school>';
const DEFAULT_REPLY_TO = process.env.MAIL_REPLY_TO || 'contact@madein.school';
const LAB_INBOX = process.env.LAB_INBOX || 'contact@madein.school';

function isMailConfigured() {
    return Boolean(RESEND_API_KEY);
}

if (!isMailConfigured()) {
    console.warn('[mail] RESEND_API_KEY not set — outgoing email is disabled.');
}

// Resolves true on a 2xx from Resend, false otherwise (never throws).
async function sendMail({ to, subject, html, replyTo = DEFAULT_REPLY_TO }) {
    if (!isMailConfigured()) {
        console.warn(`[mail] skipped (no key): "${subject}" -> ${Array.isArray(to) ? to.join(', ') : to}`);
        return false;
    }
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: FROM,
                to: Array.isArray(to) ? to : [to],
                reply_to: replyTo,
                subject,
                html,
            }),
        });
        if (!res.ok) {
            console.error(`[mail] Resend ${res.status}: ${await res.text().catch(() => '')}`);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[mail] send failed:', err);
        return false;
    }
}

// Minimal HTML escaping for values interpolated into email bodies.
function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
}

module.exports = { isMailConfigured, sendMail, esc, LAB_INBOX };
