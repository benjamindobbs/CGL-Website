const { Router } = require('express');
const { db, JERSEY_SIZES } = require('../db');
const { requireDistrictStaff } = require('../auth');
const { requireStaff } = require('../staffAuth');
const { csvDocument } = require('../csv');

const router = Router();

function validatePayload(b) {
    const jobName = String((b && b.jobName) || '').trim();
    const jerseyStyle = String((b && b.jerseyStyle) || '').trim().toLowerCase();
    if (!jobName) return { error: 'A job name is required' };
    if (!['male', 'female'].includes(jerseyStyle)) return { error: 'Pick Male or Female jerseys' };
    if (!Array.isArray(b.players) || b.players.length === 0) return { error: 'Add at least one player' };

    const players = [];
    for (let i = 0; i < b.players.length; i++) {
        const p = b.players[i] || {};
        const name = String(p.name || '').trim();
        const size = String(p.size || '').trim().toUpperCase();
        if (!name) return { error: `Row ${i + 1}: name on jersey is required` };
        if (!JERSEY_SIZES.includes(size)) return { error: `Row ${i + 1}: choose a size` };
        players.push({
            name,
            number: String(p.number || '').trim().slice(0, 12),
            size,
            color: String(p.color || '').trim().slice(0, 40),
            info: String(p.info || '').trim().slice(0, 500),
        });
    }
    return { jobName, jerseyStyle, players };
}

function insertPlayers(jobId, players) {
    const ins = db.prepare(
        'INSERT INTO jersey_players(job_id, sort_order, name, number, size, color, info) VALUES(?, ?, ?, ?, ?, ?, ?)'
    );
    players.forEach((p, i) => ins.run(jobId, i, p.name, p.number, p.size, p.color, p.info));
}

function jobWithPlayers(job) {
    job.players = db.prepare(
        'SELECT name, number, size, color, info FROM jersey_players WHERE job_id = ? ORDER BY sort_order, id'
    ).all(job.id);
    return job;
}

router.post('/', requireDistrictStaff, (req, res) => {
    const v = validatePayload(req.body);
    if (v.error) return res.status(400).json({ error: v.error });

    const now = Date.now();
    db.exec('BEGIN');
    try {
        const info = db.prepare(
            'INSERT INTO jersey_jobs(user_key, email, job_name, jersey_style, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
        ).run(req.userKey, req.userEmail, v.jobName, v.jerseyStyle, now, now);
        insertPlayers(Number(info.lastInsertRowid), v.players);
        db.exec('COMMIT');
        res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('[jerseys] create failed:', err);
        res.status(500).json({ error: 'Could not save the roster' });
    }
});

router.put('/:id', requireDistrictStaff, (req, res) => {
    const job = db.prepare('SELECT * FROM jersey_jobs WHERE id = ?').get(req.params.id);
    // 404 (not 403) when it isn't the caller's — don't leak that the id exists.
    if (!job || job.user_key !== req.userKey) return res.status(404).json({ error: 'Roster not found' });

    const v = validatePayload(req.body);
    if (v.error) return res.status(400).json({ error: v.error });

    db.exec('BEGIN');
    try {
        db.prepare('UPDATE jersey_jobs SET job_name = ?, jersey_style = ?, updated_at = ? WHERE id = ?')
            .run(v.jobName, v.jerseyStyle, Date.now(), job.id);
        db.prepare('DELETE FROM jersey_players WHERE job_id = ?').run(job.id);
        insertPlayers(job.id, v.players);
        db.exec('COMMIT');
        res.json({ id: job.id });
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('[jerseys] update failed:', err);
        res.status(500).json({ error: 'Could not save the roster' });
    }
});

router.get('/mine', requireDistrictStaff, (req, res) => {
    const jobs = db.prepare('SELECT * FROM jersey_jobs WHERE user_key = ? ORDER BY updated_at DESC').all(req.userKey);
    res.json(jobs.map(jobWithPlayers));
});

router.get('/', requireStaff, (_req, res) => {
    const jobs = db.prepare('SELECT * FROM jersey_jobs ORDER BY updated_at DESC').all();
    res.json(jobs.map(jobWithPlayers));
});

router.get('/:id/export.csv', requireStaff, (req, res) => {
    const job = db.prepare('SELECT * FROM jersey_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Roster not found' });
    const players = db.prepare(
        'SELECT name, number, size, color, info FROM jersey_players WHERE job_id = ? ORDER BY sort_order, id'
    ).all(job.id);

    const body = csvDocument(
        ['Name on Jersey', 'Number', 'Size', 'Color', 'Additional Info'],
        players.map((p) => [p.name, p.number, p.size, p.color, p.info])
    );
    const slug = job.job_name.replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'roster';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="jerseys-${slug}.csv"`);
    res.send(body);
});

router.delete('/:id', requireStaff, (req, res) => {
    const job = db.prepare('SELECT * FROM jersey_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Roster not found' });
    db.exec('BEGIN');
    try {
        db.prepare('DELETE FROM jersey_players WHERE job_id = ?').run(job.id);
        db.prepare('DELETE FROM jersey_jobs WHERE id = ?').run(job.id);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        return res.status(500).json({ error: 'Could not delete the roster' });
    }
    res.json({ deleted: job.id });
});

module.exports = router;
