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

    -- Staff-managed second grouping level, nested under a fixed top category
    -- (see ITEM_CATEGORIES). e.g. "Uniforms" or "Spring Collection" under GFX,
    -- "Chips" under School Store. Income on the Staff Tools home page breaks
    -- down per top category, then per sub-category within it.
    CREATE TABLE IF NOT EXISTS subcategories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        category   TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(category, name)
    );

    -- Shared catalog: general store merchandise and Uniforms items live in
    -- the same table, so restock/storefront-sale/order all move the same
    -- stock_qty. variant_color/variant_size are NULL for items that don't
    -- have that dimension (e.g. general merch, or the two "you provide the
    -- garment" services which only vary by color). subcategory_id is NULL
    -- until staff file the item under one of their sub-categories.
    --   active    : master on/off. Inactive items vanish from every screen
    --               except the catalog admin (they are effectively archived).
    --   orderable : whether the item shows on the public /order/ page and can
    --               be added to an online order. Independent of active, so an
    --               item can be counter-sold / restocked but not orderable
    --               online. The order page requires active = 1 AND orderable = 1.
    CREATE TABLE IF NOT EXISTS items (
        uuid           TEXT    PRIMARY KEY,
        name           TEXT    NOT NULL,
        category       TEXT    NOT NULL DEFAULT 'General',
        subcategory_id INTEGER REFERENCES subcategories(id),
        variant_color  TEXT,
        variant_size   TEXT,
        price_cents    INTEGER NOT NULL DEFAULT 0,
        detail         TEXT    NOT NULL DEFAULT '',
        stock_qty      INTEGER NOT NULL DEFAULT 0,
        active         INTEGER NOT NULL DEFAULT 1,
        orderable      INTEGER NOT NULL DEFAULT 1,
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

    -- Financial ledger: one row per money movement, independent of the stock
    -- ledger (stock_events). Today it is written only by counter sales
    -- (routes/inventory.js -> recordTransaction). When online payment handling
    -- is added, the order flow (routes/orders.js) MUST also write a row here
    -- per line item so this log stays complete — see the TODO there.
    --   type   : 'deposit' (money in) | 'withdrawal' (refund / money out)
    --   vendor : 'Storefront' | 'Online Pay'
    --   amount_cents : always positive; the type column carries the direction
    --   account: item category at the time of sale (School Store / Athletics / GFX)
    --   notes  : "<item name> x<qty>"
    CREATE TABLE IF NOT EXISTS transactions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        posted_at          INTEGER NOT NULL,
        type               TEXT    NOT NULL CHECK(type IN ('deposit','withdrawal')),
        vendor             TEXT    NOT NULL,
        amount_cents       INTEGER NOT NULL,
        account            TEXT    NOT NULL DEFAULT '',
        notes              TEXT    NOT NULL DEFAULT '',
        source             TEXT    NOT NULL CHECK(source IN ('storefront_sale','online_order','adjustment')),
        ref_stock_event_id INTEGER,
        ref_order_id       INTEGER,
        actor_user_key     TEXT    NOT NULL DEFAULT '',
        created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_posted  ON transactions(posted_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account);
`);

// The fixed set of item categories. Income is totalled per category on the
// Staff Tools home page. GFX is the default / catch-all (all legacy items were
// consolidated into it by migration v1 below).
const ITEM_CATEGORIES = ['School Store', 'Athletics', 'GFX'];
const DEFAULT_CATEGORY = 'GFX';

function normalizeCategory(value) {
    return ITEM_CATEGORIES.includes(value) ? value : DEFAULT_CATEGORY;
}

// --- Schema migrations -------------------------------------------------------
// Bump SCHEMA_VERSION and add a matching `if (fromVersion < N)` block for each
// change. PRAGMA user_version persists in the DB file, so each block runs once.
const SCHEMA_VERSION = 4;
const fromVersion = db.prepare('PRAGMA user_version').get().user_version;

// True when items already has the given column (used to make ADD COLUMN
// migrations no-ops on fresh DBs, where CREATE TABLE above supplies the column).
const itemsHasColumn = (name) =>
    db.prepare('PRAGMA table_info(items)').all().some((col) => col.name === name);

if (fromVersion < 1) {
    // Collapse every pre-existing item category (Uniforms, General, ...) into
    // the fixed category set. Runs once; staff category edits made afterwards
    // are preserved because this block never runs again.
    db.exec(`UPDATE items SET category = '${DEFAULT_CATEGORY}'
             WHERE category NOT IN ('School Store', 'Athletics', 'GFX')`);
}

if (fromVersion < 2) {
    // Add items.subcategory_id to DBs created before sub-categories existed.
    if (!itemsHasColumn('subcategory_id')) {
        db.exec('ALTER TABLE items ADD COLUMN subcategory_id INTEGER REFERENCES subcategories(id)');
    }
}

if (fromVersion < 3) {
    // Backfill the financial ledger from every counter sale already in the
    // stock ledger. Historical rows are valued at the item's CURRENT price —
    // sale-time price was never recorded before this table existed — so a
    // later price change shifts their amount. Sales made from here on snapshot
    // their own amount_cents and are unaffected. Same caveat as the income
    // report in routes/reports.js. Runs once (no-op on a fresh DB).
    db.exec(`
        INSERT INTO transactions
            (posted_at, type, vendor, amount_cents, account, notes, source, ref_stock_event_id, actor_user_key, created_at)
        SELECT se.created_at, 'deposit', 'Storefront',
               (-se.delta) * i.price_cents,
               i.category,
               i.name ||
                   CASE WHEN COALESCE(i.variant_color, i.variant_size) IS NOT NULL
                        THEN ' (' || TRIM(COALESCE(i.variant_color, '') || ' ' || COALESCE(i.variant_size, '')) || ')'
                        ELSE '' END
                   || ' x' || (-se.delta),
               'storefront_sale', se.id, se.actor_user_key, se.created_at
        FROM stock_events se
        JOIN items i ON i.uuid = se.item_uuid
        WHERE se.reason = 'storefront_sale'
    `);
}

if (fromVersion < 4) {
    // Add items.orderable. Existing items default to 1 (shown on the order
    // page) so behaviour is unchanged for current catalogs.
    if (!itemsHasColumn('orderable')) {
        db.exec('ALTER TABLE items ADD COLUMN orderable INTEGER NOT NULL DEFAULT 1');
    }
}

if (fromVersion < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// Runs every boot; the column is guaranteed to exist by here (fresh DBs get it
// from CREATE TABLE, older DBs from the v2 migration above).
db.exec('CREATE INDEX IF NOT EXISTS idx_items_subcategory ON items(subcategory_id)');

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
        const insert = db.prepare(
            `INSERT INTO stock_events(item_uuid, delta, reason, actor_user_key, note, ref_order_id, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)`
        ).run(itemUuid, delta, reason, actorUserKey, note, refOrderId, Date.now());
        db.exec('COMMIT');
        return { stockEventId: Number(insert.lastInsertRowid) };
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

// Appends one row to the financial ledger (transactions). Keep amountCents
// positive — `type` ('deposit' | 'withdrawal') carries the direction. `account`
// is the item category so the export lines up with the income-by-category
// report. Returns the stored row.
function recordTransaction({
    postedAt = Date.now(), type, vendor, amountCents, account = '', notes = '',
    source, refStockEventId = null, refOrderId = null, actorUserKey = '',
}) {
    const info = db.prepare(`
        INSERT INTO transactions
            (posted_at, type, vendor, amount_cents, account, notes, source, ref_stock_event_id, ref_order_id, actor_user_key, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(postedAt, type, vendor, Math.round(amountCents), account, notes, source, refStockEventId, refOrderId, actorUserKey, Date.now());
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(info.lastInsertRowid));
}

// Catalog rows carry the sub-category name (not just its id) so callers never
// have to join again. subcategory is NULL for items not filed under one.
const ITEM_SELECT = `
    SELECT i.*, s.name AS subcategory
    FROM items i
    LEFT JOIN subcategories s ON s.id = i.subcategory_id
`;

function getItem(uuid) {
    return db.prepare(`${ITEM_SELECT} WHERE i.uuid = ?`).get(uuid);
}

module.exports = {
    db, upsertUser, isStaff, applyStockDelta, recordTransaction, randomUUID,
    ITEM_CATEGORIES, DEFAULT_CATEGORY, normalizeCategory,
    ITEM_SELECT, getItem,
};
