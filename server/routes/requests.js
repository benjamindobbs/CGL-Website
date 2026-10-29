const { Router } = require('express');
const multer = require('multer');
const {
    db, randomUUID, JOB_CATEGORIES, getRequestDecoration: decorationFor,
    DECORATION_CATEGORIES, DESIGN_LOCATIONS, GARMENT_TYPES, APPAREL_SIZES, DECORATION_COLOR_LIMITS,
    SIZED_CATEGORIES, SURFACE_CATEGORIES, SURFACE_TYPES,
    JERSEY_OPTIONS, NAME_NUMBER_DTF_ONLY, NAME_NUMBER_METHOD_CHOICE,
} = require('../db');
const { requireDistrictStaff } = require('../auth');
const { requireStaff, requireAdmin } = require('../staffAuth');
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

// Plain-text renderings shared by the emails and the CSV export.
const garmentText = (r) => (r.garment_type === 'Other' ? `Other: ${r.garment_other}` : r.garment_type);
const colorsText = (c) => (c === 'not_sure' ? 'colors not sure' : c ? `${c} color${c === '1' ? '' : 's'}` : '');
const METHOD_TEXT = { dtf: 'DTF', embroidery: 'embroidery' };
// "Full Back (Name & Number, DTF), Sleeve (Number Only, embroidery, 2 colors)"
const locationsText = (locations) => locations.map((l) => {
    const name = l.location === 'Other' ? `Other: ${l.other_text}` : l.location;
    const details = [JERSEY_OPTIONS[l.name_number], METHOD_TEXT[l.method], colorsText(l.colors)].filter(Boolean);
    return details.length ? `${name} (${details.join(', ')})` : name;
}).join(', ');
const rosterText = (r, roster) => (roster.length
    ? `${r.roster_name}: ${roster.length} player${roster.length === 1 ? '' : 's'}, ${r.jersey_style} jerseys`
    : '');
const sizesText = (sizes) => sizes.map((s) => `${s.size} ${s.qty}`).join(', ');
// "Navy: M 12, L 8 (20); White: 30. 50 total", or the plain quantity for other jobs.
const quantityText = (r, colors) => {
    if (!colors.length) return r.quantity;
    const groups = colors.map((c) => (c.sizes.length ? `${c.color}: ${sizesText(c.sizes)} (${c.qty})` : `${c.color}: ${c.qty}`));
    return colors.length > 1 ? `${groups.join('; ')}. ${r.quantity} total` : groups[0];
};
const surfaceText = (r) => (r.surface_type === 'Other' ? `Other: ${r.surface_other}` : r.surface_type);

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
    const { locations, colors, roster } = decorationFor(request.id);
    const decoration = DECORATION_CATEGORIES.includes(request.category) && request.garment_type;
    const details = [
        ['Category', request.category],
        ...(decoration ? [
            ['Design locations', locationsText(locations)],
            ['Garment', garmentText(request)],
            ['Blank', request.blank_ref || '—'],
        ] : []),
        ...(roster.length ? [['Team roster', rosterText(request, roster)]] : []),
        ...(request.item_size ? [['Size', request.item_size]] : []),
        ...(request.surface_type ? [['Surface', surfaceText(request)]] : []),
        [colors.length ? 'Colors & quantity' : 'Quantity', quantityText(request, colors) || '—'],
        ['Needed by', request.needed_by || '—'],
    ];
    const table = (rows) => `<table>${rows.map(([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;vertical-align:top"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>`;
    const html =
        `<p>New print-job request #${request.id}.</p>` +
        table([
            ['Requester', `${request.requester_name} <${request.email}>`],
            ['Job name', request.job_name],
            ['Building', request.building || '—'],
            ['Phone', request.phone || '—'],
            ...details,
            ['Attachments', String(fileCount)],
        ]) +
        `<p><b>Description</b><br>${esc(request.description || '—').replace(/\n/g, '<br>')}</p>` +
        (roster.length
            ? '<p><b>Roster</b></p><table><tr><th align="left">Name</th><th align="left">#</th><th align="left">Size</th><th align="left">Color</th><th align="left">Notes</th></tr>' +
              roster.map((p) => `<tr>${[p.name, p.number, p.size, p.color, p.info]
                  .map((v) => `<td style="padding:2px 12px 2px 0">${esc(v)}</td>`).join('')}</tr>`).join('') +
              '</table>'
            : '');

    sendMail({ to: LAB_INBOX, subject: `Job request: ${request.job_name} (${request.category})`, html, replyTo: request.email })
        .catch((err) => console.error('[requests] lab notify failed:', err));
    sendMail({
        to: request.email,
        subject: `We got your request: ${request.job_name}`,
        html: `<p>Hi ${esc(request.requester_name)},</p><p>The Classical Graphics Lab received your request for <b>${esc(request.job_name)}</b>. Someone will follow up by email. Reply here if you need to add or change anything.</p>` +
            table(details),
    }).catch((err) => console.error('[requests] requester confirm failed:', err));
}

