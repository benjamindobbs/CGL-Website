const { Router } = require('express');
const { db, randomUUID, normalizeCategory, ITEM_CATEGORIES, ITEM_SELECT, getItem, normalizeHex } = require('../db');
const { requireStaff } = require('../staffAuth');

const router = Router();

// Registers any brand-new colors in the shared palette so the order page gets a
// swatch for them. Never overwrites an existing color — global hex edits go
// through /api/colors. Accepts [{ name, hex }]; unknown/blank entries are skipped.
function ensurePaletteColors(newColors) {
    if (!Array.isArray(newColors)) return;
    const insert = db.prepare('INSERT OR IGNORE INTO colors(name, hex, created_at) VALUES(?, ?, ?)');
    const now = Date.now();
    for (const c of newColors) {
        const name = String((c && c.name) || '').trim().replace(/\s+/g, ' ');
        if (name) insert.run(name, normalizeHex(c && c.hex) || '#cccccc', now);
    }
}

// Resolves the sub-category for a write. Passing a null/blank id files the item
// under no sub-category. Passing a real id pins the item's top category to that
// sub-category's parent, so the two can never drift out of sync. Throws a
// { status, message } on a bad id.
function resolveFiling(subcategoryId, category) {
    const fallbackCategory = normalizeCategory(category);
    if (subcategoryId === undefined || subcategoryId === null || subcategoryId === '') {
        return { subcategoryId: null, category: fallbackCategory };
    }
    const sub = db.prepare('SELECT * FROM subcategories WHERE id = ?').get(subcategoryId);
    if (!sub) throw { status: 400, message: 'Unknown sub-category' };
    return { subcategoryId: sub.id, category: sub.category };
}

// Public catalog read for the order page (still requires nothing — the order
// page itself is gated by requireAuth on /order, not on this endpoint). Only
// items that are both active and flagged orderable are returned.
router.get('/', (req, res) => {
    const { category } = req.query;
    const rows = category
        ? db.prepare(`${ITEM_SELECT} WHERE i.category = ? AND i.active = 1 AND i.orderable = 1 ORDER BY i.name, i.variant_color, i.variant_size`).all(category)
        : db.prepare(`${ITEM_SELECT} WHERE i.active = 1 AND i.orderable = 1 ORDER BY i.category, i.name, i.variant_color, i.variant_size`).all();
    res.json(rows);
});

// Staff-only: full catalog including inactive items and stock levels, for
// the inventory admin screen.
router.get('/admin', requireStaff, (_req, res) => {
    const rows = db.prepare(`${ITEM_SELECT} ORDER BY i.category, i.name, i.variant_color, i.variant_size`).all();
    res.json(rows);
});

router.post('/', requireStaff, (req, res) => {
    const { name, uuid, category, subcategoryId, variantColor, variantSize, priceCents, detail, startingStock, orderable, newColors } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing item name' });

    ensurePaletteColors(newColors);

    let filing;
    try {
        filing = resolveFiling(subcategoryId, category);
    } catch (err) {
        return res.status(err.status || 400).json({ error: err.message || 'Bad sub-category' });
    }

    const itemUuid = uuid && uuid.trim() ? uuid.trim() : randomUUID();
    const existing = db.prepare('SELECT 1 FROM items WHERE uuid = ?').get(itemUuid);
    if (existing) return res.status(409).json({ error: 'An item with that UUID already exists' });

    db.prepare(`
        INSERT INTO items(uuid, name, category, subcategory_id, variant_color, variant_size, price_cents, detail, stock_qty, active, orderable, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
        itemUuid,
        name,
        filing.category,
        filing.subcategoryId,
        variantColor || null,
        variantSize || null,
        Number.isFinite(priceCents) ? priceCents : 0,
        detail || '',
        Number.isFinite(startingStock) ? startingStock : 0,
        orderable === undefined ? 1 : (orderable ? 1 : 0),
        Date.now()
    );

    res.status(201).json(getItem(itemUuid));
});

// Staff-only: edit an existing item in place. Every field is optional; only
// what's sent is changed. Stock is never touched here — it moves only through
// Restock / Storefront so the stock ledger stays complete.
router.patch('/:uuid', requireStaff, (req, res) => {
    const current = db.prepare('SELECT * FROM items WHERE uuid = ?').get(req.params.uuid);
    if (!current) return res.status(404).json({ error: 'No item found for that UUID' });

    const body = req.body || {};
    const sets = [];
    const values = [];

    if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return res.status(400).json({ error: 'Item name cannot be empty' });
        sets.push('name = ?');
        values.push(name);
    }

    // category / subcategory move together (see resolveFiling).
    if (body.category !== undefined || body.subcategoryId !== undefined) {
        const nextCategory = body.category !== undefined ? body.category : current.category;
        const nextSub = body.subcategoryId !== undefined ? body.subcategoryId : current.subcategory_id;
        let filing;
        try {
            filing = resolveFiling(nextSub, nextCategory);
        } catch (err) {
            return res.status(err.status || 400).json({ error: err.message || 'Bad sub-category' });
        }
        sets.push('category = ?', 'subcategory_id = ?');
        values.push(filing.category, filing.subcategoryId);
    }

    if (body.priceCents !== undefined) {
        const cents = Math.round(Number(body.priceCents));
        if (!Number.isFinite(cents) || cents < 0) return res.status(400).json({ error: 'Price must be zero or more' });
        sets.push('price_cents = ?');
        values.push(cents);
    }

    if (body.detail !== undefined) {
        sets.push('detail = ?');
        values.push(String(body.detail));
    }

    if (body.variantColor !== undefined) {
        sets.push('variant_color = ?');
        values.push(String(body.variantColor).trim() || null);
    }

    if (body.variantSize !== undefined) {
        sets.push('variant_size = ?');
        values.push(String(body.variantSize).trim() || null);
    }

    if (body.active !== undefined) {
        sets.push('active = ?');
        values.push(body.active ? 1 : 0);
    }

    if (body.orderable !== undefined) {
        sets.push('orderable = ?');
        values.push(body.orderable ? 1 : 0);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    values.push(req.params.uuid);
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE uuid = ?`).run(...values);

    res.json(getItem(req.params.uuid));
});

