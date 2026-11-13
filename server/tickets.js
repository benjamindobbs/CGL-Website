// Event tickets (catalog items whose uuid starts with `ticket-`, e.g. the HoCo
// ticket seeded in seed.js). Unlike made-to-order uniforms, tickets are a hard
// cap: they sell out at stock_qty and each signed-in account may hold at most
// TICKET_LIMIT_PER_ACCOUNT of a given ticket.
//
// Stock only moves when Stripe confirms payment (routes/payments.js), so an
// order still sitting in Checkout is counted as "reserved" against the
// remaining stock. Ticket checkouts expire after TICKET_CHECKOUT_TTL_MS so an
// abandoned one frees its seats quickly (the checkout.session.expired webhook
// cancels the order).
const { db } = require('./db');
const { stripe, isStripeConfigured } = require('./stripe');

const TICKET_PREFIX = 'ticket-';
const TICKET_LIMIT_PER_ACCOUNT = 1;
const TICKET_CHECKOUT_TTL_MS = 30 * 60 * 1000; // Stripe's minimum session lifetime

function isTicket(itemUuid) {
    return String(itemUuid || '').startsWith(TICKET_PREFIX);
}

// An unpaid order only holds seats while its Checkout session can still be
// paid. Past that it's dead even if the expiry webhook never arrived, so it
// stops counting (a minute of slack covers the +60s in routes/orders.js).
function openCheckoutCutoff() {
    return Date.now() - TICKET_CHECKOUT_TTL_MS - 2 * 60 * 1000;
}

// Tickets this account already holds: paid (or $0) orders, plus — when
// includePending — orders still open in Checkout.
function heldByAccount(userKey, itemUuid, { includePending }) {
    return db.prepare(`
        SELECT COALESCE(SUM(oi.qty), 0) AS n
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.user_key = ? AND oi.item_uuid = ? AND o.status <> 'cancelled'
          AND (o.payment_status IN ('paid', 'free')
               OR (? AND o.payment_status = 'unpaid' AND o.created_at >= ?))
    `).get(userKey, itemUuid, includePending ? 1 : 0, openCheckoutCutoff()).n;
}

// Seats not yet sold or held in someone's open checkout.
function availableStock(itemUuid) {
    const item = db.prepare('SELECT stock_qty FROM items WHERE uuid = ?').get(itemUuid);
    if (!item) return 0;
    const reserved = db.prepare(`
        SELECT COALESCE(SUM(oi.qty), 0) AS n
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.item_uuid = ? AND o.status <> 'cancelled' AND o.payment_status = 'unpaid'
          AND o.created_at >= ?
    `).get(itemUuid, openCheckoutCutoff()).n;
    return Math.max(0, item.stock_qty - reserved);
}

// For the ticket page: what this account can still buy.
function ticketStatus(userKey, itemUuid) {
    const purchased = heldByAccount(userKey, itemUuid, { includePending: false });
    const available = availableStock(itemUuid);
    const allowance = Math.max(0, TICKET_LIMIT_PER_ACCOUNT - purchased);
    return {
        limit: TICKET_LIMIT_PER_ACCOUNT,
        purchased,
        available,
        canBuy: Math.min(allowance, available),
    };
}

// A shopper who backs out of Checkout and tries again shouldn't be blocked by
// their own abandoned session. Expire this account's open ticket checkouts at
// Stripe and cancel those orders. A session Stripe won't expire (already paid,
// webhook not here yet) is left alone and keeps counting as held.
async function releaseOpenTicketCheckouts(userKey) {
    const open = db.prepare(`
        SELECT DISTINCT o.id, o.payment_ref
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_key = ? AND o.status <> 'cancelled' AND o.payment_status = 'unpaid'
          AND oi.item_uuid LIKE '${TICKET_PREFIX}%'
    `).all(userKey);

    const cancel = db.prepare(
        "UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND payment_status = 'unpaid'"
    );
    for (const order of open) {
        if (order.payment_ref && isStripeConfigured()) {
            try {
                await stripe.checkout.sessions.expire(order.payment_ref);
            } catch (err) {
                let session = null;
                try { session = await stripe.checkout.sessions.retrieve(order.payment_ref); } catch { /* fall through */ }
                if (!session || session.status !== 'expired') continue;
            }
        }
        cancel.run(Date.now(), order.id);
    }
}

