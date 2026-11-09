const { requireAuth } = require('./auth');
const { getStaffRole } = require('./db');
const { isCoreAccount } = require('./seed');

// Any whitelisted staff account, admin or student staff. Sets req.staffRole so
// a handler can narrow further (e.g. the schedule lets admins act for others).
function requireStaff(req, res, next) {
    requireAuth(req, res, (err) => {
        if (err) return next(err);
        const role = getStaffRole(req.userEmail);
        if (!role) return res.status(403).json({ error: 'Not authorized for staff tools' });
        req.staffRole = role;
        next();
    });
}

// Full-access staff only. Student staff are kept out of the money side of the
// store (restock, storefront sales, transactions, income reports) and out of
// every write on the catalog, orders and job requests. Safe to stack after a
// router-level requireStaff: it reuses req.staffRole instead of re-authing.
function requireAdmin(req, res, next) {
    const check = () => {
        if (req.staffRole !== 'admin') return res.status(403).json({ error: 'This action needs an admin staff account' });
        next();
    };
    if (req.staffRole) return check();
    requireStaff(req, res, (err) => (err ? next(err) : check()));
}

// Core lab accounts only (server/seed.js INITIAL_STAFF) — a step above admin.
// Core accounts are always re-seeded as admins, so this stacks on requireAdmin.
function requireCore(req, res, next) {
    requireAdmin(req, res, (err) => {
        if (err) return next(err);
        if (!isCoreAccount(req.userEmail)) {
            return res.status(403).json({ error: 'Only the core lab accounts can do this' });
        }
        next();
    });
}

module.exports = { requireStaff, requireAdmin, requireCore };