// Staff-only: create one item per color x size combination in a single call.
// UUIDs are always auto-generated here (a shared UUID across variants makes no
// sense). An empty colors/sizes array just means that dimension is NULL.
router.post('/bulk', requireStaff, (req, res) => {
    const { name, category, subcategoryId, priceCents, detail, startingStock, colors, sizes, orderable, newColors } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing item name' });

    ensurePaletteColors(newColors);

    let filing;
    try {
        filing = resolveFiling(subcategoryId, category);
    } catch (err) {
        return res.status(err.status || 400).json({ error: err.message || 'Bad sub-category' });
    }

    const dedupe = (arr) => (Array.isArray(arr)
        ? [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))]
        : []);
    const colorAxis = dedupe(colors);
    const sizeAxis = dedupe(sizes);

    const colorValues = colorAxis.length ? colorAxis : [null];
    const sizeValues = sizeAxis.length ? sizeAxis : [null];

    const price = Number.isFinite(priceCents) ? priceCents : 0;
    const stock = Number.isFinite(startingStock) ? startingStock : 0;
    const det = detail || '';
    const orderableFlag = orderable === undefined ? 1 : (orderable ? 1 : 0);
    const now = Date.now();

    const insert = db.prepare(`
        INSERT INTO items(uuid, name, category, subcategory_id, variant_color, variant_size, price_cents, detail, stock_qty, active, orderable, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);

    db.exec('BEGIN');
    try {
        const items = [];
        for (const color of colorValues) {
            for (const size of sizeValues) {
                const uuid = randomUUID();
                insert.run(uuid, name, filing.category, filing.subcategoryId, color, size, price, det, stock, orderableFlag, now);
                items.push(getItem(uuid));
            }
        }
        db.exec('COMMIT');
        res.status(201).json({ count: items.length, items });
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Bulk item create failed:', err);
        res.status(500).json({ error: 'Failed to create items' });
    }
});

// Staff-only: flip `orderable` for a whole category and/or sub-category at once.
// The scope must be narrowed by at least one of `category` / `subcategoryId` so
// a stray call can't hide (or expose) the entire catalog. `subcategoryId` may be
// a numeric id, or the string 'none' to target items filed under no sub-category.
router.post('/bulk-orderable', requireStaff, (req, res) => {
    const { orderable, category, subcategoryId } = req.body || {};
    if (typeof orderable !== 'boolean') {
        return res.status(400).json({ error: 'orderable must be true or false' });
    }

    const where = [];
    const params = [];

    if (category !== undefined && category !== null && category !== '') {
        if (!ITEM_CATEGORIES.includes(category)) {
            return res.status(400).json({ error: 'Unknown category' });
        }
        where.push('category = ?');
        params.push(category);
    }

    if (subcategoryId === 'none') {
        where.push('subcategory_id IS NULL');
    } else if (subcategoryId !== undefined && subcategoryId !== null && subcategoryId !== '') {
        const sub = db.prepare('SELECT 1 FROM subcategories WHERE id = ?').get(subcategoryId);
        if (!sub) return res.status(400).json({ error: 'Unknown sub-category' });
        where.push('subcategory_id = ?');
        params.push(subcategoryId);
    }

    if (!where.length) {
        return res.status(400).json({ error: 'Specify a category or sub-category to change' });
    }

    const result = db.prepare(
        `UPDATE items SET orderable = ? WHERE ${where.join(' AND ')}`
    ).run(orderable ? 1 : 0, ...params);

    res.json({ updated: result.changes });
});

module.exports = router;
