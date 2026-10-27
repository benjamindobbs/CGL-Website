// CLI for managing server/db.js's staff_whitelist against whatever DB
// DB_PATH points at (defaults to the production path when run inside the
// Fly machine, since fly.toml sets DB_PATH as a machine env var). See the
// "Managing the staff whitelist" note in fly.toml for the full command.
// Day-to-day this is done from the /admin/staff/ page instead; the CLI is the
// fallback when no admin can sign in.
//
// Usage:
//   node server/manage-staff.js add <email> [admin|student]   (default: admin)
//   node server/manage-staff.js role <email> <admin|student>
//   node server/manage-staff.js remove <email>
//   node server/manage-staff.js list
const { db, STAFF_ROLES } = require('./db');

const [, , command, rawEmail, rawRole] = process.argv;
const email = String(rawEmail || '').trim().toLowerCase();

function parseRole(value, fallback) {
    const role = value || fallback;
    if (!STAFF_ROLES.includes(role)) throw new Error(`Role must be one of: ${STAFF_ROLES.join(', ')}`);
    return role;
}

switch (command) {
    case 'add': {
        if (!email) throw new Error('Usage: node server/manage-staff.js add <email> [admin|student]');
        const role = parseRole(rawRole, 'admin');
        db.prepare('INSERT OR IGNORE INTO staff_whitelist(email, role) VALUES(?, ?)').run(email, role);
        console.log(`Added: ${email} (${role})`);
        break;
    }
    case 'role': {
        if (!email || !rawRole) throw new Error('Usage: node server/manage-staff.js role <email> <admin|student>');
        const role = parseRole(rawRole);
        const info = db.prepare('UPDATE staff_whitelist SET role = ? WHERE email = ? COLLATE NOCASE').run(role, email);
        console.log(info.changes ? `${email} is now ${role}` : `Not on the whitelist: ${email}`);
        break;
    }
    case 'remove':
        if (!email) throw new Error('Usage: node server/manage-staff.js remove <email>');
        db.prepare('DELETE FROM staff_whitelist WHERE email = ? COLLATE NOCASE').run(email);
        console.log(`Removed: ${email}`);
        break;
    case 'list':
        for (const row of db.prepare('SELECT email, role, display_name FROM staff_whitelist ORDER BY role, email').all()) {
            console.log(`${row.email}\t${row.role}${row.display_name ? `\t${row.display_name}` : ''}`);
        }
        break;
    default:
        console.log('Usage: node server/manage-staff.js <add|role|remove|list> [email] [admin|student]');
        process.exit(1);
}
