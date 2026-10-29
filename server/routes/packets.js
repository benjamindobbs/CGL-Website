// Job packet builder (admin/packets/). Stores one packet per job request, or a
// house job with no request, and serves the JSON file ClassicalKenKen imports.
// Admin only: student staff stay read-only on job requests. Packet shape and
// checks live in server/jobPacket.js.
const { Router } = require('express');
const { db, getRequestDecoration } = require('../db');
const { requireAdmin } = require('../staffAuth');
const {
    REFERENCE, schoolYear, formatJobNumber,
    normalizePacket, assemblePacket, validatePacket, draftFromRequest, houseDraft,
} = require('../jobPacket');

const router = Router();
router.use(requireAdmin);

// A closed request's packet is read-only but can still be downloaded. Moving
// the request back to an open status unlocks it.
const LOCKED_STATUSES = ['complete', 'cancelled'];

function loadRequest(id) {
    const request = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(id);
    if (!request) return null;
    request.files = db.prepare('SELECT file_name FROM job_request_files WHERE request_id = ? ORDER BY id').all(id);
    return Object.assign(request, getRequestDecoration(id));
}

const sourceFor = (row) => ({ packet_id: row.id, ...(row.request_id ? { request_id: row.request_id } : {}) });

// What the builder gets: the stored body, the request behind it, the lock and
// the import checks. `row` is null for an unsaved draft.
function packetView(row, body, request) {
    const exported = assemblePacket(row && row.job_number, body, row ? sourceFor(row) : {});
    return {
        id: row ? row.id : null,
        job_number: row ? row.job_number : null,
        request_id: request ? request.id : null,
        updated_at: row ? row.updated_at : null,
        updated_by: row ? row.updated_by : '',
        locked: !!(request && LOCKED_STATUSES.includes(request.status)),
        request,
        data: normalizePacket(body),
        ...validatePacket(exported),
    };
}

function viewById(id) {
    const row = db.prepare('SELECT * FROM job_packets WHERE id = ?').get(id);
    if (!row) return null;
    return packetView(row, JSON.parse(row.data), row.request_id ? loadRequest(row.request_id) : null);
}

router.get('/reference', (_req, res) => res.json(REFERENCE));

router.get('/', (_req, res) => {
    const rows = db.prepare(`
        SELECT p.id, p.job_number, p.request_id, p.data, p.updated_at, r.job_name, r.status
        FROM job_packets p
        LEFT JOIN job_requests r ON r.id = p.request_id
        ORDER BY p.school_year DESC, p.seq DESC
    `).all();
    res.json(rows.map(({ data, ...row }) => {
        const body = normalizePacket(JSON.parse(data));
        return { ...row, customer: body.order.customer, is_house: body.is_house, method: body.process.method };
    }));
});

// An unsaved draft: ?request=<id> prefills from that request; ?house=1 starts a
// house job. A request that already has a packet answers with its id instead.
router.get('/draft', (req, res) => {
    if (req.query.house) return res.json(packetView(null, houseDraft(), null));
    const request = loadRequest(req.query.request);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    const existing = db.prepare('SELECT id FROM job_packets WHERE request_id = ?').get(request.id);
    if (existing) return res.json({ existingId: existing.id });
    res.json(packetView(null, draftFromRequest(request, request), request));
});

// Runs the import checks on unsaved edits, for the builder's live issue list.
router.post('/check', (req, res) => {
    const { id, data } = req.body || {};
    const row = id ? db.prepare('SELECT id, request_id, job_number FROM job_packets WHERE id = ?').get(id) : null;
    res.json(validatePacket(assemblePacket(row && row.job_number, data, row ? sourceFor(row) : {})));
});

router.get('/:id', (req, res) => {
    const view = viewById(req.params.id);
    if (!view) return res.status(404).json({ error: 'Packet not found' });
    res.json(view);
});

// First save: assigns the job number. Saving with problems is allowed (it's a
// draft); downloading isn't.
router.post('/', (req, res) => {
    const { request_id: requestId, data } = req.body || {};
    if (requestId != null) {
        const request = db.prepare('SELECT id, status FROM job_requests WHERE id = ?').get(requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        const existing = db.prepare('SELECT id FROM job_packets WHERE request_id = ?').get(requestId);
        if (existing) return res.status(409).json({ error: 'This request already has a job packet', existingId: existing.id });
        if (LOCKED_STATUSES.includes(request.status)) {
            return res.status(409).json({ error: `This request is ${request.status}. Reopen it to build a packet.` });
        }
    }

    const year = schoolYear();
    const now = Date.now();
    let id;
    db.exec('BEGIN IMMEDIATE');
    try {
        const { next } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM job_packets WHERE school_year = ?').get(year);
        const info = db.prepare(`
            INSERT INTO job_packets(request_id, job_number, school_year, seq, data, created_by, updated_by, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(requestId ?? null, formatJobNumber(year, next), year, next,
            JSON.stringify(normalizePacket(data)), req.userEmail, req.userEmail, now, now);
        id = Number(info.lastInsertRowid);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    res.status(201).json(viewById(id));
});

router.put('/:id', (req, res) => {
    const view = viewById(req.params.id);
    if (!view) return res.status(404).json({ error: 'Packet not found' });
    if (view.locked) return res.status(409).json({ error: `The request is ${view.request.status}, so this packet is locked. Reopen the request to edit it.` });
    db.prepare('UPDATE job_packets SET data = ?, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(normalizePacket((req.body || {}).data)), req.userEmail, Date.now(), view.id);
    res.json(viewById(view.id));
});

// <job_number>.json, refused (422 + the reasons) when the import would refuse it.
router.get('/:id/download', (req, res) => {
    const row = db.prepare('SELECT * FROM job_packets WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Packet not found' });
    const packet = assemblePacket(row.job_number, JSON.parse(row.data), sourceFor(row));
    const { errors, warnings } = validatePacket(packet);
    if (errors.length) {
        return res.status(422).json({ error: 'ClassicalKenKen would refuse this packet. Fix these first:', errors, warnings });
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${row.job_number}.json"`);
    res.send(`${JSON.stringify(packet, null, 2)}\n`);
});

module.exports = router;
