const { db, upsertUser, isSigninAllowed } = require('./db');

const ALLOWED_DOMAINS = ['hartfordschools.org', 'students.hartfordschools.org'];

// Decides whether a Google-verified email may sign in, and what user_key it
// gets. Returns null to reject. District-domain accounts (ALLOWED_DOMAINS) key
// on the local part, as they always have. Individually allow-listed
// out-of-district addresses (signin_allowlist, via server/manage-signin.js) key
// on the FULL lower-cased email, so a local part like "jsmith" can never
// collide with a district "jsmith@hartfordschools.org".
function resolveIdentity(rawEmail) {
    const email = String(rawEmail || '').trim();
    const at = email.lastIndexOf('@');
    if (at < 1) return null;
    const domain = email.slice(at + 1).toLowerCase();
    if (ALLOWED_DOMAINS.includes(domain)) {
        return { userKey: email.slice(0, at), email };
    }
    if (isSigninAllowed(email)) {
        const lower = email.toLowerCase();
        return { userKey: lower, email: lower };
    }
    return null;
}

// Cache verified tokens: token → { userKey, email, exp }
const tokenCache = new Map();

async function verifyToken(token) {
    const cached = tokenCache.get(token);
    if (cached && cached.exp * 1000 > Date.now()) return cached;

    const res = await fetch(
        `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.email || data.error) return null;

    const identity = resolveIdentity(data.email);
    if (!identity) return null;

    const entry = { userKey: identity.userKey, email: identity.email, exp: data.expires_in
        ? Math.floor(Date.now() / 1000) + parseInt(data.expires_in)
        : Math.floor(Date.now() / 1000) + 3600
    };

    tokenCache.set(token, entry);
    if (tokenCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of tokenCache) {
            if (v.exp * 1000 <= now) tokenCache.delete(k);
        }
    }

    return entry;
}

async function requireAuth(req, res, next) {
    if (process.env.DEV_USER) {
        upsertUser(process.env.DEV_USER, `${process.env.DEV_USER}@hartfordschools.org`);
        req.userKey = process.env.DEV_USER;
        req.userEmail = `${process.env.DEV_USER}@hartfordschools.org`;
        return next();
    }

    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const session = db.prepare(
        'SELECT s.user_key, u.email FROM sessions s JOIN users u ON u.user_key = s.user_key WHERE s.token = ?'
    ).get(token);
    if (session) {
        db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
        req.userKey = session.user_key;
        req.userEmail = session.email;
        return next();
    }

    const identity = await verifyToken(token);
    if (!identity) return res.status(403).json({ error: 'Invalid or unauthorized token' });

    upsertUser(identity.userKey, identity.email);
    req.userKey = identity.userKey;
    req.userEmail = identity.email;
    next();
}

// May this account use the district self-service tools (job requests, jersey
// rosters)? Any @hartfordschools.org account, plus individually allow-listed
// out-of-district collaborators (signin_allowlist). Student accounts
// (@students.hartfordschools.org) are excluded. Distinct from isStaff(), which
// is the lab's own admin whitelist.
function isDistrictUser(email) {
    const e = String(email || '').toLowerCase();
    return e.endsWith('@hartfordschools.org') || isSigninAllowed(e);
}

// Gate for the district self-service tools. See isDistrictUser().
function requireDistrictStaff(req, res, next) {
    requireAuth(req, res, (err) => {
        if (err) return next(err);
        if (!isDistrictUser(req.userEmail)) {
            return res.status(403).json({ error: 'This tool is for school staff accounts (student accounts cannot use it).' });
        }
        next();
    });
}

module.exports = { requireAuth, requireDistrictStaff, resolveIdentity, isDistrictUser, ALLOWED_DOMAINS };
