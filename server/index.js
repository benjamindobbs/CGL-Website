const express = require('express');
const path    = require('path');

const { seedUniforms, seedTraditionLine, seedStaff, seedSubcategories } = require('./seed');
const { sweepStaleUnpaidOrders } = require('./db');
seedUniforms();
seedTraditionLine();
seedSubcategories();
seedStaff();

const app  = express();
const PORT = process.env.PORT || 8080;

// Stripe webhook must see the raw request body to verify its signature, so its
// router is mounted (with its own express.raw parser) before the app-wide JSON
// body parser below.
app.use('/api/payments',      require('./routes/payments'));

app.use(express.json());

app.use('/api/auth',          require('./routes/auth'));
app.use('/api/items',         require('./routes/items'));
app.use('/api/subcategories', require('./routes/subcategories'));
app.use('/api/inventory',     require('./routes/inventory'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/transactions',  require('./routes/transactions'));
app.use('/api/reports',       require('./routes/reports'));

app.use(express.static(path.join(__dirname, '..')));

app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Cancel orders whose shopper never finished Stripe Checkout: once at boot, then
// hourly. A late-arriving payment webhook still settles the order regardless.
sweepStaleUnpaidOrders();
setInterval(sweepStaleUnpaidOrders, 60 * 60 * 1000).unref();

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