const DTF_CATEGORY = 'DTF Transfer (Full Color)';

// The caller's own saved roster (routes/jerseys.js) with its players, or null.
function loadRoster(id, userKey) {
    const job = db.prepare('SELECT id, job_name, jersey_style FROM jersey_jobs WHERE id = ? AND user_key = ?')
        .get(Number(id) || 0, userKey);
    if (!job) return null;
    job.players = db.prepare('SELECT name, number, size, color, info FROM jersey_players WHERE job_id = ? ORDER BY sort_order, id').all(job.id);
    return job.players.length ? job : null;
}

// Validates the apparel decoration fields for a Screen Printing / Embroidery /
// DTF request. Multipart can't nest, so the form sends locations and color
// groups as JSON strings. hasRoster: a team roster is attached, so locations
// may carry names/numbers. Returns { error } or { fields, locations, colors }.
function parseDecoration(b, category, hasRoster) {
    const limit = DECORATION_COLOR_LIMITS[category]; // undefined for DTF: colors aren't asked
    let rawLocations;
    let rawColors;
    try {
        rawLocations = JSON.parse(b.locations || '[]');
        rawColors = JSON.parse(b.colors || '[]');
    } catch {
        return { error: 'Could not read the design locations or colors' };
    }
    if (!Array.isArray(rawLocations) || !rawLocations.length) return { error: 'Pick at least one design location' };

    const locations = [];
    for (const l of rawLocations) {
        const location = String(l?.location || '').trim();
        if (!DESIGN_LOCATIONS.includes(location)) return { error: `Unknown design location: ${location || '(blank)'}` };
        if (locations.some((x) => x.location === location)) return { error: `${location} is listed twice` };
        const otherText = location === 'Other' ? String(l.other || '').trim() : '';
        if (location === 'Other' && !otherText) return { error: 'Please specify the "Other" design location' };

        // Roster names/numbers: Full Chest/Back are DTF only (acknowledged when
        // the job isn't DTF); Front Pocket/Sleeve are DTF or embroidery.
        const nameNumber = String(l.nameNumber || '').trim();
        let method = '';
        let dtfAck = 0;
        let colorLimit = limit;
        if (nameNumber) {
            if (!hasRoster) return { error: 'Import a team roster to put names or numbers on a location' };
            if (!(nameNumber in JERSEY_OPTIONS)) return { error: `Pick the jersey option for the ${location}` };
            if (NAME_NUMBER_DTF_ONLY.includes(location)) {
                method = 'dtf';
                if (category !== DTF_CATEGORY) {
                    if (l.dtfAck !== true) return { error: `Acknowledge that names/numbers on the ${location} are DTF transfers` };
                    dtfAck = 1;
                }
            } else if (NAME_NUMBER_METHOD_CHOICE.includes(location)) {
                method = String(l.method || '');
                if (!['dtf', 'embroidery'].includes(method)) return { error: `Pick DTF or Embroidery for the names/numbers on the ${location}` };
            } else {
                return { error: `Names/numbers aren't available on ${otherText || location}` };
            }
            colorLimit = method === 'embroidery' ? DECORATION_COLOR_LIMITS.Embroidery : 0;
        }

        let colors = '';
        if (colorLimit) {
            colors = String(l.colors ?? '').trim();
            if (colors !== 'not_sure') {
                const n = Number(colors);
                if (!/^\d+$/.test(colors) || n < 1 || n > colorLimit) {
                    return { error: `Pick the number of colors for ${otherText || location}: 1–${colorLimit}, or Not sure` };
                }
                colors = String(n);
            }
        }
        locations.push({ location, otherText, colors, nameNumber, method, dtfAck });
    }

    const garmentType = String(b.garmentType || '').trim();
    const garmentOther = garmentType === 'Other' ? String(b.garmentOther || '').trim() : '';
    if (!GARMENT_TYPES.includes(garmentType)) return { error: 'Pick a garment type' };
    if (garmentType === 'Other' && !garmentOther) return { error: 'Please specify the "Other" garment type' };

    // One group per garment color, each with a total or a size breakdown.
    const qtyMode = String(b.qtyMode || '');
    if (!['total', 'sizes'].includes(qtyMode)) return { error: 'Choose Total or Qty by Size for the quantity' };
    if (!Array.isArray(rawColors) || !rawColors.length) return { error: 'Enter at least one garment color' };
    const colors = [];
    for (const c of rawColors) {
        const color = String(c?.color || '').trim();
        if (!color) return { error: 'Enter a garment color for each color group' };
        if (colors.some((x) => x.color.toLowerCase() === color.toLowerCase())) return { error: `${color} is listed twice` };
        const sizes = [];
        let qty;
        if (qtyMode === 'total') {
            const total = String(c.qty ?? '').trim();
            if (!/^\d+$/.test(total) || Number(total) < 1) return { error: `Quantity for ${color} must be a whole number of at least 1` };
            qty = Number(total);
        } else {
            if (!Array.isArray(c.sizes)) return { error: `Could not read the sizes for ${color}` };
            for (const s of c.sizes) {
                const size = String(s?.size || '').trim();
                const n = String(s?.qty ?? '').trim();
                if (!APPAREL_SIZES.includes(size)) return { error: `Unknown size: ${size || '(blank)'}` };
                if (sizes.some((x) => x.size === size)) return { error: `Size ${size} is listed twice for ${color}` };
                if (n === '' || n === '0') continue;
                if (!/^\d+$/.test(n)) return { error: `Quantity for ${color} size ${size} must be a whole number` };
                sizes.push({ size, qty: Number(n) });
            }
            if (!sizes.length) return { error: `Enter a quantity for at least one size of ${color}` };
            qty = sizes.reduce((sum, s) => sum + s.qty, 0);
        }
        colors.push({ color, qty, sizes });
    }

    return {
        fields: {
            garmentType, garmentOther, blankRef: String(b.blankRef || '').trim(),
            garmentColor: colors.map((c) => c.color).join(', '),
            qtyMode,
            quantity: String(colors.reduce((sum, c) => sum + c.qty, 0)),
        },
        locations,
        colors,
    };
}

