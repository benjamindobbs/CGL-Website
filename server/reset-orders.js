// One-off cleanup: delete every order and everything derived from it — order
// items, the order's stock-ledger movements (stock_events with a ref_order_id),
// and its financial-ledger rows (transactions with source 'online_order') — then
// re-derive stock_qty for the affected items from the ledger rows that remain
// (restocks and counter sales are untouched), and reset the id counters so the
// next real order is #1.
//
// Intended for wiping Stripe test orders before going live.
//
//   node server/reset-orders.js          # dry run — prints what would be removed
//   node server/reset-orders.js --yes    # actually delete
//
// On the live Fly machine (see fly.toml):
//   fly ssh console -a cgl-website -C "node server/reset-orders.js"
//   fly ssh console -a cgl-website -C "node server/reset-orders.js --yes"
const { db } = require('./db');

const confirmed = process.argv.includes('--yes');

const counts = {
    orders:       db.prepare('SELECT COUNT(*) n FROM orders').get().n,
    orderItems:   db.prepare('SELECT COUNT(*) n FROM order_items').get().n,
    stockEvents:  db.prepare('SELECT COUNT(*) n FROM stock_events WHERE ref_order_id IS NOT NULL').get().n,
    transactions: db.prepare("SELECT COUNT(*) n FROM transactions WHERE source = 'online_order'").get().n,
};

console.log('Order data currently in the database:');
console.log(`  orders                       ${counts.orders}`);
console.log(`  order_items                  ${counts.orderItems}`);
console.log(`  stock_events (from orders)   ${counts.stockEvents}`);
console.log(`  transactions (online_order)  ${counts.transactions}`);

if (counts.orders === 0 && counts.stockEvents === 0 && counts.transactions === 0) {
    console.log('\nNothing to do.');
    process.exit(0);
}

if (!confirmed) {
    console.log('\nDry run. Re-run with --yes to delete all of the above and');
    console.log('re-derive stock levels for the affected items.');
    process.exit(0);
}

const affected = db
    .prepare('SELECT DISTINCT item_uuid FROM stock_events WHERE ref_order_id IS NOT NULL')
    .all()
    .map((r) => r.item_uuid);

db.exec('BEGIN');
try {
    db.prepare('DELETE FROM stock_events WHERE ref_order_id IS NOT NULL').run();
    db.prepare("DELETE FROM transactions WHERE source = 'online_order'").run();
    db.prepare('DELETE FROM order_items').run();
    db.prepare('DELETE FROM orders').run();

    // stock_qty is a running total of stock_events — rebuild it for every item an
    // order had touched, from the (restock / counter-sale) rows left behind.
    const recompute = db.prepare(
        'UPDATE items SET stock_qty = (SELECT COALESCE(SUM(delta), 0) FROM stock_events WHERE item_uuid = ?) WHERE uuid = ?'
    );
    for (const uuid of affected) recompute.run(uuid, uuid);

    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('orders', 'order_items')").run();

    db.exec('COMMIT');
} catch (err) {
    db.exec('ROLLBACK');
    console.error('\nFailed — rolled back, nothing changed:', err);
    process.exit(1);
}

console.log(`\nDone. Removed ${counts.orders} order(s) and re-derived stock for ${affected.length} item(s).`);
