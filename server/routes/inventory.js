const { Router } = require('express');
const { db, applyStockDelta } = require('../db');
const { requireStaff } = require('../staffAuth');

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

    applyStockDelta({ itemUuid: uuid, delta: -quantity, reason: 'storefront_sale', actorUserKey: req.userKey });
    res.json(findItem(uuid));
});

module.exports = router;
