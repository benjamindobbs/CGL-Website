const { Router } = require('express');
const { db, ITEM_CATEGORIES, CT_TAX_RATE } = require('../db');
const { requireStaff } = require('../staffAuth');

const router = Router();
router.use(requireStaff);

const UNFILED = 'Unfiled';

// Total income per item category, split into online orders and counter
// (storefront) sales, and broken down again per sub-category within each top
// category. Cancelled orders are excluded. Counter sales are valued at the
// item's current price (stock_events records quantity, not price).
//
// "Income" here is NET of CT sales tax: the catalogue price is tax-inclusive,
// so orderCents / counterCents have the tax stripped out. The tax that was
// collected is reported separately as taxCents (and totals.salesTaxCents).
router.get('/income-by-category', (_req, res) => {
    const orderRows = db.prepare(`
        SELECT i.category AS category, s.name AS subcategory,
               SUM(oi.line_total_cents) AS grossCents,
               SUM(oi.tax_cents)        AS taxCents
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN items  i ON i.uuid = oi.item_uuid
        LEFT JOIN subcategories s ON s.id = i.subcategory_id
        WHERE o.status <> 'cancelled'
        GROUP BY i.category, s.name
    `).all();

    const counterRows = db.prepare(`
        SELECT i.category AS category, s.name AS subcategory,
               SUM(-se.delta * i.price_cents) AS grossCents,
               SUM(CASE
                   WHEN LOWER(TRIM(COALESCE(s.name, ''))) = 'supplies' THEN 0
                   ELSE (-se.delta * i.price_cents)
                        - CAST(ROUND(-se.delta * i.price_cents / ${1 + CT_TAX_RATE}) AS INTEGER)
               END) AS taxCents
        FROM stock_events se
        JOIN items i ON i.uuid = se.item_uuid
        LEFT JOIN subcategories s ON s.id = i.subcategory_id
        WHERE se.reason = 'storefront_sale'
        GROUP BY i.category, s.name
    `).all();

    const byCategory = new Map();
    const bucket = (name) => {
        if (!byCategory.has(name)) {
            byCategory.set(name, { category: name, orderCents: 0, counterCents: 0, taxCents: 0, subs: new Map() });
        }
        return byCategory.get(name);
    };
    const subBucket = (catName, subName) => {
        const cat = bucket(catName);
        const key = subName || UNFILED;
        if (!cat.subs.has(key)) cat.subs.set(key, { name: key, orderCents: 0, counterCents: 0, taxCents: 0 });
        return cat.subs.get(key);
    };

    // Seed the fixed categories and every defined sub-category so they always
    // appear, even at zero.
    for (const name of ITEM_CATEGORIES) bucket(name);
    for (const sub of db.prepare('SELECT name, category FROM subcategories').all()) {
        subBucket(sub.category, sub.name);
    }

    for (const row of orderRows) {
        const net = (row.grossCents || 0) - (row.taxCents || 0);
        bucket(row.category).orderCents += net;
        bucket(row.category).taxCents += row.taxCents || 0;
        subBucket(row.category, row.subcategory).orderCents += net;
        subBucket(row.category, row.subcategory).taxCents += row.taxCents || 0;
    }
    for (const row of counterRows) {
        const net = (row.grossCents || 0) - (row.taxCents || 0);
        bucket(row.category).counterCents += net;
        bucket(row.category).taxCents += row.taxCents || 0;
        subBucket(row.category, row.subcategory).counterCents += net;
        subBucket(row.category, row.subcategory).taxCents += row.taxCents || 0;
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
            salesTaxCents: acc.salesTaxCents + c.taxCents,
        }),
        { orderCents: 0, counterCents: 0, totalCents: 0, salesTaxCents: 0 }
    );

    res.json({ categories, totals });
});

module.exports = router;