// Finished size (banners, stickers...) and surface (stickers, decals & signs).
// Returns { error } or { itemSize, surfaceType, surfaceOther }.
function parsePrintCut(b, category) {
    const out = { itemSize: '', surfaceType: '', surfaceOther: '' };
    if (SIZED_CATEGORIES.includes(category)) {
        out.itemSize = String(b.itemSize || '').trim();
        if (!out.itemSize) return { error: 'Enter the finished size' };
    }
    if (SURFACE_CATEGORIES.includes(category)) {
        out.surfaceType = String(b.surfaceType || '').trim();
        if (!SURFACE_TYPES.includes(out.surfaceType)) return { error: 'Pick a surface type' };
        out.surfaceOther = out.surfaceType === 'Other' ? String(b.surfaceOther || '').trim() : '';
        if (out.surfaceType === 'Other' && !out.surfaceOther) return { error: 'Please specify the "Other" surface' };
    }
    return out;
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

        // Other categories keep the original free-text quantity.
        let decoration = {
            fields: { garmentType: '', garmentOther: '', blankRef: '', garmentColor: '', qtyMode: '', quantity: String(b.quantity || '').trim() },
            locations: [],
            colors: [],
        };
        let roster = null;
        if (DECORATION_CATEGORIES.includes(category)) {
            if (b.rosterId) {
                roster = loadRoster(b.rosterId, req.userKey);
                if (!roster) return res.status(400).json({ error: 'That roster was not found. Import it again.' });
            }
            decoration = parseDecoration(b, category, !!roster);
            if (decoration.error) return res.status(400).json({ error: decoration.error });
        }
        const d = decoration.fields;
        const printCut = parsePrintCut(b, category);
        if (printCut.error) return res.status(400).json({ error: printCut.error });

        const files = req.files || [];
        if (files.length && !isStorageConfigured()) {
            return res.status(503).json({ error: 'Artwork upload is not available right now — resubmit without files or try later.' });
        }

        const now = Date.now();
        let id;
        db.exec('BEGIN');
        try {
            const info = db.prepare(`
                INSERT INTO job_requests(user_key, requester_name, email, job_name, building, phone, category, quantity, needed_by, description,
                                         garment_type, garment_other, blank_ref, garment_color, qty_mode,
                                         item_size, surface_type, surface_other, jersey_job_id, roster_name, jersey_style,
                                         status, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
            `).run(
                req.userKey, requesterName, req.userEmail, jobName,
                String(b.building || '').trim(), String(b.phone || '').trim(), category,
                d.quantity, String(b.neededBy || '').trim(), String(b.description || '').trim(),
                d.garmentType, d.garmentOther, d.blankRef, d.garmentColor, d.qtyMode,
                printCut.itemSize, printCut.surfaceType, printCut.surfaceOther,
                roster ? roster.id : null, roster ? roster.job_name : '', roster ? roster.jersey_style : '',
                now, now
            );
            id = Number(info.lastInsertRowid);
            const insertLocation = db.prepare(`
                INSERT INTO job_request_locations(request_id, sort_order, location, other_text, colors, name_number, method, dtf_ack)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            `);
            decoration.locations.forEach((l, i) =>
                insertLocation.run(id, i, l.location, l.otherText, l.colors, l.nameNumber, l.method, l.dtfAck));
            if (roster) {
                const insertPlayer = db.prepare('INSERT INTO job_request_roster(request_id, sort_order, name, number, size, color, info) VALUES(?, ?, ?, ?, ?, ?, ?)');
                roster.players.forEach((p, i) => insertPlayer.run(id, i, p.name, p.number, p.size, p.color, p.info));
            }
            const insertColor = db.prepare('INSERT INTO job_request_colors(request_id, sort_order, color, qty) VALUES(?, ?, ?, ?)');
            const insertSize = db.prepare('INSERT INTO job_request_sizes(request_id, color_id, size, qty) VALUES(?, ?, ?, ?)');
            decoration.colors.forEach((c, i) => {
                const colorId = Number(insertColor.run(id, i, c.color, c.qty).lastInsertRowid);
                for (const s of c.sizes) insertSize.run(id, colorId, s.size, s.qty);
            });
            db.exec('COMMIT');
        } catch (dbErr) {
            db.exec('ROLLBACK');
            console.error('[requests] insert failed:', dbErr);
            return res.status(500).json({ error: 'Could not save the request. Please try again.' });
        }

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
            deleteRequestRows(id);
            return res.status(502).json({ error: 'Could not store the artwork. Nothing was saved — please try again.' });
        }

        const request = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(id);
        notify(request, files.length);
        res.status(201).json({ id });
    });
});

