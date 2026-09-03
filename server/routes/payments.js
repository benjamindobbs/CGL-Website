const express = require('express');
const { db, applyStockDelta, recordTransaction, normalizeCategory } = require('../db');
const { stripe, isStripeConfigured, STRIPE_WEBHOOK_SECRET } = require('../stripe');

const router = express.Router();

function variantLabel(row) {
    const v = [row.variant_color, row.variant_size].filter(Boolean).join(' ');
    return v ? ` (${v})` : '';
}

function orderLines(orderId) {
    return db.prepare(`
        SELECT oi.*, i.category AS item_category
        FROM order_items oi
        LEFT JOIN items i ON i.uuid = oi.item_uuid
        WHERE oi.order_id = ?
    `).all(orderId);
}

// Marks a paid online order settled: flips payment_status, then moves stock and
// writes one deposit per line to the financial ledger (see TODO(online-payments)
// that this fulfils). The UPDATE is a compare-and-swap on payment_status so a
// duplicate/retried webhook delivery can't double-count.
function settlePaidOrder(order, paymentIntentId) {
    const claim = db.prepare(
        "UPDATE orders SET payment_status = 'paid', payment_intent = ? WHERE id = ? AND payment_status <> 'paid'"
    ).run(paymentIntentId || null, order.id);
    if (claim.changes === 0) return; // already settled by an earlier delivery

    for (const line of orderLines(order.id)) {
        applyStockDelta({
            itemUuid: line.item_uuid,
            delta: -line.qty,
            reason: 'order',
            actorUserKey: order.user_key,
            refOrderId: order.id,
        });
        recordTransaction({
            type: 'deposit',
            vendor: 'Online Pay',
            amountCents: line.line_total_cents,
            taxCents: line.tax_cents,
            account: normalizeCategory(line.item_category),
            notes: `${line.item_name}${variantLabel(line)} x${line.qty}`,
            source: 'online_order',
            refOrderId: order.id,
            actorUserKey: order.user_key,
        });
    }
}

// Stripe needs the raw body to verify the signature, so this route parses its
// own body and must be mounted before the app-wide express.json().
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    if (!isStripeConfigured()) return res.status(500).send('Stripe not configured');

    let event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            req.headers['stripe-signature'],
            STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('[stripe] webhook signature check failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const orderId = Number(session.client_reference_id || session.metadata?.order_id);
            const order = orderId && db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

            if (!order) {
                console.error('[stripe] completed session for unknown order', orderId, session.id);
            } else if (session.payment_status === 'paid') {
                settlePaidOrder(order, session.payment_intent);
            }
        } else if (event.type === 'checkout.session.expired') {
            const session = event.data.object;
            const orderId = Number(session.client_reference_id || session.metadata?.order_id);
            if (orderId) {
                db.prepare(
                    "UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND payment_status = 'unpaid'"
                ).run(Date.now(), orderId);
            }
        }
    } catch (err) {
        console.error('[stripe] webhook handler error:', err);
        return res.status(500).send('handler error');
    }

    res.json({ received: true });
});

module.exports = router;
