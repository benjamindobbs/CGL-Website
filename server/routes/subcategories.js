const { Router } = require('express');
const { db, normalizeCategory } = require('../db');
const { requireStaff } = require('../staffAuth');

const router = Router();
router.use(requireStaff);

// Every response is the full list, each row annotated with how many catalog
// items are currently filed under it (so the admin UI can warn before a
// delete). Ordered by top category, then name.
function listSubcategories() {
    return db.prepare(`
        SELECT s.id, s.name, s.category, s.created_at,
               (SELECT COUNT(*) FROM items i WHERE i.subcategory_id = s.id) AS item_count
        FROM subcategories s
        ORDER BY s.category, s.name COLLATE NOCASE
    `).all();
}

router.get('/', (_req, res) => {
    res.json(listSubcategories());
});

router.post('/', (req, res) => {
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    const category = normalizeCategory(req.body.category);
    if (!name) return res.status(400).json({ error: 'Missing sub-category name' });

    const dupe = db.prepare(
        'SELECT 1 FROM subcategories WHERE category = ? AND name = ? COLLATE NOCASE'
    ).get(category, name);
    if (dupe) return res.status(409).json({ error: `"${name}" already exists under ${category}` });

    const info = db.prepare(
        'INSERT INTO subcategories(name, category, created_at) VALUES(?, ?, ?)'
    ).run(name, category, Date.now());

    res.status(201).json(
        db.prepare('SELECT id, name, category, created_at FROM subcategories WHERE id = ?').get(info.lastInsertRowid)
    );
});

router.patch('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM subcategories WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Sub-category not found' });

    const name = req.body.name !== undefined
        ? String(req.body.name).trim().replace(/\s+/g, ' ')
        : existing.name;
    const category = req.body.category !== undefined
        ? normalizeCategory(req.body.category)
        : existing.category;
    if (!name) return res.status(400).json({ error: 'Sub-category name cannot be empty' });

    const dupe = db.prepare(
        'SELECT 1 FROM subcategories WHERE category = ? AND name = ? COLLATE NOCASE AND id <> ?'
    ).get(category, name, existing.id);
    if (dupe) return res.status(409).json({ error: `"${name}" already exists under ${category}` });

    db.exec('BEGIN');
    try {
        db.prepare('UPDATE subcategories SET name = ?, category = ? WHERE id = ?')
            .run(name, category, existing.id);
        // Keep every item's top category in step with its sub-category's.
        if (category !== existing.category) {
            db.prepare('UPDATE items SET category = ? WHERE subcategory_id = ?')
                .run(category, existing.id);
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Sub-category update failed:', err);
        return res.status(500).json({ error: 'Failed to update sub-category' });
    }

    res.json(db.prepare('SELECT id, name, category, created_at FROM subcategories WHERE id = ?').get(existing.id));
});

router.delete('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM subcategories WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Sub-category not found' });

    db.exec('BEGIN');
    try {
        // Foreign keys are OFF (see db.js), so unfile items by hand first.
        // Their top category is left untouched.
        db.prepare('UPDATE items SET subcategory_id = NULL WHERE subcategory_id = ?').run(existing.id);
        db.prepare('DELETE FROM subcategories WHERE id = ?').run(existing.id);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Sub-category delete failed:', err);
        return res.status(500).json({ error: 'Failed to delete sub-category' });
    }

    res.json({ deleted: existing.id });
});

module.exports = router;
