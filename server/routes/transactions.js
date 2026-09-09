const { Router } = require('express');
const { db } = require('../db');
const { requireStaff } = require('../staffAuth');
const { csvDocument } = require('../csv');
const { dayBound, etDate } = require('../etDate');

const router = Router();
router.use(requireStaff);

function queryTransactions({ from, to, account, paymentMethod }) {
    const where = [];
    const params = [];
    const fromMs = dayBound(from);
    const toMs = dayBound(to, true);
    if (fromMs !== null) { where.push('posted_at >= ?'); params.push(fromMs); }
    if (toMs !== null) { where.push('posted_at <= ?'); params.push(toMs); }
    if (account) { where.push('account = ?'); params.push(account); }
    if (paymentMethod === 'cash' || paymentMethod === 'online') {
        where.push('payment_method = ?'); params.push(paymentMethod);
    }

    const sql = `
        SELECT id, posted_at, type, vendor, amount_cents, tax_cents, account, notes, source, payment_method, ref_order_id
        FROM transactions
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY posted_at DESC, id DESC
    `;
    return db.prepare(sql).all(...params);
}

// Signed dollars: deposits positive, withdrawals negative. No currency symbol
// so spreadsheets treat it as a number. `cents` picks which column.
function signedDollars(row, cents = row.amount_cents) {
    const signed = row.type === 'withdrawal' ? -cents : cents;
    return (signed / 100).toFixed(2);
}

// Amount is the gross (tax-inclusive) money moved; Tax is the CT sales tax
// portion inside it; Net = Amount - Tax is the revenue.
const CSV_HEADERS = ['Posted Date', 'Type', 'Vendor', 'Amount', 'Tax', 'Net', 'Account', 'Payment Method', 'Notes'];

router.get('/', (req, res) => {
    res.json(queryTransactions(req.query));
});

router.get('/export.csv', (req, res) => {
    const rows = queryTransactions(req.query);
    const body = csvDocument(CSV_HEADERS, rows.map((t) => [
        etDate(t.posted_at),
        t.type === 'withdrawal' ? 'withdrawal' : 'deposit',
        t.vendor,
        signedDollars(t),
        signedDollars(t, t.tax_cents),
        signedDollars(t, t.amount_cents - t.tax_cents),
        t.account,
        t.payment_method === 'cash' ? 'Cash' : t.payment_method === 'online' ? 'Online' : '',
        t.notes,
    ]));

    const stamp = etDate(Date.now());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="storefront-transactions-${stamp}.csv"`);
    res.send(body);
});

module.exports = router;
