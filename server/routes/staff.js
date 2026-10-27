// Staff whitelist management for /admin/staff/ (admins only): add student staff
// or admins, change roles, set the name shown on the schedule, remove access.
// server/manage-staff.js is the CLI fallback for the same table.
const { Router } = require('express');
const { db, STAFF_ROLES } = require('../db');
const { requireAdmin } = require('../staffAuth');
const { resolveIdentity } = require('../auth');
const { INITIAL_STAFF } = require('../seed');

const router = Router();
router.use(requireAdmin);

const lower = (v) => String(v || '').trim().toLowerCase();
const CORE = new Set(INITIAL_STAFF.map(lower));

function listStaff() {
    return db.prepare('SELECT email, role, display_name FROM staff_whitelist ORDER BY role, email').all()
        .map((s) => ({
            email: s.email,
            role: s.role,
            displayName: s.display_name,
            // Re-seeded as admin on every boot (server/seed.js), so the UI
            // locks their role and removal.
            core: CORE.has(lower(s.email)),
        }));
}

const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60);

router.get('/', (_req, res) => {
    res.json(listStaff());
});

router.post('/', (req, res) => {
    const email = lower(req.body.email);
    const role = req.body.role || 'student';
    if (!STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
    // Only accounts that can actually sign in are worth whitelisting.
    if (!resolveIdentity(email)) {
        return res.status(400).json({ error: 'That email can\'t sign in — use a hartfordschools.org or students.hartfordschools.org account.' });
    }
    if (db.prepare('SELECT 1 FROM staff_whitelist WHERE email = ? COLLATE NOCASE').get(email)) {
        return res.status(409).json({ error: 'That account is already on the staff list' });
    }
    db.prepare('INSERT INTO staff_whitelist(email, role, display_name) VALUES(?, ?, ?)')
        .run(email, role, cleanName(req.body.displayName));
    res.status(201).json(listStaff());
});

router.patch('/:email', (req, res) => {
    const email = lower(req.params.email);
    const row = db.prepare('SELECT email, role FROM staff_whitelist WHERE email = ? COLLATE NOCASE').get(email);
    if (!row) return res.status(404).json({ error: 'Not on the staff list' });

    if (req.body.role !== undefined && req.body.role !== row.role) {
        if (!STAFF_ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Unknown role' });
        if (CORE.has(email)) return res.status(400).json({ error: 'This core account is always an admin' });
        if (email === lower(req.userEmail)) return res.status(400).json({ error: "You can't change your own role" });
        db.prepare('UPDATE staff_whitelist SET role = ? WHERE email = ?').run(req.body.role, row.email);
    }
    if (req.body.displayName !== undefined) {
        db.prepare('UPDATE staff_whitelist SET display_name = ? WHERE email = ?')
            .run(cleanName(req.body.displayName), row.email);
    }
    res.json(listStaff());
});

router.delete('/:email', (req, res) => {
    const email = lower(req.params.email);
    if (CORE.has(email)) return res.status(400).json({ error: 'This core account can\'t be removed' });
    if (email === lower(req.userEmail)) return res.status(400).json({ error: "You can't remove yourself" });
    db.prepare('DELETE FROM staff_whitelist WHERE email = ? COLLATE NOCASE').run(email);
    res.json(listStaff());
});

module.exports = router;
