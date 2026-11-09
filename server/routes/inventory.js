const { Router } = require('express');
const { db, applyStockDelta, recordTransaction, splitTaxInclusive, isSubcategoryTaxExempt, ITEM_SELECT, findSpecialEvent } = require('../db');
const { requireAdmin } = require('../staffAuth');
const { isCoreAccount } = require('../seed');

function variantLabel(item) {
    const v = [item.variant_color, item.variant_size].filter(Boolean).join(' ');
    return v ? ` (${v})` : '';
}

const router = Router();
router.use(requireAdmin);

function findItem(uuid) {
    return db.prepare(`${ITEM_SELECT} WHERE i.uuid = ?`).get(uuid);
}

router.post('/restock', (req, res) => {
    const { uuid, qty } = req.body;
    const quantity = Number(qty);
    if (!uuid) return res.status(400).json({ error: 'Missing item UUID' });
    if (!Number.isInteger(quantity) || quantity === 0) return res.status(400).json({ error: 'Quantity must be a non-zero whole number' });

    const item = findItem(uuid);
    if (!item) return res.status(404).json({ error: 'No item found for that UUID' });

    applyStockDelta({ itemUuid: uuid, delta: quantity, reason: 'restock', actorUserKey: req.userKey });
    res.json(findItem(uuid));
});

// Rings up an entire sale (one or more scanned items) in a single call so a
// multi-item purchase is one transaction total, not one per scan. Every line
// is validated before anything is applied, so a bad line can't leave a
// partially-rung sale.
//
// specialEvent (optional): the name of a special event type (e.g. "Theatre").
// When set, every line is booked to that event instead of the item's category
// (ledger account + stock_events.special_event), so the income report and
// register reconciliation show the event as its own line. Stock and CT tax
// are handled exactly as for a normal sale. Core lab accounts only, and the
// type must be enabled.
router.post('/storefront-sale', (req, res) => {
    const { lines, paymentMethod, location } = req.body;
    let specialEvent = '';
    if (req.body.specialEvent) {
        if (!isCoreAccount(req.userEmail)) {
            return res.status(403).json({ error: 'Only the core lab accounts can ring up Special Event sales' });
        }
        const event = findSpecialEvent(req.body.specialEvent);
        if (!event) return res.status(400).json({ error: `Unknown special event "${req.body.specialEvent}"` });
        if (!event.enabled) return res.status(400).json({ error: `"${event.name}" is disabled` });
        specialEvent = event.name;
    }
    if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ error: 'Sale must have at least one item' });
    }
    if (paymentMethod !== 'cash' && paymentMethod !== 'online') {
        return res.status(400).json({ error: "paymentMethod must be 'cash' or 'online'" });
    }
    if (location !== 'storefront' && location !== 'cart') {
        return res.status(400).json({ error: "location must be 'storefront' or 'cart'" });
    }

    const resolved = [];
    for (const line of lines || []) {
        const uuid = line && line.uuid;
        const quantity = Number(line && line.qty);
        if (!uuid) return res.status(400).json({ error: 'Missing item UUID' });
        if (!Number.isInteger(quantity) || quantity <= 0) {
            return res.status(400).json({ error: 'Quantity must be a positive whole number' });
        }
        const item = findItem(uuid);
        if (!item) return res.status(404).json({ error: `No item found for UUID ${uuid}` });
        resolved.push({ item, quantity });
    }

    const soldItems = [];
    let totalCents = 0;
    for (const { item, quantity } of resolved) {
        const { stockEventId } = applyStockDelta({
            itemUuid: item.uuid, delta: -quantity, reason: 'storefront_sale', actorUserKey: req.userKey, specialEvent,
        });

        // Financial ledger entry. Amount is snapshotted at the current price so
        // a later price change never rewrites this sale. price_cents is
        // tax-inclusive; pull the CT sales tax out of the line total (0 for a
        // "Supplies" / "Tickets" item).
        const grossCents = quantity * item.price_cents;
        const { taxCents } = splitTaxInclusive(grossCents, !isSubcategoryTaxExempt(item.subcategory));
        recordTransaction({
            type: 'deposit',
            vendor: 'Storefront',
            amountCents: grossCents,
            taxCents,
            account: specialEvent || item.category,
            notes: `${item.name}${variantLabel(item)} x${quantity}`,
            source: 'storefront_sale',
            paymentMethod,
            location,
            refStockEventId: stockEventId,
            actorUserKey: req.userKey,
        });

        totalCents += grossCents;
        soldItems.push(findItem(item.uuid));
    }

    res.json({ items: soldItems, totalCents, specialEvent });
});

module.exports = router;
