// Student staff shift schedule (/admin/schedule/). Any staff role can view the
// calendar and sign up for / drop their own shifts; admins can also assign or
// remove anyone, mark no-school days, force an athletics sync and export CSV.
const { Router } = require('express');
const { db } = require('../db');
const { requireStaff, requireAdmin } = require('../staffAuth');
const { csvDocument } = require('../csv');
const { etDate, TIME_ZONE } = require('../etDate');
const { maybeSyncAthletics, syncAthletics, getSyncState } = require('../athletics');
const {
    MAX_RANGE_DAYS, isValidDate, datesBetween, shiftsBetween, closuresBetween, findShift,
} = require('../shifts');

const router = Router();
router.use(requireStaff);

const lower = (v) => String(v || '').trim().toLowerCase();
const shiftId = (date, key) => `${date}|${key}`;

// "jdoe001@students.hartfordschools.org" -> "jdoe001" when no display name is set.
function nameFor(row) {
    return row.display_name || String(row.email).split('@')[0];
}

function signupsBetween(from, to) {
    return db.prepare(`
        SELECT su.id, su.shift_date, su.shift_key, su.email, su.created_at, sw.display_name
        FROM shift_signups su
        LEFT JOIN staff_whitelist sw ON sw.email = su.email COLLATE NOCASE
        WHERE su.shift_date >= ? AND su.shift_date <= ?
        ORDER BY su.created_at, su.id
    `).all(from, to);
}

// Why a signup no longer lines up with a shift on the calendar.
function flagReason(signup) {
    return signup.shift_key === 'game_evening'
        ? 'Game cancelled or moved'
        : 'No regular shifts this day';
}

// Shifts for [from, to] with their signups attached, plus any signups whose
// shift has since disappeared (game cancelled/rescheduled, closure added).
function buildSchedule(from, to, me) {
    const shifts = shiftsBetween(from, to);
    const byId = new Map(shifts.map((s) => [shiftId(s.date, s.key), { ...s, signups: [] }]));
    const flagged = [];
    for (const su of signupsBetween(from, to)) {
        const entry = { id: su.id, email: su.email, name: nameFor(su), mine: lower(su.email) === me };
        const shift = byId.get(shiftId(su.shift_date, su.shift_key));
        if (shift) shift.signups.push(entry);
        else flagged.push({ ...entry, date: su.shift_date, key: su.shift_key, reason: flagReason(su) });
    }
    return { shifts: [...byId.values()], flagged };
}

function parseRange(req, res) {
    const { from, to } = req.query;
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
        res.status(400).json({ error: 'from and to must be YYYY-MM-DD, from <= to' });
        return null;
    }
    if (datesBetween(from, to).length > MAX_RANGE_DAYS) {
        res.status(400).json({ error: `Range is limited to ${MAX_RANGE_DAYS} days` });
        return null;
    }
    return { from, to };
}

router.get('/', async (req, res) => {
    const range = parseRange(req, res);
    if (!range) return;
    await maybeSyncAthletics();
    const me = lower(req.userEmail);
    const { shifts, flagged } = buildSchedule(range.from, range.to, me);
    const isAdmin = req.staffRole === 'admin';
    res.json({
        ...range,
        today: etDate(Date.now()),
        now: Date.now(),
        me,
        role: req.staffRole,
        shifts,
        closures: closuresBetween(range.from, range.to),
        // Students only need to know about their own orphaned signups.
        flagged: isAdmin ? flagged : flagged.filter((f) => f.mine),
        sync: isAdmin ? getSyncState() : undefined,
        staff: isAdmin
            ? db.prepare('SELECT email, display_name, role FROM staff_whitelist ORDER BY role DESC, display_name, email').all()
                .map((s) => ({ email: lower(s.email), name: nameFor(s), role: s.role }))
            : undefined,
    });
});

// The signed-in user's shifts from today on, for the "My shifts" panel.
router.get('/mine', (req, res) => {
    const me = lower(req.userEmail);
    const today = etDate(Date.now());
    const rows = db.prepare(`
        SELECT shift_date FROM shift_signups WHERE email = ? AND shift_date >= ? ORDER BY shift_date
    `).all(me, today);
    if (!rows.length) return res.json({ shifts: [], flagged: [] });
    const { shifts, flagged } = buildSchedule(today, rows[rows.length - 1].shift_date, me);
    res.json({
        shifts: shifts.filter((s) => s.signups.some((su) => su.mine)),
        flagged: flagged.filter((f) => f.mine),
    });
});

