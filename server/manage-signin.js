// CLI for server/db.js's signin_allowlist: individual out-of-district email
// addresses allowed to sign in, on top of the ALLOWED_DOMAINS gate in
// server/auth.js. Runs against whatever DB DB_PATH points at (the production
// path when run inside the Fly machine, since fly.toml sets DB_PATH there).
//
// These accounts can sign in, place orders, and use the district self-service
// tools (/request/, /jerseys/) like a hartfordschools.org staff account. They
// get no admin access unless also added with server/manage-staff.js.
//
// Usage:
//   node server/manage-signin.js add <email> [note...]
//   node server/manage-signin.js remove <email>
//   node server/manage-signin.js list
const { db } = require('./db');

const [, , command, rawEmail, ...noteParts] = process.argv;
const email = (rawEmail || '').trim().toLowerCase();
const note = noteParts.join(' ');

switch (command) {
    case 'add':
        if (!email) throw new Error('Usage: node server/manage-signin.js add <email> [note]');
        db.prepare(`
            INSERT INTO signin_allowlist(email, note, created_at) VALUES(?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET note = excluded.note
        `).run(email, note, Date.now());
        console.log(`Allowed: ${email}${note ? ` (${note})` : ''}`);
        break;
    case 'remove':
        if (!email) throw new Error('Usage: node server/manage-signin.js remove <email>');
        db.prepare('DELETE FROM signin_allowlist WHERE email = ?').run(email);
        console.log(`Removed: ${email}`);
        break;
    case 'list': {
        const rows = db.prepare('SELECT email, note FROM signin_allowlist ORDER BY email').all();
        if (!rows.length) { console.log('(none)'); break; }
        for (const r of rows) console.log(`${r.email}${r.note ? `  — ${r.note}` : ''}`);
        break;
    }
    default:
        console.log('Usage: node server/manage-signin.js <add|remove|list> [email] [note]');
        process.exit(1);
}
