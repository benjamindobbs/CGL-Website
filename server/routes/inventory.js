const { Router } = require('express');
const { db, applyStockDelta, recordTransaction } = require('../db');
const { requireStaff } = require('../staffAuth');

function variantLabel(item) {
    const v = [item.variant_color, item.variant_size].filter(Boolean).join(' ');
    return v ? ` (${v})` : '';
}

const router = Router();
router.use(requireStaff);

function findItem(uuid) {
    return db.prepare('SELECT * FROM items WHERE uuid = ?').get(uuid);
}

router.post('/restock', (req, res) => {
    const { uuid, qty } = req.body;
    const quantity = Number(qty);
    if (!uuid) return res.status(400).json({ error: 'Missing item UUID' });
    if (!Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ error: 'Quantity must be a positive whole number' });

    const item = findItem(uuid);
    if (!item) return res.status(404).json({ error: 'No item found for that UUID' });

    applyStockDelta({ itemUuid: uuid, delta: quantity, reason: 'restock', actorUserKey: req.userKey });
    res.json(findItem(uuid));
});

router.post('/storefront-sale', (req, res) => {
    const { uuid, qty } = req.body;
    const quantity = Number.isFinite(Number(qty)) && qty !== '' ? Number(qty) : 1;
    if (!uuid) return res.status(400).json({ error: 'Missing item UUID' });
    if (!Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ error: 'Quantity must be a positive whole number' });

    const item = findItem(uuid);
    if (!item) return res.status(404).json({ error: 'No item found for that UUID' });

    const { stockEventId } = applyStockDelta({
        itemUuid: uuid, delta: -quantity, reason: 'storefront_sale', actorUserKey: req.userKey,
    });

    // Financial ledger entry. Amount is snapshotted at the current price so a
    // later price change never rewrites this sale.
    recordTransaction({
        type: 'deposit',
        vendor: 'Storefront',
        amountCents: quantity * item.price_cents,
        account: item.category,
        notes: `${item.name}${variantLabel(item)} x${quantity}`,
        source: 'storefront_sale',
        refStockEventId: stockEventId,
        actorUserKey: req.userKey,
    });

    res.json(findItem(uuid));
});

module.exports = router;
