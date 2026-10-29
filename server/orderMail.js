// Store-order emails: a notice to the lab inbox and a confirmation to the
// customer. Sent once an order is actually settled: from the Stripe webhook for
// paid orders (routes/payments.js), or straight from checkout for $0 orders
// (routes/orders.js). Fire-and-forget like the job-request emails — a mail
// failure never affects the order.
const { db } = require('./db');
const { PUBLIC_BASE_URL } = require('./stripe');
const { sendMail, esc, LAB_INBOX } = require('./mail');

const ORDERS_FROM = process.env.MAIL_FROM_ORDERS || 'Classical Graphics Lab <noreply-orders@madein.school>';

function dollars(cents) {
    return `$${(cents / 100).toFixed(2)}`;
}

function detailTable(rows) {
    return '<table>' + rows.map(([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;vertical-align:top"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('') +
        '</table>';
}

function itemTable(order, lines) {
    const cell = (v, align = 'left') => `<td style="padding:2px 12px 2px 0" align="${align}">${esc(v)}</td>`;
    const rows = lines.map((l) => {
        const variant = [l.variant_color, l.variant_size].filter(Boolean).join(' ');
        return `<tr>${cell(l.item_name + (variant ? ` (${variant})` : ''))}${cell(l.qty, 'right')}${cell(dollars(l.line_total_cents), 'right')}</tr>`;
    }).join('');
    return '<table><tr><th align="left">Item</th><th align="right">Qty</th><th align="right">Total</th></tr>' +
        rows +
        `<tr><td style="padding-top:6px"><b>Total</b></td><td></td><td style="padding-top:6px" align="right"><b>${esc(dollars(order.total_cents))}</b></td></tr>` +
        '</table>' +
        (order.tax_cents > 0 ? `<p style="color:#666">Includes ${esc(dollars(order.tax_cents))} CT sales tax.</p>` : '');
}

// Customer-facing wrapper: logo header + footer. Email clients don't render SVG,
// so the logo is a PNG (assets/CGL-Logo-email.png, a 2x render of CGL-Logo.svg)
// loaded from the live site; without PUBLIC_BASE_URL it falls back to text.
function brandedEmail(bodyHtml) {
    const small = 'margin:0 0 10px;font-size:12px;line-height:1.5;color:#666';
    const header = PUBLIC_BASE_URL
        ? `<img src="${esc(PUBLIC_BASE_URL)}/assets/CGL-Logo-email.png" width="240" height="85" alt="Classical Graphics Lab" style="display:block;border:0">`
        : '<span style="font-size:22px;font-weight:bold;color:#1b75bb">Classical Graphics Lab</span>';
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#222">' +
        `<tr><td style="padding:16px 0 20px;border-bottom:3px solid #1b75bb">${header}</td></tr>` +
        `<tr><td style="padding:20px 0;font-size:14px;line-height:1.5">${bodyHtml}</td></tr>` +
        '<tr><td style="padding:16px 0;border-top:1px solid #ddd">' +
        `<p style="${small}"><b>Pickup:</b> Order pickup is available upon completion at the school store between 7:00–7:30 AM and 2:10–2:30 PM, or whenever the store is open.</p>` +
        `<p style="${small}">Your support means a lot to us. All profit made goes towards student activity funds, the needs of the school, and to support the upkeep and maintenance of this program.</p>` +
        `<p style="${small}">Classical Graphics Lab is a School Based Enterprise operated by students. Any correspondence from non-Hartford Public Schools employees will always come from certified staff. Any internal correspondence may come from students, with staff always included on all emails.</p>` +
        `<p style="${small}">Classical Graphics Lab is a DBA of Advocates of Classical Magnet, a registered 501(c)(3), permitted to collect CT taxes by the State of Connecticut.</p>` +
        `<p style="${small};margin-bottom:0">Have questions? Feel free to reach out to us at <a href="mailto:contact@madein.school" style="color:#1b75bb">contact@madein.school</a>.</p>` +
        '</td></tr></table>';
}

function sendOrderEmails(orderId) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return;
    const lines = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
    const free = order.payment_status === 'free';
    const items = itemTable(order, lines);

    const labHtml =
        `<p>New store order #${order.id}.</p>` +
        detailTable([
            ['Customer', `${order.customer_name} <${order.email}>`],
            ['Student ID', order.student_id || '—'],
            ['Payment', free ? 'No charge ($0 order)' : `${dollars(order.total_cents)} paid online`],
        ]) +
        '<p><b>Items</b></p>' + items +
        (PUBLIC_BASE_URL ? `<p><a href="${esc(PUBLIC_BASE_URL)}/admin/orders/">Open orders</a></p>` : '');

    sendMail({
        to: LAB_INBOX,
        subject: `New order #${order.id}: ${order.customer_name} (${free ? 'no charge' : dollars(order.total_cents)})`,
        html: labHtml,
        replyTo: order.email,
    }).catch((err) => console.error('[orders] lab notify failed:', err));

    const customerHtml =
        `<p>Hi ${esc(order.customer_name)},</p>` +
        `<p>Thanks for your order! The Classical Graphics Lab received order <b>#${order.id}</b>` +
        (free ? '.' : ` and your payment of <b>${esc(dollars(order.total_cents))}</b> went through.`) +
        ' We\'ll email you with any updates. Reply here if you have questions.</p>' +
        items;

    sendMail({
        from: ORDERS_FROM,
        to: order.email,
        subject: free ? `Order #${order.id} received` : `Order #${order.id} confirmed: ${dollars(order.total_cents)} paid`,
        html: brandedEmail(customerHtml),
    }).catch((err) => console.error('[orders] customer confirm failed:', err));
}

module.exports = { sendOrderEmails };
