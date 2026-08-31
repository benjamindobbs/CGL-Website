const { Router } = require('express');
const { db, randomUUID } = require('../db');
const { requireStaff } = require('../staffAuth');

const router = Router();

// Public catalog read (still requires nothing — the order page itself is
// gated by requireAuth on /order, not on this endpoint).
router.get('/', (req, res) => {
    const { category } = req.query;
    const rows = category
        ? db.prepare('SELECT * FROM items WHERE category = ? AND active = 1 ORDER BY name, variant_color, variant_size').all(category)
        : db.prepare('SELECT * FROM items WHERE active = 1 ORDER BY category, name, variant_color, variant_size').all();
    res.json(rows);
});

// Staff-only: full catalog including inactive items and stock levels, for
// the inventory admin screen.
router.get('/admin', requireStaff, (_req, res) => {
    const rows = db.prepare('SELECT * FROM items ORDER BY category, name, variant_color, variant_size').all();
    res.json(rows);
});

router.post('/', requireStaff, (req, res) => {
    const { name, uuid, category, variantColor, variantSize, priceCents, detail, startingStock } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing item name' });

    const itemUuid = uuid && uuid.trim() ? uuid.trim() : randomUUID();
    const existing = db.prepare('SELECT 1 FROM items WHERE uuid = ?').get(itemUuid);
    if (existing) return res.status(409).json({ error: 'An item with that UUID already exists' });

    db.prepare(`
        INSERT INTO items(uuid, name, category, variant_color, variant_size, price_cents, detail, stock_qty, active, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
        itemUuid,
        name,
        category || 'General',
        variantColor || null,
        variantSize || null,
        Number.isFinite(priceCents) ? priceCents : 0,
        detail || '',
        Number.isFinite(startingStock) ? startingStock : 0,
        Date.now()
    );

    res.status(201).json(db.prepare('SELECT * FROM items WHERE uuid = ?').get(itemUuid));
});

module.exports = router;
