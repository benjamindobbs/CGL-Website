const { Router } = require('express');
const { db, ITEM_CATEGORIES } = require('../db');
const { requireCore } = require('../staffAuth');

// Special event types for the Storefront Sale page's "Special Event" mode
// (see the special_events table in db.js). Core lab accounts only: other
// admins and student staff never see or use Special Event mode.
const router = Router();
router.use(requireCore);

const MAX_NAME_LENGTH = 40;

// Every response is the full list (enabled and disabled). sale_count is how
// many ledger rows have been booked to the name.
function listSpecialEvents() {
    return db.prepare(`
        SELECT e.id, e.name, e.enabled, e.created_at,
               (SELECT COUNT(*) FROM transactions t WHERE t.account = e.name COLLATE NOCASE) AS sale_count
        FROM special_events e
        ORDER BY e.name COLLATE NOCASE
    `).all().map((e) => ({ ...e, enabled: !!e.enabled }));
}

router.get('/', (_req, res) => {
    res.json(listSpecialEvents());
});

router.post('/', (req, res) => {
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    if (!name) return res.status(400).json({ error: 'Missing event name' });
    if (name.length > MAX_NAME_LENGTH) {
        return res.status(400).json({ error: `Event name must be ${MAX_NAME_LENGTH} characters or fewer` });
    }
    // The name becomes a ledger account, so it can't collide with a category.
    if (ITEM_CATEGORIES.some((c) => c.toLowerCase() === name.toLowerCase())) {
        return res.status(409).json({ error: `"${name}" is already an item category` });
    }
    if (db.prepare('SELECT 1 FROM special_events WHERE name = ? COLLATE NOCASE').get(name)) {
        return res.status(409).json({ error: `"${name}" already exists` });
    }

    db.prepare('INSERT INTO special_events(name, created_at) VALUES(?, ?)').run(name, Date.now());
    res.status(201).json(listSpecialEvents());
});

// Enable / disable a type. Disabled types drop out of the sale picker; past
// sales keep their account name and still show in reports and the log.
router.patch('/:id', (req, res) => {
    if (typeof req.body.enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be true or false' });
    }
    const info = db.prepare('UPDATE special_events SET enabled = ? WHERE id = ?')
        .run(req.body.enabled ? 1 : 0, req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Event type not found' });
    res.json(listSpecialEvents());
});

module.exports = router;
