const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cgl.db');

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec('PRAGMA foreign_keys = OFF');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        user_key    TEXT    PRIMARY KEY,
        email       TEXT    NOT NULL UNIQUE,
        first_seen  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT    PRIMARY KEY,
        user_key   TEXT    NOT NULL REFERENCES users(user_key),
        created_at INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_key);

    -- Emails allowed into staff-only tools (inventory catalog admin, restock,
    -- storefront, order dashboard). Separate from ALLOWED_DOMAINS in auth.js,
    -- which just gates sign-in generally.
    CREATE TABLE IF NOT EXISTS staff_whitelist (
        email TEXT PRIMARY KEY
    );

    -- Shared catalog: general store merchandise and Uniforms items live in
    -- the same table, so restock/storefront-sale/order all move the same
    -- stock_qty. variant_color/variant_size are NULL for items that don't
    -- have that dimension (e.g. general merch, or the two "you provide the
    -- garment" services which only vary by color).
    CREATE TABLE IF NOT EXISTS items (
        uuid           TEXT    PRIMARY KEY,
        name           TEXT    NOT NULL,
        category       TEXT    NOT NULL DEFAULT 'General',
        variant_color  TEXT,
        variant_size   TEXT,
        price_cents    INTEGER NOT NULL DEFAULT 0,
        detail         TEXT    NOT NULL DEFAULT '',
        stock_qty      INTEGER NOT NULL DEFAULT 0,
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);

    -- Append-only stock ledger. items.stock_qty is a running total kept in
    -- sync with this table inside applyStockDelta() — never write stock_qty
    -- directly outside of that helper.
    CREATE TABLE IF NOT EXISTS stock_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_uuid      TEXT    NOT NULL REFERENCES items(uuid),
        delta          INTEGER NOT NULL,
        reason         TEXT    NOT NULL CHECK(reason IN ('restock','storefront_sale','order','adjustment')),
        actor_user_key TEXT    NOT NULL,
        note           TEXT    NOT NULL DEFAULT '',
        ref_order_id   INTEGER,
        created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stock_events_item ON stock_events(item_uuid);

    CREATE TABLE IF NOT EXISTS orders (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key      TEXT    NOT NULL REFERENCES users(user_key),
        customer_name TEXT    NOT NULL,
        email         TEXT    NOT NULL,
        student_id    TEXT    NOT NULL DEFAULT '',
        status        TEXT    NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','fulfilled','cancelled')),
        total_cents   INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_key);

    CREATE TABLE IF NOT EXISTS order_items (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id         INTEGER NOT NULL REFERENCES orders(id),
        item_uuid        TEXT    NOT NULL REFERENCES items(uuid),
        item_name        TEXT    NOT NULL,
        variant_color    TEXT,
        variant_size     TEXT,
        qty              INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL,
        line_total_cents INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`);

function upsertUser(userKey, email) {
    db.prepare(
        'INSERT OR IGNORE INTO users(user_key, email, first_seen) VALUES(?, ?, ?)'
    ).run(userKey, email, Date.now());
}

function isStaff(email) {
    return !!db.prepare('SELECT 1 FROM staff_whitelist WHERE email = ?').get(email);
}

// Moves an item's stock by delta and records why, atomically. reason must be
// one of the stock_events CHECK values. ref_order_id is only meaningful for
// reason='order'.
function applyStockDelta({ itemUuid, delta, reason, actorUserKey, note = '', refOrderId = null }) {
    db.exec('BEGIN');
    try {
        const result = db.prepare('UPDATE items SET stock_qty = stock_qty + ? WHERE uuid = ?').run(delta, itemUuid);
        if (result.changes === 0) throw new Error('Unknown item UUID');
        db.prepare(
            `INSERT INTO stock_events(item_uuid, delta, reason, actor_user_key, note, ref_order_id, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)`
        ).run(itemUuid, delta, reason, actorUserKey, note, refOrderId, Date.now());
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

module.exports = { db, upsertUser, isStaff, applyStockDelta, randomUUID };
