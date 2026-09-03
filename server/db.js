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

    -- Individual out-of-district email addresses allowed to sign in, on top of
    -- the ALLOWED_DOMAINS gate in server/auth.js. Managed with
    -- server/manage-signin.js. Emails are stored lower-cased. These accounts
    -- count as district users (isDistrictUser in server/auth.js): they can sign
    -- in, order, and use /request/ + /jerseys/. They get no admin access unless
    -- also added to staff_whitelist.
    CREATE TABLE IF NOT EXISTS signin_allowlist (
        email      TEXT PRIMARY KEY,
        note       TEXT    NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
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

    -- Shared color palette: one hex per color name. items.variant_color stays
    -- free text and links to a row here by name (case-insensitive) so the order
    -- page can render a real swatch. A color with no row here falls back to a
    -- neutral swatch. Managed from the "Colors" card in the item catalog.
    CREATE TABLE IF NOT EXISTS colors (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        hex        TEXT    NOT NULL DEFAULT '#cccccc',
        created_at INTEGER NOT NULL,
        UNIQUE(name COLLATE NOCASE)
    );

    -- Print-job requests submitted by district staff at other buildings
    -- (routes/requests.js). Separate from the store orders table: no payment, no
    -- stock, tracked by the lab through the status column. Artwork lives in object
    -- storage (server/storage.js); job_request_files holds one row per file.
    CREATE TABLE IF NOT EXISTS job_requests (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key       TEXT    NOT NULL,
        requester_name TEXT    NOT NULL,
        email          TEXT    NOT NULL,
        job_name       TEXT    NOT NULL,
        building       TEXT    NOT NULL DEFAULT '',
        phone          TEXT    NOT NULL DEFAULT '',
        category       TEXT    NOT NULL,
        quantity       TEXT    NOT NULL DEFAULT '',
        needed_by      TEXT    NOT NULL DEFAULT '',
        description    TEXT    NOT NULL DEFAULT '',
        status         TEXT    NOT NULL DEFAULT 'new'
                        CHECK(status IN ('new','in_progress','quoted','complete','cancelled')),
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_requests_status ON job_requests(status);

    CREATE TABLE IF NOT EXISTS job_request_files (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id   INTEGER NOT NULL,
        object_key   TEXT    NOT NULL,
        file_name    TEXT    NOT NULL,
        content_type TEXT    NOT NULL DEFAULT '',
        size_bytes   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_request_files_request ON job_request_files(request_id);

    -- Team jersey rosters (routes/jerseys.js) — a QoL builder for coaches, no
    -- payment. One jersey_jobs row per roster (owned by the submitting coach's
    -- user_key), jersey_players holds the table rows.
    CREATE TABLE IF NOT EXISTS jersey_jobs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key     TEXT    NOT NULL,
        email        TEXT    NOT NULL,
        job_name     TEXT    NOT NULL,
        jersey_style TEXT    NOT NULL CHECK(jersey_style IN ('male','female')),
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jersey_jobs_user ON jersey_jobs(user_key);

    CREATE TABLE IF NOT EXISTS jersey_players (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id     INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name       TEXT    NOT NULL,
        number     TEXT    NOT NULL DEFAULT '',
        size       TEXT    NOT NULL DEFAULT '',
        color      TEXT    NOT NULL DEFAULT '',
        info       TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_jersey_players_job ON jersey_players(job_id);

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

    -- payment_status is app-enforced (no CHECK so ALTER ADD COLUMN on older DBs
    -- stays simple): 'unpaid' (order placed, Stripe Checkout not completed),
    -- 'paid', 'refunded', 'free' ($0 order, no Stripe), 'legacy' (placed before
    -- online payment existed). payment_ref = Stripe Checkout Session id,
    -- payment_intent = its PaymentIntent id (used to issue refunds).
    CREATE TABLE IF NOT EXISTS orders (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key       TEXT    NOT NULL REFERENCES users(user_key),
        customer_name  TEXT    NOT NULL,
        email          TEXT    NOT NULL,
        student_id     TEXT    NOT NULL DEFAULT '',
        status         TEXT    NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','fulfilled','cancelled')),
        total_cents    INTEGER NOT NULL,
        tax_cents      INTEGER NOT NULL DEFAULT 0,
        payment_status TEXT    NOT NULL DEFAULT 'unpaid',
        payment_ref    TEXT,
        payment_intent TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
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
        line_total_cents INTEGER NOT NULL,
        tax_cents        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

    -- Financial ledger: one row per money movement, independent of the stock
    -- ledger (stock_events). Today it is written only by counter sales
    -- (routes/inventory.js -> recordTransaction). When online payment handling
    -- is added, the order flow (routes/orders.js) MUST also write a row here
    -- per line item so this log stays complete — see the TODO there.
    --   type   : 'deposit' (money in) | 'withdrawal' (refund / money out)
    --   vendor : 'Storefront' | 'Online Pay'
    --   amount_cents : always positive; the type column carries the direction.
    --                  This is the GROSS (tax-inclusive) amount that moved.
    --   tax_cents    : the CT sales tax (6.35%) portion contained in amount_cents.
    --                  Net revenue = amount_cents - tax_cents. 0 for tax-exempt
    --                  items (sub-category "Supplies") and for adjustments.
    --   account: item category at the time of sale (School Store / Athletics / GFX)
    --   notes  : "<item name> x<qty>"
    CREATE TABLE IF NOT EXISTS transactions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        posted_at          INTEGER NOT NULL,
        type               TEXT    NOT NULL CHECK(type IN ('deposit','withdrawal')),
        vendor             TEXT    NOT NULL,
        amount_cents       INTEGER NOT NULL,
        tax_cents          INTEGER NOT NULL DEFAULT 0,
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

// Connecticut sales tax. The catalogue price_cents is treated as tax-INCLUSIVE:
// the customer pays exactly price_cents, and that amount already contains the
// tax. splitTaxInclusive() pulls the tax back out of a gross amount.
const CT_TAX_RATE = 0.0635;
const TAX_EXEMPT_SUBCATEGORY = 'supplies';

// True when an item is tax-exempt because of its sub-category name. Pass the
// sub-category NAME (ITEM_SELECT exposes it as `subcategory`); match is
// case/space-insensitive so "Supplies", " supplies " etc. all count.
function isSubcategoryTaxExempt(subcategoryName) {
    return String(subcategoryName ?? '').trim().toLowerCase() === TAX_EXEMPT_SUBCATEGORY;
}

// Splits a gross (tax-inclusive) amount into { netCents, taxCents } such that
// netCents + taxCents === grossCents exactly. Rounding is done once on the
// amount passed in, so callers should pass the LINE total (price * qty), not a
// unit price, to avoid per-unit drift. taxable=false returns all-net.
function splitTaxInclusive(grossCents, taxable = true) {
    const gross = Math.round(grossCents);
    if (!taxable || gross <= 0) return { netCents: gross, taxCents: 0 };
    const netCents = Math.round(gross / (1 + CT_TAX_RATE));
    return { netCents, taxCents: gross - netCents };
}

// Fixed choice lists for the district-staff self-service tools.
const JOB_CATEGORIES = [
    'Screen Printing',
    'Embroidery',
    'DTF Transfer (Full Color)',
    'Banner',
    'Stickers, Decals & Signs',
    'Not sure yet',
];
const JERSEY_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

function normalizeCategory(value) {
    return ITEM_CATEGORIES.includes(value) ? value : DEFAULT_CATEGORY;
}

// --- Schema migrations -------------------------------------------------------
// Bump SCHEMA_VERSION and add a matching `if (fromVersion < N)` block for each
// change. PRAGMA user_version persists in the DB file, so each block runs once.
const SCHEMA_VERSION = 6;
const fromVersion = db.prepare('PRAGMA user_version').get().user_version;

// True when the table already has the given column (used to make ADD COLUMN
// migrations no-ops on fresh DBs, where CREATE TABLE above supplies the column).
const tableHasColumn = (table, name) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === name);
const itemsHasColumn = (name) => tableHasColumn('items', name);

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

if (fromVersion < 5) {
    // Online payment (Stripe). Add the payment columns to DBs created before it.
    if (!tableHasColumn('orders', 'payment_status')) {
        db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'");
    }
    if (!tableHasColumn('orders', 'payment_ref')) {
        db.exec('ALTER TABLE orders ADD COLUMN payment_ref TEXT');
    }
    if (!tableHasColumn('orders', 'payment_intent')) {
        db.exec('ALTER TABLE orders ADD COLUMN payment_intent TEXT');
    }
    // Every order that existed before this migration predates online payment —
    // mark it 'legacy' so it is never swept as an abandoned unpaid order and
    // never implies a card was charged. No-op on a fresh DB (no rows).
    db.exec("UPDATE orders SET payment_status = 'legacy'");
}

if (fromVersion < 6) {
    // CT sales tax (6.35%), handled as tax-INCLUSIVE: price_cents already
    // contains the tax. Add the columns that hold the split, then back-fill
    // every historical row once.
    if (!tableHasColumn('orders', 'tax_cents')) {
        db.exec('ALTER TABLE orders ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0');
    }
    if (!tableHasColumn('order_items', 'tax_cents')) {
        db.exec('ALTER TABLE order_items ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0');
    }
    if (!tableHasColumn('transactions', 'tax_cents')) {
        db.exec('ALTER TABLE transactions ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0');
    }

    // Back-fill. Tax is pulled out of the stored gross amount:
    //   tax = gross - round(gross / 1.0635)
    // unless the item's current sub-category is "Supplies" (tax-exempt), in
    // which case tax = 0. Historical rows are classified by the item's CURRENT
    // sub-category (sale-time sub-category was never recorded) — same caveat as
    // the v3 ledger back-fill and the income report. No-op on a fresh DB.
    db.exec(`
        UPDATE order_items
        SET tax_cents = (
            SELECT CASE
                WHEN LOWER(TRIM(COALESCE(s.name, ''))) = '${TAX_EXEMPT_SUBCATEGORY}' THEN 0
                ELSE order_items.line_total_cents
                     - CAST(ROUND(order_items.line_total_cents / ${1 + CT_TAX_RATE}) AS INTEGER)
            END
            FROM items i
            LEFT JOIN subcategories s ON s.id = i.subcategory_id
            WHERE i.uuid = order_items.item_uuid
        )
        WHERE EXISTS (SELECT 1 FROM items i WHERE i.uuid = order_items.item_uuid);

        UPDATE orders
        SET tax_cents = COALESCE(
            (SELECT SUM(oi.tax_cents) FROM order_items oi WHERE oi.order_id = orders.id), 0);

        UPDATE transactions
        SET tax_cents = (
            SELECT CASE
                WHEN LOWER(TRIM(COALESCE(s.name, ''))) = '${TAX_EXEMPT_SUBCATEGORY}' THEN 0
                ELSE transactions.amount_cents
                     - CAST(ROUND(transactions.amount_cents / ${1 + CT_TAX_RATE}) AS INTEGER)
            END
            FROM stock_events se
            JOIN items i ON i.uuid = se.item_uuid
            LEFT JOIN subcategories s ON s.id = i.subcategory_id
            WHERE se.id = transactions.ref_stock_event_id
        )
        WHERE source = 'storefront_sale'
          AND ref_stock_event_id IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM stock_events se JOIN items i ON i.uuid = se.item_uuid
              WHERE se.id = transactions.ref_stock_event_id
          );

        -- Online-order transaction rows carry no item reference, so they can't
        -- be classified by sub-category; treat them all as taxable. In practice
        -- there are none (test orders were cleared; pre-Stripe orders are
        -- 'legacy' and wrote no ledger rows).
        UPDATE transactions
        SET tax_cents = amount_cents - CAST(ROUND(amount_cents / ${1 + CT_TAX_RATE}) AS INTEGER)
        WHERE source = 'online_order' AND tax_cents = 0;
    `);
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

// True when this exact address is on the out-of-district sign-in allow-list
// (server/manage-signin.js). Stored and compared lower-cased.
function isSigninAllowed(email) {
    return !!db.prepare('SELECT 1 FROM signin_allowlist WHERE email = ?')
        .get(String(email || '').trim().toLowerCase());
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
    postedAt = Date.now(), type, vendor, amountCents, taxCents = 0, account = '', notes = '',
    source, refStockEventId = null, refOrderId = null, actorUserKey = '',
}) {
    const info = db.prepare(`
        INSERT INTO transactions
            (posted_at, type, vendor, amount_cents, tax_cents, account, notes, source, ref_stock_event_id, ref_order_id, actor_user_key, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(postedAt, type, vendor, Math.round(amountCents), Math.round(taxCents), account, notes, source, refStockEventId, refOrderId, actorUserKey, Date.now());
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(info.lastInsertRowid));
}

// Catalog rows carry the sub-category name (not just its id) so callers never
// have to join again. subcategory is NULL for items not filed under one.
const ITEM_SELECT = `
    SELECT i.*, s.name AS subcategory, c.hex AS variant_hex
    FROM items i
    LEFT JOIN subcategories s ON s.id = i.subcategory_id
    LEFT JOIN colors c ON c.name = i.variant_color COLLATE NOCASE
`;

// Normalizes a hex color to lowercase #rrggbb. Accepts a missing leading '#' and
// 3-digit shorthand. Returns null for anything that still isn't a valid 6-digit hex.
function normalizeHex(raw) {
    let s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (s && s[0] !== '#') s = `#${s}`;
    if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

function getItem(uuid) {
    return db.prepare(`${ITEM_SELECT} WHERE i.uuid = ?`).get(uuid);
}

// Cancels orders whose shopper never finished Stripe Checkout. Only touches
// 'unpaid' orders (nothing was charged, no stock/ledger movement to undo) older
// than maxAgeMs. A late webhook still wins if payment actually completes first —
// it processes regardless of status. Returns the number of orders swept.
function sweepStaleUnpaidOrders(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const info = db.prepare(`
        UPDATE orders SET status = 'cancelled', updated_at = ?
        WHERE payment_status = 'unpaid' AND status <> 'cancelled' AND created_at < ?
    `).run(Date.now(), cutoff);
    return info.changes;
}

module.exports = {
    db, upsertUser, isStaff, isSigninAllowed, applyStockDelta, recordTransaction, randomUUID,
    ITEM_CATEGORIES, DEFAULT_CATEGORY, normalizeCategory, normalizeHex,
    CT_TAX_RATE, splitTaxInclusive, isSubcategoryTaxExempt,
    JOB_CATEGORIES, JERSEY_SIZES,
    ITEM_SELECT, getItem, sweepStaleUnpaidOrders,
};
