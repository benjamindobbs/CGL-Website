const express = require('express');
const path    = require('path');

const { seedUniforms, seedTraditionLine, seedStaff, seedSubcategories } = require('./seed');
seedUniforms();
seedTraditionLine();
seedSubcategories();
seedStaff();

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.use('/api/auth',          require('./routes/auth'));
app.use('/api/items',         require('./routes/items'));
app.use('/api/subcategories', require('./routes/subcategories'));
app.use('/api/inventory',     require('./routes/inventory'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/reports',       require('./routes/reports'));

app.use(express.static(path.join(__dirname, '..')));

app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