// The request's own rows. A job packet built from it is kept, detached
// (request_id NULL): its job number may already be live in ClassicalKenKen.
function deleteRequestRows(id) {
    db.prepare('DELETE FROM job_request_files WHERE request_id = ?').run(id);
    db.prepare('DELETE FROM job_request_locations WHERE request_id = ?').run(id);
    db.prepare('DELETE FROM job_request_sizes WHERE request_id = ?').run(id);
    db.prepare('DELETE FROM job_request_colors WHERE request_id = ?').run(id);
    db.prepare('DELETE FROM job_request_roster WHERE request_id = ?').run(id);
    db.prepare('UPDATE job_packets SET request_id = NULL WHERE request_id = ?').run(id);
    db.prepare('DELETE FROM job_requests WHERE id = ?').run(id);
}

const REQUEST_SELECT = `
    SELECT r.*, p.id AS packet_id, p.job_number
    FROM job_requests r
    LEFT JOIN job_packets p ON p.request_id = r.id
`;

router.get('/', requireStaff, async (req, res) => {
    const { status } = req.query;
    const rows = status
        ? db.prepare(`${REQUEST_SELECT} WHERE r.status = ? ORDER BY r.created_at DESC`).all(status)
        : db.prepare(`${REQUEST_SELECT} ORDER BY r.created_at DESC`).all();
    res.json(await Promise.all(rows.map((r) => withDownloadUrls(Object.assign(r, decorationFor(r.id))))));
});

