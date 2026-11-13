const { Router } = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../staffAuth');
const { normalizeStudentId, studentTicketStatus } = require('../tickets');

// The student ID roster (student_ids) behind counter ticket sales. Admin-only,
// like the Storefront Sale page that uses it. The full list never leaves the
// server: the page gets a count, and checks one ID at a time.
const router = Router();
router.use(requireAdmin);

const UPDATED_KEY = 'student_ids_updated_at';

function rosterSummary() {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM student_ids').get();
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(UPDATED_KEY);
    return { count, updatedAt: row ? Number(row.value) : null };
}

// Pulls every all-digit value out of a CSV/TXT export: one ID per cell, any
// header row ("ID") and stray text skipped, quotes and blanks ignored.
function parseStudentIds(text) {
    const ids = new Set();
    for (const cell of String(text || '').split(/[\r\n,;\t]+/)) {
        const id = cell.trim().replace(/^"(.*)"$/, '$1').trim();
        if (/^\d+$/.test(id)) ids.add(id);
    }
    return [...ids];
}

router.get('/', (_req, res) => {
    res.json(rosterSummary());
});

// Body: { csv: <file text>, mode: 'replace' | 'add' }. Replace swaps in a new
// school year's list; add appends (e.g. a transfer student).
router.put('/', (req, res) => {
    const mode = req.body.mode === 'add' ? 'add' : 'replace';
    const ids = parseStudentIds(req.body.csv);
    if (ids.length === 0) return res.status(400).json({ error: 'No student IDs found in that file' });

    const now = Date.now();
    db.exec('BEGIN');
    try {
        if (mode === 'replace') db.exec('DELETE FROM student_ids');
        const insert = db.prepare('INSERT OR IGNORE INTO student_ids(id, created_at) VALUES(?, ?)');
        for (const id of ids) insert.run(id, now);
        db.prepare(`
            INSERT INTO app_state(key, value, updated_at) VALUES(?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(UPDATED_KEY, String(now), now);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Student ID upload failed:', err);
        return res.status(500).json({ error: 'Server error saving student IDs' });
    }
    res.json({ ...rosterSummary(), received: ids.length });
});

// One ID, for the storefront pop-up: on the roster? tickets already held of
// ?ticket=<item uuid>?
router.get('/:id', (req, res) => {
    const studentId = normalizeStudentId(req.params.id);
    const ticket = String(req.query.ticket || '');
    if (!ticket) return res.status(400).json({ error: 'Missing ticket item' });
    res.json(studentTicketStatus(studentId, ticket));
});

module.exports = router;
