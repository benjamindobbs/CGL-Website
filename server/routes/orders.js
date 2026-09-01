const { Router } = require('express');
const { db, applyStockDelta } = require('../db');
const { requireAuth } = require('../auth');
const { requireStaff } = require('../staffAuth');

const router = Router();

// Any signed-in school account (not just staff) can place an order.
router.post('/', requireAuth, (req, res) => {
    const { customerName, email, studentId, cart } = req.body;
    if (!customerName || !email) return res.status(400).json({ error: 'Missing name or email' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    // Re-price every line against the live catalog — never trust client-sent
    // prices. Must be active AND orderable: the same gate the order page uses.
    const lines = [];
    for (const line of cart) {
        const item = db.prepare('SELECT * FROM items WHERE uuid = ? AND active = 1 AND orderable = 1').get(line.uuid);
        if (!item) return res.status(400).json({ error: `Item ${line.uuid} is no longer available to order` });
        const qty = Number(line.qty);
        if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: `Invalid quantity for ${item.name}` });
        lines.push({ item, qty, lineTotalCents: item.price_cents * qty });
    }

    const totalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
    const now = Date.now();

    db.exec('BEGIN');
    let orderId;
    try {
        const orderResult = db.prepare(`
            INSERT INTO orders(user_key, customer_name, email, student_id, status, total_cents, created_at, updated_at)
            VALUES(?, ?, ?, ?, 'new', ?, ?, ?)
        `).run(req.userKey, customerName, email, studentId || '', totalCents, now, now);
        orderId = orderResult.lastInsertRowid;

        const insertLine = db.prepare(`
            INSERT INTO order_items(order_id, item_uuid, item_name, variant_color, variant_size, qty, unit_price_cents, line_total_cents)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const l of lines) {
            insertLine.run(orderId, l.item.uuid, l.item.name, l.item.variant_color, l.item.variant_size, l.qty, l.item.price_cents, l.lineTotalCents);
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Order creation failed:', err);
        return res.status(500).json({ error: 'Server error placing order' });
    }

    // Stock is decremented as a demand signal, not a gate — orders are
    // made-to-order and are never blocked by stock_qty (can go negative).
    for (const l of lines) {
        applyStockDelta({ itemUuid: l.item.uuid, delta: -l.qty, reason: 'order', actorUserKey: req.userKey, refOrderId: orderId });
    }

    // TODO(online-payments): once real payment handling exists, an order that
    // has actually been PAID must also be written to the financial ledger so
    // the transaction log / CSV export (routes/transactions.js) stays complete.
    // One recordTransaction() call per line item — its `account` is the item
    // category — mirroring how routes/inventory.js records counter sales:
    //   recordTransaction({
    //       type: 'deposit', vendor: 'Online Pay',
    //       amountCents: l.lineTotalCents, account: l.item.category,
    //       notes: `${l.item.name} x${l.qty}`,
    //       source: 'online_order', refOrderId: orderId, actorUserKey: req.userKey,
    //   });
    // Refunds record a matching 'withdrawal'. Do NOT record here today: nothing
    // has been paid yet at order-placement time.

    res.status(201).json({ orderId, totalCents });
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

router.patch('/:id', requireStaff, (req, res) => {
    const { status } = req.body;
    const allowed = ['new', 'in_progress', 'fulfilled', 'cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const result = db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Date.now(), req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });

    res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
});

module.exports = router;