router.post('/signups', (req, res) => {
    const { date, key } = req.body || {};
    const isAdmin = req.staffRole === 'admin';
    const me = lower(req.userEmail);
    const target = isAdmin && req.body.email ? lower(req.body.email) : me;

    const shift = findShift(date, key);
    if (!shift) return res.status(404).json({ error: 'There is no such shift on that day' });
    if (!isAdmin && shift.startsAt <= Date.now()) {
        return res.status(400).json({ error: 'This shift has already started' });
    }
    if (!db.prepare('SELECT 1 FROM staff_whitelist WHERE email = ? COLLATE NOCASE').get(target)) {
        return res.status(400).json({ error: 'That account is not on the staff list' });
    }

    // Capacity check and insert in one transaction so two students can't both
    // take the last spot.
    db.exec('BEGIN IMMEDIATE');
    try {
        const taken = db.prepare('SELECT COUNT(*) AS n FROM shift_signups WHERE shift_date = ? AND shift_key = ?')
            .get(date, key).n;
        if (db.prepare('SELECT 1 FROM shift_signups WHERE shift_date = ? AND shift_key = ? AND email = ?').get(date, key, target)) {
            db.exec('ROLLBACK');
            return res.status(409).json({ error: target === me ? "You're already on this shift" : 'Already on this shift' });
        }
        if (taken >= shift.capacity) {
            db.exec('ROLLBACK');
            return res.status(409).json({ error: 'This shift is full' });
        }
        const info = db.prepare(`
            INSERT INTO shift_signups(shift_date, shift_key, email, created_by, created_at) VALUES(?, ?, ?, ?, ?)
        `).run(date, key, target, req.userKey, Date.now());
        db.exec('COMMIT');
        res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Shift signup failed:', err);
        res.status(500).json({ error: 'Could not sign up' });
    }
});

router.delete('/signups/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM shift_signups WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Signup not found' });
    const isAdmin = req.staffRole === 'admin';
    if (!isAdmin) {
        if (lower(row.email) !== lower(req.userEmail)) {
            return res.status(403).json({ error: 'You can only drop your own shifts' });
        }
        // A shift that has happened is part of the record; only admins edit it.
        const shift = findShift(row.shift_date, row.shift_key);
        const started = shift ? shift.startsAt <= Date.now() : row.shift_date < etDate(Date.now());
        if (started) return res.status(400).json({ error: 'This shift has already started' });
    }
    db.prepare('DELETE FROM shift_signups WHERE id = ?').run(row.id);
    res.json({ ok: true });
});

router.put('/closures/:date', requireAdmin, (req, res) => {
    const { date } = req.params;
    if (!isValidDate(date)) return res.status(400).json({ error: 'Bad date' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 200);
    db.prepare(`
        INSERT INTO schedule_closures(date, note) VALUES(?, ?)
        ON CONFLICT(date) DO UPDATE SET note = excluded.note
    `).run(date, note);
    res.json({ date, note });
});

router.delete('/closures/:date', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM schedule_closures WHERE date = ?').run(req.params.date);
    res.json({ ok: true });
});

router.post('/sync', requireAdmin, async (_req, res) => {
    res.json(await syncAthletics());
});

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });

router.get('/export.csv', requireAdmin, (req, res) => {
    const range = parseRange(req, res);
    if (!range) return;
    const { shifts, flagged } = buildSchedule(range.from, range.to, '');
    const rows = [];
    for (const s of shifts) {
        const day = dayFmt.format(new Date(`${s.date}T12:00:00Z`));
        const games = (s.games || []).map((g) => `${g.summary} ${g.description}`.trim()).join('; ');
        const base = [s.date, day, `${s.location} ${s.label}`, timeFmt.format(s.startsAt), timeFmt.format(s.endsAt)];
        if (!s.signups.length) rows.push([...base, '', '', games]);
        for (const su of s.signups) rows.push([...base, su.name, su.email, games]);
    }
    for (const f of flagged) rows.push([f.date, '', f.key, '', '', f.name, f.email, `FLAGGED: ${f.reason}`]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="schedule-${range.from}-to-${range.to}.csv"`);
    res.send(csvDocument(['Date', 'Day', 'Shift', 'Start', 'End', 'Name', 'Email', 'Notes'], rows));
});

module.exports = router;
