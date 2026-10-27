// Shift rules for the student staff schedule (/admin/schedule/). Shifts aren't
// stored — they're computed per day from these rules, so editing a time or
// capacity here applies everywhere (existing signups key on shift_key + date).
//
//   Regular shifts: school weekdays only (Mon–Fri, minus schedule_closures).
//   Game evening:   any day — weekends included — with an on-campus home game
//                   in athletic_events. Window runs from GAME_LEAD_MIN before
//                   the first game starts to GAME_TAIL_MIN after the last ends.
const { db } = require('./db');
const { etWallToUtc, etDate } = require('./etDate');

const REGULAR_SHIFTS = [
    { key: 'storefront_am', location: 'Storefront', label: 'Morning',   start: [7, 0],   end: [7, 30],  capacity: 3 },
    { key: 'storefront_pm', location: 'Storefront', label: 'Afternoon', start: [14, 5],  end: [14, 30], capacity: 3 },
    { key: 'cart_pm',       location: 'Cart',       label: 'Afternoon', start: [14, 5],  end: [14, 30], capacity: 2 },
];

const GAME_SHIFT = { key: 'game_evening', location: 'Game', label: 'Evening', capacity: 3 };
const GAME_LEAD_MIN = 30;
const GAME_TAIL_MIN = 15;

const SHIFT_KEYS = [...REGULAR_SHIFTS.map((s) => s.key), GAME_SHIFT.key];

// Longest range one request may compute (a month view plus its leading and
// trailing partial weeks fits comfortably).
const MAX_RANGE_DAYS = 62;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value) {
    if (!DATE_RE.test(value || '')) return false;
    const [y, m, d] = value.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Inclusive list of YYYY-MM-DD strings from `from` to `to`.
function datesBetween(from, to) {
    const out = [];
    const [y, m, d] = from.split('-').map(Number);
    for (let t = Date.UTC(y, m - 1, d); ; t += 86400000) {
        const iso = new Date(t).toISOString().slice(0, 10);
        if (iso > to) break;
        out.push(iso);
    }
    return out;
}

function isWeekday(date) {
    const [y, m, d] = date.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return dow >= 1 && dow <= 5;
}

function wallTime(date, [h, mi]) {
    const [y, m, d] = date.split('-').map(Number);
    return etWallToUtc(y, m, d, h, mi, 0, 0);
}

// Live on-campus games, bucketed by ET date. Pads the query a day each side
// since ET dates and UTC instants don't line up at midnight.
function gamesByDate(from, to) {
    const lo = wallTime(from, [0, 0]) - 86400000;
    const hi = wallTime(to, [0, 0]) + 2 * 86400000;
    const rows = db.prepare(`
        SELECT uid, starts_at, ends_at, summary, location, description FROM athletic_events
        WHERE on_campus = 1 AND removed_at IS NULL AND starts_at >= ? AND starts_at < ?
        ORDER BY starts_at
    `).all(lo, hi);
    const byDate = new Map();
    for (const r of rows) {
        const date = etDate(r.starts_at);
        if (date < from || date > to) continue;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push({
            uid: r.uid, startsAt: r.starts_at, endsAt: r.ends_at,
            summary: r.summary, location: r.location, description: r.description,
        });
    }
    return byDate;
}

function closuresBetween(from, to) {
    return db.prepare('SELECT date, note FROM schedule_closures WHERE date >= ? AND date <= ? ORDER BY date')
        .all(from, to);
}

// Every shift on the calendar from `from` to `to` (inclusive YYYY-MM-DD, ET),
// in date then start-time order. Each shift: { date, key, location, label,
// startsAt, endsAt, capacity, games? }.
function shiftsBetween(from, to) {
    const closed = new Set(closuresBetween(from, to).map((c) => c.date));
    const games = gamesByDate(from, to);
    const shifts = [];
    for (const date of datesBetween(from, to)) {
        if (isWeekday(date) && !closed.has(date)) {
            for (const s of REGULAR_SHIFTS) {
                shifts.push({
                    date, key: s.key, location: s.location, label: s.label, capacity: s.capacity,
                    startsAt: wallTime(date, s.start), endsAt: wallTime(date, s.end),
                });
            }
        }
        const dayGames = games.get(date);
        if (dayGames) {
            shifts.push({
                date, key: GAME_SHIFT.key, location: GAME_SHIFT.location, label: GAME_SHIFT.label,
                capacity: GAME_SHIFT.capacity,
                startsAt: Math.min(...dayGames.map((g) => g.startsAt)) - GAME_LEAD_MIN * 60000,
                endsAt: Math.max(...dayGames.map((g) => g.endsAt)) + GAME_TAIL_MIN * 60000,
                games: dayGames,
            });
        }
    }
    return shifts.sort((a, b) => (a.date === b.date ? a.startsAt - b.startsAt : a.date < b.date ? -1 : 1));
}

// The one shift for (date, key), or null when there isn't one that day (no
// school, a weekend, or the game was cancelled/moved).
function findShift(date, key) {
    if (!isValidDate(date) || !SHIFT_KEYS.includes(key)) return null;
    return shiftsBetween(date, date).find((s) => s.key === key) || null;
}

module.exports = {
    REGULAR_SHIFTS, GAME_SHIFT, SHIFT_KEYS, MAX_RANGE_DAYS,
    isValidDate, datesBetween, shiftsBetween, closuresBetween, findShift,
};
