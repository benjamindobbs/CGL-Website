const { Router } = require('express');
const { db, ITEM_CATEGORIES } = require('../db');
const { requireStaff } = require('../staffAuth');

const router = Router();
router.use(requireStaff);

const UNFILED = 'Unfiled';

// Total income per item category, split into online orders and counter
// (storefront) sales, and broken down again per sub-category within each top
// category. Cancelled orders are excluded. Counter sales are valued at the
// item's current price (stock_events records quantity, not price).
router.get('/income-by-category', (_req, res) => {
    const orderRows = db.prepare(`
        SELECT i.category AS category, s.name AS subcategory, SUM(oi.line_total_cents) AS cents
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN items  i ON i.uuid = oi.item_uuid
        LEFT JOIN subcategories s ON s.id = i.subcategory_id
        WHERE o.status <> 'cancelled'
        GROUP BY i.category, s.name
    `).all();

    const counterRows = db.prepare(`
        SELECT i.category AS category, s.name AS subcategory, SUM(-se.delta * i.price_cents) AS cents
        FROM stock_events se
        JOIN items i ON i.uuid = se.item_uuid
        LEFT JOIN subcategories s ON s.id = i.subcategory_id
        WHERE se.reason = 'storefront_sale'
        GROUP BY i.category, s.name
    `).all();

    const byCategory = new Map();
    const bucket = (name) => {
        if (!byCategory.has(name)) {
            byCategory.set(name, { category: name, orderCents: 0, counterCents: 0, subs: new Map() });
        }
        return byCategory.get(name);
    };
    const subBucket = (catName, subName) => {
        const cat = bucket(catName);
        const key = subName || UNFILED;
        if (!cat.subs.has(key)) cat.subs.set(key, { name: key, orderCents: 0, counterCents: 0 });
        return cat.subs.get(key);
    };

    // Seed the fixed categories and every defined sub-category so they always
    // appear, even at zero.
    for (const name of ITEM_CATEGORIES) bucket(name);
    for (const sub of db.prepare('SELECT name, category FROM subcategories').all()) {
        subBucket(sub.category, sub.name);
    }

    for (const row of orderRows) {
        bucket(row.category).orderCents += row.cents || 0;
        subBucket(row.category, row.subcategory).orderCents += row.cents || 0;
    }
    for (const row of counterRows) {
        bucket(row.category).counterCents += row.cents || 0;
        subBucket(row.category, row.subcategory).counterCents += row.cents || 0;
    }

    const withTotal = (b) => ({ ...b, totalCents: b.orderCents + b.counterCents });

    const categories = [...byCategory.values()]
        .map((c) => {
            const subcategories = [...c.subs.values()]
                .map(withTotal)
                .sort((a, b) => b.totalCents - a.totalCents
                    || (a.name === UNFILED) - (b.name === UNFILED)
                    || a.name.localeCompare(b.name));
            const { subs, ...rest } = c;
            return { ...withTotal(rest), subcategories };
        })
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