// Validates the ticket lines of a new order. Returns an error message, or null
// if the order may proceed. Synchronous on purpose: call it with no `await`
// between this check and the order INSERT so two requests can't both pass it.
function checkTicketLines(userKey, ticketLines) {
    // Sum per ticket first, so splitting a quantity across cart lines can't
    // slip past the limit.
    const byUuid = new Map();
    for (const { item, qty } of ticketLines) {
        const entry = byUuid.get(item.uuid) || { item, qty: 0 };
        entry.qty += qty;
        byUuid.set(item.uuid, entry);
    }

    for (const { item, qty } of byUuid.values()) {
        const held = heldByAccount(userKey, item.uuid, { includePending: true });
        const allowance = TICKET_LIMIT_PER_ACCOUNT - held;
        if (qty > allowance) {
            return allowance <= 0
                ? TICKET_LIMIT_PER_ACCOUNT === 1
                    ? `You already have your ${item.name}.`
                    : `You already have the limit of ${TICKET_LIMIT_PER_ACCOUNT} ${item.name}s.`
                : `Limit ${TICKET_LIMIT_PER_ACCOUNT} per person — you can buy ${allowance} more.`;
        }
        const available = availableStock(item.uuid);
        if (qty > available) {
            return available <= 0
                ? `${item.name}s are sold out.`
                : `Only ${available} ${item.name}${available === 1 ? '' : 's'} left.`;
        }
    }
    return null;
}

// --- Counter (storefront) ticket sales ---------------------------------------
// A cash buyer at the register has no signed-in account, so the per-person
// limit is keyed on student ID instead. Every ticket rung up at the counter
// names one ID from the student_ids roster, and is recorded as its own
// transactions row carrying that ID. The same TICKET_LIMIT_PER_ACCOUNT applies
// per student, counting both counter sales and online orders that typed the ID.

// Counter sales pick out tickets by sub-category ("Tickets", same matching as
// the tax exemption in db.js), so a ticket filed there needs no uuid prefix.
const TICKET_SUBCATEGORY = 'tickets';

function isTicketSubcategory(subcategoryName) {
    return String(subcategoryName ?? '').trim().toLowerCase() === TICKET_SUBCATEGORY;
}

function normalizeStudentId(raw) {
    return String(raw ?? '').trim();
}

function isKnownStudentId(studentId) {
    return !!db.prepare('SELECT 1 FROM student_ids WHERE id = ?').get(studentId);
}

// Tickets this student already holds: counter sales recorded under the ID,
// plus online orders whose (optional, free-text) Student ID field matches —
// paid, $0, or still open in Checkout, as in heldByAccount().
function heldByStudent(studentId, itemUuid) {
    const counter = db.prepare(`
        SELECT COALESCE(SUM(-se.delta), 0) AS n
        FROM transactions t
        JOIN stock_events se ON se.id = t.ref_stock_event_id
        WHERE t.source = 'storefront_sale' AND t.type = 'deposit'
          AND t.student_id = ? AND se.item_uuid = ?
    `).get(studentId, itemUuid).n;
    const online = db.prepare(`
        SELECT COALESCE(SUM(oi.qty), 0) AS n
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE TRIM(o.student_id) = ? AND oi.item_uuid = ? AND o.status <> 'cancelled'
          AND (o.payment_status IN ('paid', 'free')
               OR (o.payment_status = 'unpaid' AND o.created_at >= ?))
    `).get(studentId, itemUuid, openCheckoutCutoff()).n;
    return counter + online;
}

// For the storefront pop-up: is this ID on the roster, and can it buy one more?
function studentTicketStatus(studentId, itemUuid) {
    const held = heldByStudent(studentId, itemUuid);
    return {
        studentId,
        valid: isKnownStudentId(studentId),
        held,
        limit: TICKET_LIMIT_PER_ACCOUNT,
    };
}

// Validates the ticket lines of a counter sale, each { item, studentId } for
// one ticket. Returns an error message, or null if the sale may proceed.
// Synchronous for the same reason as checkTicketLines().
function checkCounterTicketLines(ticketLines) {
    const perStudent = new Map();
    const perItem = new Map();
    for (const { item, studentId } of ticketLines) {
        if (!studentId) return `Enter a student ID for each ${item.name}.`;
        if (!isKnownStudentId(studentId)) return `Student ID ${studentId} isn't on the student list.`;

        const key = `${item.uuid}\n${studentId}`;
        perStudent.set(key, (perStudent.get(key) || 0) + 1);
        const entry = perItem.get(item.uuid) || { item, qty: 0 };
        entry.qty += 1;
        perItem.set(item.uuid, entry);

        const allowance = TICKET_LIMIT_PER_ACCOUNT - heldByStudent(studentId, item.uuid);
        if (perStudent.get(key) > allowance) {
            return allowance <= 0
                ? `Student ID ${studentId} already has a ${item.name}.`
                : `Student ID ${studentId} can buy only ${allowance} ${item.name}${allowance === 1 ? '' : 's'}.`;
        }
    }

    for (const { item, qty } of perItem.values()) {
        const available = availableStock(item.uuid);
        if (qty > available) {
            return available <= 0
                ? `${item.name}s are sold out.`
                : `Only ${available} ${item.name}${available === 1 ? '' : 's'} left.`;
        }
    }
    return null;
}

module.exports = {
    TICKET_LIMIT_PER_ACCOUNT, TICKET_CHECKOUT_TTL_MS,
    isTicket, ticketStatus, releaseOpenTicketCheckouts, checkTicketLines,
    isTicketSubcategory, normalizeStudentId, studentTicketStatus, checkCounterTicketLines,
};
