// Seeds the fixed Uniforms catalog rows on boot. Idempotent (INSERT OR
// IGNORE keyed on a stable, human-readable id) so re-running never
// duplicates rows or clobbers stock levels staff have since adjusted.
const { db } = require('./db');

const COLORS = ['White', 'Black'];
const SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];

const PRODUCTS = [
    {
        slug: 'embroidery-only',
        name: 'Embroidery Only (Polo Provided)',
        priceCents: 0,
        detail: "You provide the polo and we'll embroider the school logo for free! Just drop off your polo at the school store in the morning between 7:00-7:30 and we will bring it to your advisor when we're done.",
        sized: false,
    },
    {
        slug: 'transfer-only',
        name: 'Transfer Only (Tee-Shirt Provided)',
        priceCents: 0,
        detail: "You provide the tee and we apply our logo for free! Just drop off your tee at the school store in the morning between 7:00-7:30 and we will bring it to your advisor when we're done.",
        sized: false,
    },
    {
        slug: 'polo-embroidery',
        name: 'Polo + Embroidery',
        priceCents: 1500,
        detail: 'We buy you the polo at our bulk rate and embroider it for free (52/48 Cotton/Poly mix Gildan G880 Black/White Polo).',
        sized: true,
    },
    {
        slug: 'tee-transfer',
        name: 'Tee-Shirt + Transfer',
        priceCents: 500,
        detail: 'We buy you the tee-shirt at our bulk rate and apply our logo to it for free (100% Cotton Gildan G500 Black/White Tee).',
        sized: true,
    },
];

function seedUniforms() {
    const insert = db.prepare(`
        INSERT OR IGNORE INTO items(uuid, name, category, variant_color, variant_size, price_cents, detail, stock_qty, active, created_at)
        VALUES(?, ?, 'GFX', ?, ?, ?, ?, 0, 1, ?)
    `);
    const now = Date.now();

    for (const product of PRODUCTS) {
        for (const color of COLORS) {
            if (!product.sized) {
                const uuid = `uniform-${product.slug}-${color.toLowerCase()}`;
                insert.run(uuid, product.name, color, null, product.priceCents, product.detail, now);
                continue;
            }
            for (const size of SIZES) {
                const uuid = `uniform-${product.slug}-${color.toLowerCase()}-${size.toLowerCase()}`;
                insert.run(uuid, product.name, color, size, product.priceCents, product.detail, now);
            }
        }
    }
}

// Tradition Line pre-order, restored from the pre-overhaul quick-order form
// (git history prior to the SQLite migration). That form had a "Style" +
// "Print Finish" pair driving price, which today's schema doesn't model as
// its own dimension — so each style/finish combination becomes its own
// catalog item, the same way "Polo + Embroidery" vs "Tee-Shirt + Transfer"
// are separate items above.
const TRADITION_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL'];

const TRADITION_STYLES = [
    { slug: 'hoodie', name: 'Tradition Line Hoodie', colors: ['Asphalt', 'Blush', 'Bone', 'Arctic'] },
    { slug: 'crew', name: 'Tradition Line Crew', colors: ['Black', 'Blush', 'Bone', 'Arctic'] },
];

const TRADITION_FINISHES = [
    { slug: 'raised-print', label: 'Raised Print', priceCents: 4000 },
    { slug: 'embossed-embroidery', label: 'Embossed Embroidery', priceCents: 6000 },
];

function seedTraditionLine() {
    const insert = db.prepare(`
        INSERT OR IGNORE INTO items(uuid, name, category, variant_color, variant_size, price_cents, detail, stock_qty, active, created_at)
        VALUES(?, ?, 'GFX', ?, ?, ?, ?, 0, 1, ?)
    `);
    const now = Date.now();

    for (const style of TRADITION_STYLES) {
        for (const finish of TRADITION_FINISHES) {
            const name = `${style.name} — ${finish.label}`;
            const detail = `Tradition Line pre-order: ${style.name} with ${finish.label} school logo.`;
            for (const color of style.colors) {
                for (const size of TRADITION_SIZES) {
                    const uuid = `tradition-${style.slug}-${finish.slug}-${color.toLowerCase()}-${size.toLowerCase()}`;
                    insert.run(uuid, name, color, size, finish.priceCents, detail, now);
                }
            }
        }
    }
}

// Initial staff whitelist, re-seeded on every boot so these core accounts
// can't be locked out by an accidental removal. Use server/manage-staff.js
// to add/remove anyone else (including students) against the live DB
// without a redeploy — additions made that way persist normally; removing
// one of the names below will not stick across a restart.
const INITIAL_STAFF = [
    'dobbb001@hartfordschools.org',
    'lestl001@hartfordschools.org',
    'leonr001@hartfordschools.org',
];

function seedStaff() {
    const insert = db.prepare('INSERT OR IGNORE INTO staff_whitelist(email) VALUES(?)');
    for (const email of INITIAL_STAFF) insert.run(email);
}

module.exports = { seedUniforms, seedTraditionLine, seedStaff };
