const { Router } = require('express');
const {
    db, ITEM_CATEGORIES, CT_TAX_RATE, TAX_EXEMPT_SQL_LIST, TAX_EXEMPT_CATEGORY_SQL_LIST, DONATION_UUID,
} = require('../db');
const { requireAdmin } = require('../staffAuth');
const { dayBound, etDate } = require('../etDate');

const router = Router();
router.use(requireAdmin);

const UNFILED = 'Unfiled';

// Total income per item category, split into online orders and counter
// (storefront) sales, and broken down again per sub-category within each top
// category. Cancelled orders are excluded. Counter sales are valued at the
// item's current price (stock_events records quantity, not price).
//
// "Income" here is NET of CT sales tax: the catalogue price is tax-inclusive,
// so orderCents / counterCents have the tax stripped out. The tax that was
// collected is reported separately as taxCents (and totals.salesTaxCents).
//
// Counter sales rung up in Special Event mode (stock_events.special_event set)
// are pulled out of their item's category into a top-level row named for the
// event (isSpecialEvent: true), whose breakdown rows are labelled
// "<category> · <sub-category>" (or just "<category>") to show what sold at
// the event.
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

    // A donation has no catalogue price: its value is the amount entered at
    // the register, read back from the sale's ledger row.
    const counterRows = db.prepare(`
        SELECT category, subcategory, specialEvent,
               SUM(gross) AS grossCents,
               SUM(CASE WHEN exempt THEN 0
                        ELSE gross - CAST(ROUND(gross / ${1 + CT_TAX_RATE}) AS INTEGER)
                   END) AS taxCents
        FROM (
            SELECT i.category AS category, s.name AS subcategory, se.special_event AS specialEvent,
                   CASE WHEN se.item_uuid = '${DONATION_UUID}'
                        THEN COALESCE((SELECT t.amount_cents FROM transactions t
                                       WHERE t.ref_stock_event_id = se.id AND t.source = 'storefront_sale'), 0)
                        ELSE -se.delta * i.price_cents
                   END AS gross,
                   (LOWER(TRIM(COALESCE(s.name, ''))) IN (${TAX_EXEMPT_SQL_LIST})
                    OR i.category IN (${TAX_EXEMPT_CATEGORY_SQL_LIST})) AS exempt
            FROM stock_events se
            JOIN items i ON i.uuid = se.item_uuid
            LEFT JOIN subcategories s ON s.id = i.subcategory_id
            WHERE se.reason = 'storefront_sale'
        )
        GROUP BY category, subcategory, specialEvent
    `).all();

    const byCategory = new Map();
    const bucket = (name, isSpecialEvent = false) => {
        if (!byCategory.has(name)) {
            byCategory.set(name, {
                category: name, isSpecialEvent, orderCents: 0, counterCents: 0, taxCents: 0, subs: new Map(),
            });
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
    // Enabled event types always show; a disabled one only once it has sales.
    for (const { name } of db.prepare('SELECT name FROM special_events WHERE enabled = 1').all()) bucket(name, true);

    for (const row of orderRows) {
        const net = (row.grossCents || 0) - (row.taxCents || 0);
        bucket(row.category).orderCents += net;
        bucket(row.category).taxCents += row.taxCents || 0;
        subBucket(row.category, row.subcategory).orderCents += net;
        subBucket(row.category, row.subcategory).taxCents += row.taxCents || 0;
    }
    for (const row of counterRows) {
        const net = (row.grossCents || 0) - (row.taxCents || 0);
        const top = row.specialEvent ? bucket(row.specialEvent, true) : bucket(row.category);
        const sub = row.specialEvent
            ? subBucket(row.specialEvent, row.subcategory ? `${row.category} · ${row.subcategory}` : row.category)
            : subBucket(row.category, row.subcategory);
        top.counterCents += net;
        top.taxCents += row.taxCents || 0;
        sub.counterCents += net;
        sub.taxCents += row.taxCents || 0;
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
        // Item categories first, then special events, each by total.
        .sort((a, b) => a.isSpecialEvent - b.isSpecialEvent
            || b.totalCents - a.totalCents
            || a.category.localeCompare(b.category));

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

// Storefront counter sales for one ET calendar day (default: today), broken
// down by category, by where the sale happened (storefront vs. the mobile
// cart), and by how it was tendered (cash vs. Venmo/CashApp "online") — so
// register staff can count each drawer against exactly what should be in it.
// Amounts are GROSS (tax-inclusive): that's the actual money that changed
// hands, which is what a drawer count reconciles against. Online-store
// (Stripe) orders are a separate rail and are not included.
//
// Filtered by payment_method rather than source='storefront_sale': a manual
// correction to a register sale is recorded with source='adjustment' (see
// recordTransaction), but it still carries the original row's payment_method
// and location, so it must count here too for the drawer to net out
// correctly. Stripe rows always have payment_method = '' and are excluded
// either way.
const LOCATIONS = ['storefront', 'cart'];

router.get('/register-reconciliation', (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : etDate(Date.now());
    const fromMs = dayBound(date);
    const toMs = dayBound(date, true);

    const rows = db.prepare(`
        SELECT account AS category, payment_method AS paymentMethod, location,
               SUM(CASE WHEN type = 'withdrawal' THEN -amount_cents ELSE amount_cents END) AS cents
        FROM transactions
        WHERE payment_method IN ('cash', 'online') AND posted_at >= ? AND posted_at <= ?
        GROUP BY account, payment_method, location
    `).all(fromMs, toMs);

    const emptyLocation = () => ({ cashCents: 0, onlineCents: 0, totalCents: 0 });
    const byCategory = new Map();
    const bucket = (name) => {
        if (!byCategory.has(name)) {
            byCategory.set(name, {
                category: name,
                storefront: emptyLocation(),
                cart: emptyLocation(),
                totalCents: 0,
            });
        }
        return byCategory.get(name);
    };
    for (const name of ITEM_CATEGORIES) bucket(name);

    for (const row of rows) {
        const cat = bucket(row.category);
        // A row with a real tender but no location predates the Cart feature
        // and was rung up at the storefront (see db.js v9 migration); fold any
        // stray one the same way so the drawer still nets out.
        const loc = cat[row.location] ? cat[row.location] : cat.storefront;
        if (row.paymentMethod === 'cash') loc.cashCents += row.cents;
        else loc.onlineCents += row.cents;
    }

    const categories = [...byCategory.values()].map((c) => {
        for (const loc of LOCATIONS) c[loc].totalCents = c[loc].cashCents + c[loc].onlineCents;
        return { ...c, totalCents: c.storefront.totalCents + c.cart.totalCents };
    });

    const totals = categories.reduce(
        (acc, c) => {
            for (const loc of LOCATIONS) {
                acc[loc].cashCents += c[loc].cashCents;
                acc[loc].onlineCents += c[loc].onlineCents;
                acc[loc].totalCents += c[loc].totalCents;
            }
            acc.totalCents += c.totalCents;
            return acc;
        },
        { storefront: emptyLocation(), cart: emptyLocation(), totalCents: 0 }
    );

    res.json({ date, categories, totals });
});

module.exports = router;
