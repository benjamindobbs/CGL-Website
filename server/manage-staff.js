// CLI for managing server/db.js's staff_whitelist against whatever DB
// DB_PATH points at (defaults to the production path when run inside the
// Fly machine, since fly.toml sets DB_PATH as a machine env var). See the
// "Managing the staff whitelist" note in fly.toml for the full command.
//
// Usage:
//   node server/manage-staff.js add <email>
//   node server/manage-staff.js remove <email>
//   node server/manage-staff.js list
const { db } = require('./db');

const [, , command, email] = process.argv;

switch (command) {
    case 'add':
        if (!email) throw new Error('Usage: node server/manage-staff.js add <email>');
        db.prepare('INSERT OR IGNORE INTO staff_whitelist(email) VALUES(?)').run(email);
        console.log(`Added: ${email}`);
        break;
    case 'remove':
        if (!email) throw new Error('Usage: node server/manage-staff.js remove <email>');
        db.prepare('DELETE FROM staff_whitelist WHERE email = ?').run(email);
        console.log(`Removed: ${email}`);
        break;
    case 'list':
        for (const row of db.prepare('SELECT email FROM staff_whitelist ORDER BY email').all()) {
            console.log(row.email);
        }
        break;
    default:
        console.log('Usage: node server/manage-staff.js <add|remove|list> [email]');
        process.exit(1);
}
