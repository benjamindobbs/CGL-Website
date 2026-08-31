const express = require('express');
const path    = require('path');

const { seedUniforms, seedStaff } = require('./seed');
seedUniforms();
seedStaff();

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/items',     require('./routes/items'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/orders',    require('./routes/orders'));

app.use(express.static(path.join(__dirname, '..')));

app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
