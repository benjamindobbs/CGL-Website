const { Router } = require('express');
const { db, normalizeHex } = require('../db');
const { requireStaff } = require('../staffAuth');

const router = Router();
router.use(requireStaff);

// Full palette, each row annotated with how many catalog items currently use
// that color name (case-insensitive) so the admin UI can warn before a delete.
function listColors() {
    return db.prepare(`
        SELECT c.id, c.name, c.hex, c.created_at,
               (SELECT COUNT(*) FROM items i
                WHERE i.variant_color = c.name COLLATE NOCASE) AS item_count
        FROM colors c
        ORDER BY c.name COLLATE NOCASE
    `).all();
}

const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ');

router.get('/', (_req, res) => {
    res.json(listColors());
});

router.post('/', (req, res) => {
    const name = cleanName(req.body.name);
    const hex = normalizeHex(req.body.hex);
    if (!name) return res.status(400).json({ error: 'Missing color name' });
    if (!hex) return res.status(400).json({ error: 'Hex must look like #1a2b3c' });

    const dupe = db.prepare('SELECT 1 FROM colors WHERE name = ? COLLATE NOCASE').get(name);
    if (dupe) return res.status(409).json({ error: `"${name}" already exists` });

    const info = db.prepare(
        'INSERT INTO colors(name, hex, created_at) VALUES(?, ?, ?)'
    ).run(name, hex, Date.now());

    res.status(201).json(db.prepare('SELECT id, name, hex, created_at FROM colors WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM colors WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Color not found' });

    const name = req.body.name !== undefined ? cleanName(req.body.name) : existing.name;
    if (!name) return res.status(400).json({ error: 'Color name cannot be empty' });

    let hex = existing.hex;
    if (req.body.hex !== undefined) {
        hex = normalizeHex(req.body.hex);
        if (!hex) return res.status(400).json({ error: 'Hex must look like #1a2b3c' });
    }

    const dupe = db.prepare(
        'SELECT 1 FROM colors WHERE name = ? COLLATE NOCASE AND id <> ?'
    ).get(name, existing.id);
    if (dupe) return res.status(409).json({ error: `"${name}" already exists` });

    db.exec('BEGIN');
    try {
        db.prepare('UPDATE colors SET name = ?, hex = ? WHERE id = ?').run(name, hex, existing.id);
        // Keep every item's variant_color text in step with a rename.
        if (name !== existing.name) {
            db.prepare('UPDATE items SET variant_color = ? WHERE variant_color = ? COLLATE NOCASE')
                .run(name, existing.name);
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Color update failed:', err);
        return res.status(500).json({ error: 'Failed to update color' });
    }

    res.json(db.prepare('SELECT id, name, hex, created_at FROM colors WHERE id = ?').get(existing.id));
});

router.delete('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM colors WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Color not found' });

    // Only the palette entry goes. Items keep their variant_color text and fall
    // back to a neutral swatch until the color is re-added.
    db.prepare('DELETE FROM colors WHERE id = ?').run(existing.id);
    res.json({ deleted: existing.id });
});

module.exports = router;
