const { Router } = require('express');
const { db, ITEM_CATEGORIES } = require('../db');
const { requireStaff } = require('../staffAuth');

const router = Router();
router.use(requireStaff);

// Total income per item category, split into online orders and counter
// (storefront) sales. Cancelled orders are excluded. Counter sales are valued
// at the item's current price (stock_events records quantity, not price).
router.get('/income-by-category', (_req, res) => {
    const orderRows = db.prepare(`
        SELECT i.category AS category, SUM(oi.line_total_cents) AS cents
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN items  i ON i.uuid = oi.item_uuid
        WHERE o.status <> 'cancelled'
        GROUP BY i.category
    `).all();

    const counterRows = db.prepare(`
        SELECT i.category AS category, SUM(-se.delta * i.price_cents) AS cents
        FROM stock_events se
        JOIN items i ON i.uuid = se.item_uuid
        WHERE se.reason = 'storefront_sale'
        GROUP BY i.category
    `).all();

    const byCategory = new Map();
    const bucket = (name) => {
        if (!byCategory.has(name)) byCategory.set(name, { category: name, orderCents: 0, counterCents: 0 });
        return byCategory.get(name);
    };

    // Seed the fixed categories so they always appear, even at zero.
    for (const name of ITEM_CATEGORIES) bucket(name);

    for (const row of orderRows) bucket(row.category).orderCents += row.cents || 0;
    for (const row of counterRows) bucket(row.category).counterCents += row.cents || 0;

    const categories = [...byCategory.values()]
        .map((c) => ({ ...c, totalCents: c.orderCents + c.counterCents }))
        .sort((a, b) => b.totalCents - a.totalCents || a.category.localeCompare(b.category));

    const totals = categories.reduce(
        (acc, c) => ({
            orderCents: acc.orderCents + c.orderCents,
            counterCents: acc.counterCents + c.counterCents,
            totalCents: acc.totalCents + c.totalCents,
        }),
        { orderCents: 0, counterCents: 0, totalCents: 0 }
    );

    res.json({ categories, totals });
});

module.exports = router;
