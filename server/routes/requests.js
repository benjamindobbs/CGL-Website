const { Router } = require('express');
const multer = require('multer');
const { db, randomUUID, JOB_CATEGORIES } = require('../db');
const { requireDistrictStaff } = require('../auth');
const { requireStaff } = require('../staffAuth');
const { csvDocument } = require('../csv');
const { isStorageConfigured, putObject, presignGetUrl, deleteObject } = require('../storage');
const { sendMail, esc, LAB_INBOX } = require('../mail');

const router = Router();

const STATUSES = ['new', 'in_progress', 'quoted', 'complete', 'cancelled'];

const ALLOWED_MIME = new Set([
    'image/png', 'image/jpeg', 'application/pdf', 'image/svg+xml',
    'application/postscript', 'application/illustrator', 'application/octet-stream',
]);
const ALLOWED_EXT = /\.(png|jpe?g|pdf|svg|eps|ai)$/i;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 5 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.test(file.originalname)) return cb(null, true);
        cb(new Error(`Unsupported file type: ${file.originalname}`));
    },
}).array('files', 5);

const safeName = (name) => String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);

function filesFor(requestId) {
    return db.prepare('SELECT * FROM job_request_files WHERE request_id = ? ORDER BY id').all(requestId);
}

async function withDownloadUrls(request) {
    const files = filesFor(request.id);
    request.files = await Promise.all(files.map(async (f) => ({
        file_name: f.file_name,
        size_bytes: f.size_bytes,
        downloadUrl: isStorageConfigured() ? await presignGetUrl(f.object_key).catch(() => null) : null,
    })));
    return request;
}

function notify(request, fileCount) {
    const rows = [
        ['Requester', `${request.requester_name} <${request.email}>`],
        ['Job name', request.job_name],
        ['Category', request.category],
        ['Building', request.building || '—'],
        ['Phone', request.phone || '—'],
        ['Quantity', request.quantity || '—'],
        ['Needed by', request.needed_by || '—'],
        ['Attachments', String(fileCount)],
    ].map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('');
    const html =
        `<p>New print-job request #${request.id}.</p>` +
        `<table>${rows}</table>` +
        `<p><b>Description</b><br>${esc(request.description || '—').replace(/\n/g, '<br>')}</p>`;

    sendMail({ to: LAB_INBOX, subject: `Job request: ${request.job_name} (${request.category})`, html, replyTo: request.email })
        .catch((err) => console.error('[requests] lab notify failed:', err));
    sendMail({
        to: request.email,
        subject: `We got your request: ${request.job_name}`,
        html: `<p>Hi ${esc(request.requester_name)},</p><p>The Classical Graphics Lab received your request for <b>${esc(request.job_name)}</b> (${esc(request.category)}). Someone will follow up by email. Reply here if you need to add anything.</p>`,
    }).catch((err) => console.error('[requests] requester confirm failed:', err));
}

router.post('/', requireDistrictStaff, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ error: err instanceof multer.MulterError ? `Upload problem: ${err.message}` : err.message });
        }

        const b = req.body || {};
        const requesterName = String(b.requesterName || '').trim();
        const jobName = String(b.jobName || '').trim();
        const category = String(b.category || '').trim();
        if (!requesterName) return res.status(400).json({ error: 'Your name is required' });
        if (!jobName) return res.status(400).json({ error: 'A job name is required' });
        if (!JOB_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Pick a category' });

        const files = req.files || [];
        if (files.length && !isStorageConfigured()) {
            return res.status(503).json({ error: 'Artwork upload is not available right now — resubmit without files or try later.' });
        }

        const now = Date.now();
        const info = db.prepare(`
            INSERT INTO job_requests(user_key, requester_name, email, job_name, building, phone, category, quantity, needed_by, description, status, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
        `).run(
            req.userKey, requesterName, req.userEmail, jobName,
            String(b.building || '').trim(), String(b.phone || '').trim(), category,
            String(b.quantity || '').trim(), String(b.neededBy || '').trim(), String(b.description || '').trim(),
            now, now
        );
        const id = Number(info.lastInsertRowid);

        const uploaded = [];
        try {
            for (const file of files) {
                const key = `job-requests/${id}/${randomUUID()}-${safeName(file.originalname)}`;
                await putObject(key, file.buffer, file.mimetype);
                uploaded.push(key);
                db.prepare(`
                    INSERT INTO job_request_files(request_id, object_key, file_name, content_type, size_bytes, created_at)
                    VALUES(?, ?, ?, ?, ?, ?)
                `).run(id, key, safeName(file.originalname), file.mimetype || '', file.size || 0, Date.now());
            }
        } catch (uploadErr) {
            console.error('[requests] upload failed, rolling back:', uploadErr);
            for (const key of uploaded) await deleteObject(key).catch(() => {});
            db.prepare('DELETE FROM job_request_files WHERE request_id = ?').run(id);
            db.prepare('DELETE FROM job_requests WHERE id = ?').run(id);
            return res.status(502).json({ error: 'Could not store the artwork. Nothing was saved — please try again.' });
        }

        const request = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(id);
        notify(request, files.length);
        res.status(201).json({ id });
    });
});

router.get('/', requireStaff, async (req, res) => {
    const { status } = req.query;
    const rows = status
        ? db.prepare('SELECT * FROM job_requests WHERE status = ? ORDER BY created_at DESC').all(status)
        : db.prepare('SELECT * FROM job_requests ORDER BY created_at DESC').all();
    res.json(await Promise.all(rows.map(withDownloadUrls)));
});

router.patch('/:id', requireStaff, (req, res) => {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const result = db.prepare('UPDATE job_requests SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Date.now(), req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Request not found' });
    res.json(db.prepare('SELECT * FROM job_requests WHERE id = ?').get(req.params.id));
});

router.get('/export.csv', requireStaff, (req, res) => {
    const rows = db.prepare('SELECT * FROM job_requests ORDER BY created_at DESC').all();
    const byRequest = db.prepare('SELECT file_name FROM job_request_files WHERE request_id = ? ORDER BY id');
    const body = csvDocument(
        ['Submitted', 'Requester', 'Email', 'Job Name', 'Building', 'Phone', 'Category', 'Quantity', 'Needed By', 'Status', 'Description', 'Files'],
        rows.map((r) => [
            new Date(r.created_at).toISOString(),
            r.requester_name, r.email, r.job_name, r.building, r.phone, r.category,
            r.quantity, r.needed_by, r.status, r.description,
            byRequest.all(r.id).map((f) => f.file_name).join('; '),
        ])
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="job-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(body);
});

router.delete('/:id', requireStaff, async (req, res) => {
    const request = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    for (const f of filesFor(request.id)) {
        if (isStorageConfigured()) await deleteObject(f.object_key).catch(() => {});
    }
    db.prepare('DELETE FROM job_request_files WHERE request_id = ?').run(request.id);
    db.prepare('DELETE FROM job_requests WHERE id = ?').run(request.id);
    res.json({ deleted: request.id });
});

module.exports = router;
