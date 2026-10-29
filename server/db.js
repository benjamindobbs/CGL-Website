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
    --   role: 'admin'   — everything under /admin/.
    --         'student' — student staff: shift schedule, plus read-only views of
    --                     the item catalog, orders and job requests. No restock,
    --                     storefront sale, transactions or income reports. See
    --                     STAFF_ROLES / requireAdmin in server/staffAuth.js.
    --   display_name: shown on the shift schedule; '' falls back to the email.
    CREATE TABLE IF NOT EXISTS staff_whitelist (
        email        TEXT PRIMARY KEY,
        role         TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','student')),
        display_name TEXT NOT NULL DEFAULT ''
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
    --   Apparel decoration (category in DECORATION_CATEGORIES) adds the garment
    --   columns below plus job_request_locations / job_request_colors /
    --   job_request_sizes rows. They stay '' for every other category and for
    --   requests made before them.
    --   garment_type : one of GARMENT_TYPES; garment_other is the write-in for 'Other'.
    --   blank_ref    : optional blank model name or supplier link, free text.
    --   garment_color: the job_request_colors names joined with ', ', kept for
    --                  one-line displays (CSV, email subject lines).
    --   qty_mode     : 'total' (one whole number per color) or 'sizes' (a size
    --                  breakdown per color). quantity holds the grand total.
    --                  '' = the original free-text quantity.
    --   item_size    : required for SIZED_CATEGORIES (banner, stickers...), free
    --                  text such as "3 ft x 6 ft".
    --   surface_type : SURFACE_TYPES, for SURFACE_CATEGORIES; surface_other is
    --                  the write-in for 'Other'.
    --   jersey_job_id: the team roster (jersey_jobs) imported on a decoration
    --                  request, or NULL. Its players are copied into
    --                  job_request_roster at submit, so later roster edits don't
    --                  change a running job. roster_name / jersey_style are
    --                  copied the same way ('' with no roster).
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
        garment_type   TEXT    NOT NULL DEFAULT '',
        garment_other  TEXT    NOT NULL DEFAULT '',
        blank_ref      TEXT    NOT NULL DEFAULT '',
        garment_color  TEXT    NOT NULL DEFAULT '',
        qty_mode       TEXT    NOT NULL DEFAULT '',
        item_size      TEXT    NOT NULL DEFAULT '',
        surface_type   TEXT    NOT NULL DEFAULT '',
        surface_other  TEXT    NOT NULL DEFAULT '',
        jersey_job_id  INTEGER,
        roster_name    TEXT    NOT NULL DEFAULT '',
        jersey_style   TEXT    NOT NULL DEFAULT '',
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_requests_status ON job_requests(status);

    -- One row per ticked design location on a decoration request.
    --   location  : one of DESIGN_LOCATIONS; other_text is the write-in for 'Other'.
    --   colors    : '1'..'15' (capped per method by DECORATION_COLOR_LIMITS),
    --               'not_sure', or '' when not asked (DTF is full color).
    --   name_number: roster names/numbers printed here: one of JERSEY_OPTIONS,
    --               or '' for an ordinary design.
    --   method    : '' = the request's own process, or 'dtf' / 'embroidery' for
    --               a name/number location done another way (Full Chest/Back
    --               names are always DTF; Front Pocket/Sleeve pick one).
    --   dtf_ack   : 1 when the requester acknowledged that names/numbers on
    --               Full Chest/Back are DTF transfers on a non-DTF job.
    CREATE TABLE IF NOT EXISTS job_request_locations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id  INTEGER NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        location    TEXT    NOT NULL,
        other_text  TEXT    NOT NULL DEFAULT '',
        colors      TEXT    NOT NULL DEFAULT '',
        name_number TEXT    NOT NULL DEFAULT '',
        method      TEXT    NOT NULL DEFAULT '',
        dtf_ack     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_job_request_locations_request ON job_request_locations(request_id);

    -- One row per garment color on a decoration request ("Add Another Color").
    --   qty: that color's total (entered in 'total' mode, the sum of its
    --        job_request_sizes rows in 'sizes' mode).
    CREATE TABLE IF NOT EXISTS job_request_colors (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        color      TEXT    NOT NULL,
        qty        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_request_colors_request ON job_request_colors(request_id);

    -- Qty by Size breakdown (qty_mode = 'sizes'), per job_request_colors row.
    -- Only sizes with qty > 0 are stored.
    CREATE TABLE IF NOT EXISTS job_request_sizes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL,
        color_id   INTEGER,
        size       TEXT    NOT NULL,
        qty        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_request_sizes_request ON job_request_sizes(request_id);

    -- The roster's players, copied from jersey_players when a team request is
    -- submitted (see job_requests.jersey_job_id).
    CREATE TABLE IF NOT EXISTS job_request_roster (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name       TEXT    NOT NULL,
        number     TEXT    NOT NULL DEFAULT '',
        size       TEXT    NOT NULL DEFAULT '',
        color      TEXT    NOT NULL DEFAULT '',
        info       TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_job_request_roster_request ON job_request_roster(request_id);

    -- Job packets: the JSON file ClassicalKenKen imports as a live Work Event
    -- (routes/packets.js, server/jobPacket.js). One per job request, or a house
    -- job with no request behind it (request_id NULL).
    --   job_number : CGL-<yy>-<seq>, assigned on first save and never changed —
    --                ClassicalKenKen updates the existing job when it sees the
    --                same number again. yy is the school year's starting year
    --                (flips July 1, ET); seq restarts at 1 each school year.
    --   data       : the packet body (everything but job_number), as JSON. The
    --                lab's edits, including corrections to the requester's
    --                answers, live here; nested lists (quantities, placements,
    --                skills) make a JSON column simpler than child tables.
    CREATE TABLE IF NOT EXISTS job_packets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id  INTEGER UNIQUE,
        job_number  TEXT    NOT NULL UNIQUE,
        school_year INTEGER NOT NULL,
        seq         INTEGER NOT NULL,
        data        TEXT    NOT NULL DEFAULT '{}',
        created_by  TEXT    NOT NULL DEFAULT '',
        updated_by  TEXT    NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE(school_year, seq)
    );

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
    --   payment_method: storefront tender, for reconciling the cash drawer:
    --                  'cash' or 'online' (Venmo/CashApp scanned at the
    --                  register — which app isn't tracked, just that it wasn't
    --                  cash in the drawer). Staff pick it at time of sale (see
    --                  routes/inventory.js). Only meaningful for
    --                  source='storefront_sale' — '' (not applicable) for
    --                  online_order/adjustment rows, which move through Stripe,
    --                  a completely separate rail already identified by
    --                  vendor/source and out of scope for this reconciliation.
    --   location: physical point of sale for a counter sale — 'storefront' or
    --                  'cart' (a mobile sales cart taken to games/events).
    --                  Staff pick it at time of sale, same as payment_method.
    --                  Only meaningful for source='storefront_sale' — '' (not
    --                  applicable) for online_order/adjustment rows.
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
        payment_method     TEXT    NOT NULL DEFAULT '',
        location           TEXT    NOT NULL DEFAULT '',
        ref_stock_event_id INTEGER,
        ref_order_id       INTEGER,
        actor_user_key     TEXT    NOT NULL DEFAULT '',
        created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_posted  ON transactions(posted_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account);

    -- Home games mirrored from the CIAC athletics calendar feed
    -- (server/athletics.js). Keyed by the feed's UID, which stays stable when a
    -- game is rescheduled. Rows are never deleted: a future game that drops out
    -- of the feed or is marked "Canceled" gets removed_at stamped instead, so
    -- shift signups on that evening can be flagged rather than orphaned.
    --   on_campus: 1 when LOCATION is Classical Magnet itself; only those games
    --              create an evening shift (soccer "home" games are off-site).
    CREATE TABLE IF NOT EXISTS athletic_events (
        uid          TEXT    PRIMARY KEY,
        starts_at    INTEGER NOT NULL,
        ends_at      INTEGER NOT NULL,
        summary      TEXT    NOT NULL DEFAULT '',
        location     TEXT    NOT NULL DEFAULT '',
        description  TEXT    NOT NULL DEFAULT '',
        on_campus    INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL,
        removed_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_athletic_events_start ON athletic_events(starts_at);

    -- Student staff sign-ups for a shift. Shifts themselves aren't stored: they
    -- are computed per day from the rules in server/shifts.js (plus game evenings
    -- from athletic_events), so a signup is just (ET date, shift key, person).
    --   created_by: user_key of whoever made the row — the student themselves,
    --               or an admin assigning them.
    CREATE TABLE IF NOT EXISTS shift_signups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_date TEXT    NOT NULL,
        shift_key  TEXT    NOT NULL,
        email      TEXT    NOT NULL,
        created_by TEXT    NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(shift_date, shift_key, email)
    );
    CREATE INDEX IF NOT EXISTS idx_shift_signups_date  ON shift_signups(shift_date);
    CREATE INDEX IF NOT EXISTS idx_shift_signups_email ON shift_signups(email);

    -- No-school days (holidays, breaks, PD days) marked by an admin. Regular
    -- weekday shifts are hidden on these dates; game evenings still show.
    CREATE TABLE IF NOT EXISTS schedule_closures (
        date TEXT PRIMARY KEY,
        note TEXT NOT NULL DEFAULT ''
    );

    -- Small key/value store for app bookkeeping that must survive restarts
    -- (e.g. the athletics feed's last sync time / error).
    CREATE TABLE IF NOT EXISTS app_state (
        key        TEXT    PRIMARY KEY,
        value      TEXT    NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
    );
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
// Only the v6 migration below uses this single name; that back-fill already
// ran, so it stays exactly as it was. Live code uses TAX_EXEMPT_SUBCATEGORIES.
const TAX_EXEMPT_SUBCATEGORY = 'supplies';

// Sub-categories whose items carry no CT sales tax: "Supplies", and "Tickets"
// (school event admissions, e.g. HoCo). Lower-case, compared trimmed.
const TAX_EXEMPT_SUBCATEGORIES = ['supplies', 'tickets'];
// The same list as a SQL `IN (...)` body, for queries that classify rows.
const TAX_EXEMPT_SQL_LIST = TAX_EXEMPT_SUBCATEGORIES.map((n) => `'${n}'`).join(', ');

// True when an item is tax-exempt because of its sub-category name. Pass the
// sub-category NAME (ITEM_SELECT exposes it as `subcategory`); match is
// case/space-insensitive so "Supplies", " supplies " etc. all count.
function isSubcategoryTaxExempt(subcategoryName) {
    return TAX_EXEMPT_SUBCATEGORIES.includes(String(subcategoryName ?? '').trim().toLowerCase());
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

// Apparel decoration fields on the job request form. These labels are also the
// values ClassicalKenKen's job packet import recognizes, so keep them exact.
const DECORATION_CATEGORIES = ['Screen Printing', 'Embroidery', 'DTF Transfer (Full Color)'];
const DESIGN_LOCATIONS = ['Full Chest', 'Full Back', 'Front Pocket', 'Sleeve', 'Other'];
const GARMENT_TYPES = ['Tee-Shirt', 'Long Sleeve Tee', 'Crew Neck', 'Pull Over', 'Full Zip', 'Polo', 'Other'];
const APPAREL_SIZES = ['YS', 'YM', 'YL', 'YXL', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];
// Max colors per design location: the screen presses are 4-color. DTF is full
// color, so it isn't asked.
const DECORATION_COLOR_LIMITS = { 'Screen Printing': 4, 'Embroidery': 15 };
// Print/cut jobs that need a finished size, and the ones that also ask what
// surface the graphic goes on.
const SIZED_CATEGORIES = ['Banner', 'Stickers, Decals & Signs'];
const SURFACE_CATEGORIES = ['Stickers, Decals & Signs'];
const SURFACE_TYPES = ['Wall', 'Window', 'Floor', 'Vehicle', 'Sign', 'Other', 'Not sure yet'];
// Team rosters: what a "Use for Name/Number" location prints. Names/numbers
// on the chest or back are always DTF transfers; on a pocket or sleeve the
// requester picks DTF or embroidery (embroidery takes up to 15 thread colors).
const JERSEY_OPTIONS = { name_number: 'Name & Number', name: 'Name Only', number: 'Number Only' };
const NAME_NUMBER_DTF_ONLY = ['Full Chest', 'Full Back'];
const NAME_NUMBER_METHOD_CHOICE = ['Front Pocket', 'Sleeve'];

function normalizeCategory(value) {
    return ITEM_CATEGORIES.includes(value) ? value : DEFAULT_CATEGORY;
}

// --- Schema migrations -------------------------------------------------------
// Bump SCHEMA_VERSION and add a matching `if (fromVersion < N)` block for each
// change. PRAGMA user_version persists in the DB file, so each block runs once.
const SCHEMA_VERSION = 11;
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

if (fromVersion < 7) {
    // Reconciliation: mark each transaction 'cash' or 'online' so the storefront
    // cash drawer can be reconciled separately from card/online money. App-
    // enforced (no CHECK), same reasoning as orders.payment_status above.
    if (!tableHasColumn('transactions', 'payment_method')) {
        db.exec("ALTER TABLE transactions ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'");
    }
    // Online-store rows were always paid online; the column default ('cash')
    // is correct for pre-existing storefront_sale rows, which predate this
    // feature and were rung up at the register.
    db.exec("UPDATE transactions SET payment_method = 'online' WHERE source = 'online_order'");
}

if (fromVersion < 8) {
    // Correction: storefront "online" tender (Venmo/CashApp at the register) is
    // a fully separate thing from the Stripe-powered online store — the v7
    // migration above wrongly stamped Stripe order rows 'online' too. Clear
    // payment_method back to '' (not applicable) on anything that isn't a
    // counter sale; only storefront_sale rows carry a real cash/online value.
    db.exec("UPDATE transactions SET payment_method = '' WHERE source != 'storefront_sale'");
}

// Guarded by column presence, not just fromVersion < 9: two processes racing
// this migration against the same DB file can leave user_version bumped to 9
// on one connection while another's ADD COLUMN never lands (observed during
// development). ADD COLUMN is additive/idempotent, so it's safe to re-check
// on every boot regardless of the stored version.
if (!tableHasColumn('transactions', 'location')) {
    // Location (Storefront / Cart): where a counter sale physically happened,
    // tracked alongside payment_method for register reconciliation. Every
    // existing storefront_sale row predates the mobile Cart, so it was rung up
    // at the storefront.
    db.exec("ALTER TABLE transactions ADD COLUMN location TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE transactions SET location = 'storefront' WHERE source = 'storefront_sale'");
}

// v10: staff roles. Column-guarded like v9. Every existing whitelist entry
// keeps full access (role 'admin'); student staff are demoted explicitly from
// /admin/staff/ or server/manage-staff.js.
if (!tableHasColumn('staff_whitelist', 'role')) {
    db.exec("ALTER TABLE staff_whitelist ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','student'))");
}
if (!tableHasColumn('staff_whitelist', 'display_name')) {
    db.exec("ALTER TABLE staff_whitelist ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
}

// v11: apparel decoration and print/cut size fields on job requests.
// Column-guarded like v9. The child tables and job_packets come from CREATE
// TABLE IF NOT EXISTS above. Existing requests keep '' everywhere and render
// as before.
for (const col of ['garment_type', 'garment_other', 'blank_ref', 'garment_color', 'qty_mode',
    'item_size', 'surface_type', 'surface_other', 'roster_name', 'jersey_style']) {
    if (!tableHasColumn('job_requests', col)) {
        db.exec(`ALTER TABLE job_requests ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
}
if (!tableHasColumn('job_requests', 'jersey_job_id')) {
    db.exec('ALTER TABLE job_requests ADD COLUMN jersey_job_id INTEGER');
}
if (!tableHasColumn('job_request_sizes', 'color_id')) {
    db.exec('ALTER TABLE job_request_sizes ADD COLUMN color_id INTEGER');
}
for (const [col, type] of [['name_number', "TEXT NOT NULL DEFAULT ''"], ['method', "TEXT NOT NULL DEFAULT ''"], ['dtf_ack', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!tableHasColumn('job_request_locations', col)) {
        db.exec(`ALTER TABLE job_request_locations ADD COLUMN ${col} ${type}`);
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

const STAFF_ROLES = ['admin', 'student'];

// The account's staff role ('admin' | 'student'), or null when it isn't on the
// whitelist at all. Case-insensitive, since emails added by hand from the
// /admin/staff/ page may not match the casing Google reports.
function getStaffRole(email) {
    const row = db.prepare('SELECT role FROM staff_whitelist WHERE email = ? COLLATE NOCASE')
        .get(String(email || '').trim());
    return row ? row.role : null;
}

function isStaff(email) {
    return getStaffRole(email) !== null;
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
    source, paymentMethod = '', location = '', refStockEventId = null, refOrderId = null, actorUserKey = '',
}) {
    const info = db.prepare(`
        INSERT INTO transactions
            (posted_at, type, vendor, amount_cents, tax_cents, account, notes, source, payment_method, location, ref_stock_event_id, ref_order_id, actor_user_key, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(postedAt, type, vendor, Math.round(amountCents), Math.round(taxCents), account, notes, source, paymentMethod, location, refStockEventId, refOrderId, actorUserKey, Date.now());
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

// A job request's apparel decoration child rows: design locations, one entry
// per garment color as { color, qty, sizes: [{ size, qty }] } (sizes is empty
// in 'total' mode), and the copied roster players. All empty for other
// categories and older requests.
function getRequestDecoration(requestId) {
    const sizes = db.prepare('SELECT color_id, size, qty FROM job_request_sizes WHERE request_id = ? ORDER BY id').all(requestId);
    const colors = db.prepare('SELECT id, color, qty FROM job_request_colors WHERE request_id = ? ORDER BY sort_order, id').all(requestId)
        .map((c) => ({
            color: c.color,
            qty: c.qty,
            sizes: sizes.filter((s) => s.color_id === c.id).map(({ size, qty }) => ({ size, qty })),
        }));
    return {
        locations: db.prepare(`
            SELECT location, other_text, colors, name_number, method, dtf_ack
            FROM job_request_locations WHERE request_id = ? ORDER BY sort_order, id
        `).all(requestId),
        colors,
        roster: db.prepare('SELECT name, number, size, color, info FROM job_request_roster WHERE request_id = ? ORDER BY sort_order, id').all(requestId),
    };
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
    db, upsertUser, isStaff, getStaffRole, STAFF_ROLES, isSigninAllowed,
    applyStockDelta, recordTransaction, randomUUID,
    ITEM_CATEGORIES, DEFAULT_CATEGORY, normalizeCategory, normalizeHex,
    CT_TAX_RATE, splitTaxInclusive, isSubcategoryTaxExempt, TAX_EXEMPT_SQL_LIST,
    JOB_CATEGORIES, JERSEY_SIZES,
    DECORATION_CATEGORIES, DESIGN_LOCATIONS, GARMENT_TYPES, APPAREL_SIZES, DECORATION_COLOR_LIMITS,
    SIZED_CATEGORIES, SURFACE_CATEGORIES, SURFACE_TYPES,
    JERSEY_OPTIONS, NAME_NUMBER_DTF_ONLY, NAME_NUMBER_METHOD_CHOICE,
    ITEM_SELECT, getItem, getRequestDecoration, sweepStaleUnpaidOrders,
};
