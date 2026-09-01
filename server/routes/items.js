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

// Staff-only: create one item per color x size combination in a single call.
// UUIDs are always auto-generated here (a shared UUID across variants makes no
// sense). An empty colors/sizes array just means that dimension is NULL.
router.post('/bulk', requireStaff, (req, res) => {
    const { name, category, priceCents, detail, startingStock, colors, sizes } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing item name' });

    const dedupe = (arr) => (Array.isArray(arr)
        ? [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))]
        : []);
    const colorAxis = dedupe(colors);
    const sizeAxis = dedupe(sizes);

    const colorValues = colorAxis.length ? colorAxis : [null];
    const sizeValues = sizeAxis.length ? sizeAxis : [null];

    const price = Number.isFinite(priceCents) ? priceCents : 0;
    const stock = Number.isFinite(startingStock) ? startingStock : 0;
    const cat = category || 'General';
    const det = detail || '';
    const now = Date.now();

    const insert = db.prepare(`
        INSERT INTO items(uuid, name, category, variant_color, variant_size, price_cents, detail, stock_qty, active, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);

    db.exec('BEGIN');
    try {
        const items = [];
        for (const color of colorValues) {
            for (const size of sizeValues) {
                const uuid = randomUUID();
                insert.run(uuid, name, cat, color, size, price, det, stock, now);
                items.push(db.prepare('SELECT * FROM items WHERE uuid = ?').get(uuid));
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

module.exports = router;