router.patch('/:id', requireAdmin, (req, res) => {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const result = db.prepare('UPDATE job_requests SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Date.now(), req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Request not found' });
    res.json(db.prepare('SELECT * FROM job_requests WHERE id = ?').get(req.params.id));
});

router.get('/export.csv', requireStaff, (req, res) => {
    const rows = db.prepare(`${REQUEST_SELECT} ORDER BY r.created_at DESC`).all();
    const byRequest = db.prepare('SELECT file_name FROM job_request_files WHERE request_id = ? ORDER BY id');
    const body = csvDocument(
        ['Submitted', 'Requester', 'Email', 'Job Name', 'Building', 'Phone', 'Category',
            'Design Locations', 'Garment Type', 'Blank', 'Garment Colors', 'Item Size', 'Surface',
            'Quantity', 'Qty by Color/Size', 'Team Roster',
            'Needed By', 'Status', 'Job Number', 'Description', 'Files'],
        rows.map((r) => {
            const { locations, colors, roster } = decorationFor(r.id);
            return [
                new Date(r.created_at).toISOString(),
                r.requester_name, r.email, r.job_name, r.building, r.phone, r.category,
                locationsText(locations), r.garment_type ? garmentText(r) : '', r.blank_ref, r.garment_color,
                r.item_size, r.surface_type ? surfaceText(r) : '',
                r.quantity, colors.length ? quantityText(r, colors) : '', rosterText(r, roster),
                r.needed_by, r.status, r.job_number || '', r.description,
                byRequest.all(r.id).map((f) => f.file_name).join('; '),
            ];
        })
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="job-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(body);
});

// One request's copied roster, a row per player, with where the names and
// numbers go repeated on each row so the sheet stands on its own.
router.get('/:id/roster.csv', requireStaff, (req, res) => {
    const request = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    const { locations, roster } = decorationFor(request.id);
    if (!roster.length) return res.status(404).json({ error: 'This request has no roster' });
    const placements = locations.filter((l) => l.name_number)
        .map((l) => `${l.location}: ${JERSEY_OPTIONS[l.name_number]} (${METHOD_TEXT[l.method] || 'job process'})`).join('; ');
    const body = csvDocument(
        ['Name on Jersey', 'Number', 'Size', 'Color', 'Additional Info', 'Jersey Style', 'Name/Number Placement'],
        roster.map((p) => [p.name, p.number, p.size, p.color, p.info, request.jersey_style, placements])
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="request-${request.id}-roster.csv"`);
    res.send(body);
});

router.delete('/:id', requireAdmin, async (req, res) => {
    const request = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    for (const f of filesFor(request.id)) {
        if (isStorageConfigured()) await deleteObject(f.object_key).catch(() => {});
    }
    deleteRequestRows(request.id);
    res.json({ deleted: request.id });
});

module.exports = router;
