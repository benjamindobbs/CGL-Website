const { Router } = require('express');
const { db, upsertUser, isStaff } = require('../db');
const { randomUUID } = require('crypto');
const { resolveIdentity, isDistrictUser } = require('../auth');

const router = Router();

router.post('/login', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    try {
        const r = await fetch(
            `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(token)}`
        );
        if (!r.ok) return res.status(403).json({ error: 'Invalid token' });
        const data = await r.json();
        if (!data.email || data.error) return res.status(403).json({ error: 'Invalid token' });
        const identity = resolveIdentity(data.email);
        if (!identity) return res.status(403).json({ error: 'This account is not authorized to sign in.' });
        upsertUser(identity.userKey, identity.email);
        const sessionToken = randomUUID();
        db.prepare('INSERT INTO sessions(token, user_key, created_at, last_seen) VALUES(?, ?, ?, ?)')
          .run(sessionToken, identity.userKey, Date.now(), Date.now());
        res.json({ sessionToken, isStaff: isStaff(identity.email), isDistrict: isDistrictUser(identity.email) });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/me', (req, res) => {
    if (process.env.DEV_USER) {
        const email = `${process.env.DEV_USER}@hartfordschools.org`;
        return res.json({ userKey: process.env.DEV_USER, email, isStaff: isStaff(email), isDistrict: isDistrictUser(email) });
    }
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const session = db.prepare(
        'SELECT s.user_key, u.email FROM sessions s JOIN users u ON u.user_key = s.user_key WHERE s.token = ?'
    ).get(token);
    if (!session) return res.status(401).json({ error: 'Invalid session' });
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
    res.json({ userKey: session.user_key, email: session.email, isStaff: isStaff(session.email), isDistrict: isDistrictUser(session.email) });
});

module.exports = router;
