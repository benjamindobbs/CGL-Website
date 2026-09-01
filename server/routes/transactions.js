const { Router } = require('express');
const { db } = require('../db');
const { requireStaff } = require('../staffAuth');

const router = Router();
router.use(requireStaff);

const TIME_ZONE = 'America/New_York';

// Minutes that ET is ahead of UTC at the given instant (negative: ET is behind).
// -240 during EDT, -300 during EST.
function etOffsetMinutes(ms) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: TIME_ZONE, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(ms)).map((p) => [p.type, p.value])
    );
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
    return (asUtc - ms) / 60000;
}

// Epoch ms for a wall-clock time in America/New_York. The noon anchor picks the
// right DST offset for the date (it can be an hour off only for times within the
// 2 a.m. DST switch itself — immaterial for a sales log).
function etWallToUtc(y, mo, d, h, mi, s, msPart) {
    const off = etOffsetMinutes(Date.UTC(y, mo - 1, d, 12));
    return Date.UTC(y, mo - 1, d, h, mi, s, msPart) - off * 60000;
}

// Parses a YYYY-MM-DD query param into an epoch-ms bound, read as an ET
// calendar day. `endOfDay` pushes it to 23:59:59.999 ET so a `to` filter
// includes that whole day. Unparseable input is ignored (returns null).
function dayBound(value, endOfDay = false) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, mo, d] = value.split('-').map(Number);
    return endOfDay ? etWallToUtc(y, mo, d, 23, 59, 59, 999) : etWallToUtc(y, mo, d, 0, 0, 0, 0);
}

function queryTransactions({ from, to, account }) {
    const where = [];
    const params = [];
    const fromMs = dayBound(from);
    const toMs = dayBound(to, true);
    if (fromMs !== null) { where.push('posted_at >= ?'); params.push(fromMs); }
    if (toMs !== null) { where.push('posted_at <= ?'); params.push(toMs); }
    if (account) { where.push('account = ?'); params.push(account); }

    const sql = `
        SELECT id, posted_at, type, vendor, amount_cents, account, notes, source, ref_order_id
        FROM transactions
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY posted_at DESC, id DESC
    `;
    return db.prepare(sql).all(...params);
}

// The America/New_York calendar date for an instant, as YYYY-MM-DD (en-CA).
function etDate(ms) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(ms));
}

// Signed dollars: deposits positive, withdrawals negative. No currency symbol
// so spreadsheets treat it as a number.
function signedDollars(row) {
    const cents = row.type === 'withdrawal' ? -row.amount_cents : row.amount_cents;
    return (cents / 100).toFixed(2);
}

// RFC-4180 field: wrap in quotes and double any embedded quote when the value
// contains a comma, quote, or newline.
function csvField(value) {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADERS = ['Posted Date', 'Type', 'Vendor', 'Amount', 'Account', 'Notes'];

router.get('/', (req, res) => {
    res.json(queryTransactions(req.query));
});

router.get('/export.csv', (req, res) => {
    const rows = queryTransactions(req.query);
    const lines = [CSV_HEADERS.join(',')];
    for (const t of rows) {
        lines.push([
            etDate(t.posted_at),
            t.type === 'withdrawal' ? 'withdrawal' : 'deposit',
            t.vendor,
            signedDollars(t),
            t.account,
            t.notes,
        ].map(csvField).join(','));
    }
    // Excel opens UTF-8 CSV correctly only with a BOM.
    const body = '﻿' + lines.join('\r\n') + '\r\n';

    const stamp = etDate(Date.now());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="storefront-transactions-${stamp}.csv"`);
    res.send(body);
});

module.exports = router;
