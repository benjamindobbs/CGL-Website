const { Router } = require('express');
const { db, applyStockDelta, recordTransaction, normalizeCategory, splitTaxInclusive, isSubcategoryTaxExempt, ITEM_SELECT } = require('../db');
const { requireAuth } = require('../auth');
const { requireStaff } = require('../staffAuth');
const { stripe, isStripeConfigured, PUBLIC_BASE_URL } = require('../stripe');

const router = Router();

function variantLabel(row) {
    const v = [row.variant_color, row.variant_size].filter(Boolean).join(' ');
    return v ? ` (${v})` : '';
}

function linesFor(orderId) {
    return db.prepare(`
        SELECT oi.*, i.category AS item_category
        FROM order_items oi
        LEFT JOIN items i ON i.uuid = oi.item_uuid
        WHERE oi.order_id = ?
    `).all(orderId);
}

function deleteOrder(orderId) {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
}

// Any signed-in school account (not just staff) can place an order.
router.post('/', requireAuth, async (req, res) => {
    const { customerName, email, studentId, cart } = req.body;
    if (!customerName || !email) return res.status(400).json({ error: 'Missing name or email' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    // Re-price every line against the live catalog — never trust client-sent
    // prices. Must be active AND orderable: the same gate the order page uses.
    const lines = [];
    for (const line of cart) {
        const item = db.prepare(`${ITEM_SELECT} WHERE i.uuid = ? AND i.active = 1 AND i.orderable = 1`).get(line.uuid);
        if (!item) return res.status(400).json({ error: `Item ${line.uuid} is no longer available to order` });
        const qty = Number(line.qty);
        if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: `Invalid quantity for ${item.name}` });
        const lineTotalCents = item.price_cents * qty;
        // price_cents is tax-inclusive; pull the CT sales tax back out of the
        // line total (0 for items in a "Supplies" sub-category).
        const { taxCents } = splitTaxInclusive(lineTotalCents, !isSubcategoryTaxExempt(item.subcategory));
        lines.push({ item, qty, lineTotalCents, taxCents });
    }

    const totalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
    const taxCentsTotal = lines.reduce((sum, l) => sum + l.taxCents, 0);
    const paymentStatus = totalCents === 0 ? 'free' : 'unpaid';

    // A paid order needs Stripe up before we create anything.
    if (totalCents > 0 && !isStripeConfigured()) {
        return res.status(503).json({ error: 'Online payment isn’t set up yet. Please contact the school store.' });
    }

    const now = Date.now();
    db.exec('BEGIN');
    let orderId;
    try {
        const orderResult = db.prepare(`
            INSERT INTO orders(user_key, customer_name, email, student_id, status, total_cents, tax_cents, payment_status, created_at, updated_at)
            VALUES(?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)
        `).run(req.userKey, customerName, email, studentId || '', totalCents, taxCentsTotal, paymentStatus, now, now);
        orderId = Number(orderResult.lastInsertRowid);

        const insertLine = db.prepare(`
            INSERT INTO order_items(order_id, item_uuid, item_name, variant_color, variant_size, qty, unit_price_cents, line_total_cents, tax_cents)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const l of lines) {
            insertLine.run(orderId, l.item.uuid, l.item.name, l.item.variant_color, l.item.variant_size, l.qty, l.item.price_cents, l.lineTotalCents, l.taxCents);
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Order creation failed:', err);
        return res.status(500).json({ error: 'Server error placing order' });
    }

    // $0 order (e.g. "Embroidery Only"): nothing to charge. Move stock now — the
    // paid path does this from the Stripe webhook instead — and finish.
    if (totalCents === 0) {
        for (const l of lines) {
            applyStockDelta({ itemUuid: l.item.uuid, delta: -l.qty, reason: 'order', actorUserKey: req.userKey, refOrderId: orderId });
        }
        return res.status(201).json({ orderId, free: true });
    }

    // Paid order: hand off to Stripe Checkout. Stock and the financial-ledger
    // rows are written only once payment confirms, in routes/payments.js.
    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: lines
                .filter((l) => l.item.price_cents > 0)
                .map((l) => ({
                    quantity: l.qty,
                    price_data: {
                        currency: 'usd',
                        unit_amount: l.item.price_cents,
                        product_data: { name: `${l.item.name}${variantLabel(l.item)}` },
                    },
                })),
            customer_email: email,
            client_reference_id: String(orderId),
            metadata: { order_id: String(orderId) },
            success_url: `${PUBLIC_BASE_URL}/thanks/?order=${orderId}`,
            cancel_url: `${PUBLIC_BASE_URL}/order/`,
        }, { idempotencyKey: `order-${orderId}` });

        db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(session.id, orderId);
        return res.status(201).json({ orderId, checkoutUrl: session.url });
    } catch (err) {
        console.error('Stripe Checkout session creation failed:', err);
        deleteOrder(orderId);
        return res.status(502).json({ error: 'Could not start payment. Please try again.' });
    }
});

router.get('/', requireStaff, (req, res) => {
    const { status } = req.query;
    const orders = status
        ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC').all(status)
        : db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();

    const itemsByOrder = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
    for (const order of orders) {
        order.items = itemsByOrder.all(order.id);
    }
    res.json(orders);
});

router.patch('/:id', requireStaff, async (req, res) => {
    const { status } = req.body;
    const allowed = ['new', 'in_progress', 'fulfilled', 'cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const cancelling = status === 'cancelled' && order.status !== 'cancelled';

    // Refund + reverse stock when a paid (or $0) order is cancelled.
    if (cancelling && order.payment_status === 'paid') {
        if (!isStripeConfigured() || !order.payment_intent) {
            return res.status(502).json({ error: 'Cannot refund: payment reference missing or Stripe not configured.' });
        }
        try {
            await stripe.refunds.create({ payment_intent: order.payment_intent });
        } catch (err) {
            console.error('Stripe refund failed for order', order.id, err);
            return res.status(502).json({ error: 'Refund failed at Stripe. Order not changed.' });
        }
        db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run('refunded', order.id);
        for (const line of linesFor(order.id)) {
            recordTransaction({
                type: 'withdrawal',
                vendor: 'Online Pay',
                amountCents: line.line_total_cents,
                taxCents: line.tax_cents,
                account: normalizeCategory(line.item_category),
                notes: `Refund: ${line.item_name}${variantLabel(line)} x${line.qty}`,
                source: 'online_order',
                refOrderId: order.id,
                actorUserKey: req.userKey,
            });
            applyStockDelta({
                itemUuid: line.item_uuid, delta: line.qty, reason: 'adjustment',
                actorUserKey: req.userKey, refOrderId: order.id, note: `order #${order.id} cancelled`,
            });
        }
    } else if (cancelling && order.payment_status === 'free') {
        for (const line of linesFor(order.id)) {
            applyStockDelta({
                itemUuid: line.item_uuid, delta: line.qty, reason: 'adjustment',
                actorUserKey: req.userKey, refOrderId: order.id, note: `order #${order.id} cancelled`,
            });
        }
    }

    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), order.id);
    res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
});

module.exports = router;
