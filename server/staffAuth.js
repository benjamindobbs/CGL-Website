const { requireAuth } = require('./auth');
const { isStaff } = require('./db');

function requireStaff(req, res, next) {
    requireAuth(req, res, (err) => {
        if (err) return next(err);
        if (!isStaff(req.userEmail)) return res.status(403).json({ error: 'Not authorized for staff tools' });
        next();
    });
}

module.exports = { requireStaff };
