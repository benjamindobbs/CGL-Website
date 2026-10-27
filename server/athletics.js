// Mirrors the CIAC athletics calendar (home games only) into athletic_events,
// which server/shifts.js turns into evening shifts on the schedule.
//
// The feed URL comes from the ATHLETICS_ICS_URL secret (it carries an Auth
// token). The "subscribe" link CIAC hands out is webcal:// — that's just https
// with a hint for calendar apps, so it's rewritten here. Without the secret the
// schedule still works, just with no game evenings.
//
// Fly stops this machine when idle, so a timer alone can't keep the mirror
// fresh. Syncs run at boot, every SYNC_INTERVAL_MS while the machine is up, on
// a schedule page load when the last sync is stale (maybeSyncAthletics), and
// on demand from an admin's "Sync now".
const { db } = require('./db');
const { etWallToUtc } = require('./etDate');

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
// After a failed attempt, page loads don't retry for this long (so a dead feed
// doesn't add a timeout to every schedule load).
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const STATE_KEY = 'athletics_sync';

// Games physically at the school. The feed's home games also include off-site
// "home" venues (e.g. boys soccer at the Annie Fisher turf), which get no shift.
const ON_CAMPUS_LOCATION = /classical magnet/i;
// CIAC keeps a cancelled game in the feed and prefixes its title instead.
const CANCELLED_SUMMARY = /^\s*cancell?ed\b/i;

function feedUrl() {
    const raw = String(process.env.ATHLETICS_ICS_URL || '').trim();
    return raw ? raw.replace(/^webcal:\/\//i, 'https://') : '';
}

// --- ICS parsing -------------------------------------------------------------
// Just enough of RFC 5545 for this feed: line unfolding, VEVENT properties,
// TEXT unescaping, and DATE-TIME values that are floating/TZID (read as
// America/New_York — the only zone this feed uses) or UTC ("Z").

function unescapeText(value) {
    return value.replace(/\\([\\;,nN])/g, (_m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// "20261019T153000" (+ optional Z) -> epoch ms. All-day DATE values (no time)
// return null: games always have a start time, and there's no sensible shift
// window to build around an all-day entry.
function parseIcsDateTime(value) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(value.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, s = '0', z] = m;
    if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    return etWallToUtc(+y, +mo, +d, +h, +mi, +s, 0);
}

function parseIcs(text) {
    // Unfold: a CRLF followed by a space or tab continues the previous line.
    const lines = String(text).replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    const events = [];
    let current = null;
    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') { current = {}; continue; }
        if (line === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
        if (!current) continue;
        const colon = line.indexOf(':');
        if (colon < 1) continue;
        const name = line.slice(0, colon).split(';')[0].toUpperCase();
        const value = line.slice(colon + 1);
        if (name === 'UID') current.uid = value.trim();
        else if (name === 'SUMMARY') current.summary = unescapeText(value);
        else if (name === 'LOCATION') current.location = unescapeText(value);
        else if (name === 'DESCRIPTION') current.description = unescapeText(value);
        else if (name === 'DTSTART') current.startsAt = parseIcsDateTime(value);
        else if (name === 'DTEND') current.endsAt = parseIcsDateTime(value);
    }
    return events
        .filter((e) => e.uid && e.startsAt)
        .map((e) => ({
            uid: e.uid,
            startsAt: e.startsAt,
            // No DTEND: assume an hour, which is what the feed uses for every game.
            endsAt: e.endsAt && e.endsAt > e.startsAt ? e.endsAt : e.startsAt + 60 * 60 * 1000,
            summary: (e.summary || '').trim(),
            location: (e.location || '').trim(),
            description: (e.description || '').trim(),
        }));
}

// --- Sync state --------------------------------------------------------------

function getSyncState() {
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(STATE_KEY);
    let state = {};
    try { state = row ? JSON.parse(row.value) : {}; } catch { state = {}; }
    return {
        configured: !!feedUrl(),
        lastAttemptAt: state.lastAttemptAt || null,
        lastSuccessAt: state.lastSuccessAt || null,
        error: state.error || '',
        eventCount: state.eventCount ?? null,
    };
}

function saveSyncState(patch) {
    const { configured, ...prev } = getSyncState();
    const next = { ...prev, ...patch };
    db.prepare(`
        INSERT INTO app_state(key, value, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(STATE_KEY, JSON.stringify(next), Date.now());
}

// --- Sync ----------------------------------------------------------------------

// Writes one parsed feed into athletic_events. A future game that is missing
// from the feed, or now titled "Canceled - ...", gets removed_at stamped (kept,
// not deleted, so signups on it can be flagged). Past games are left alone —
// the feed drops old games over time and that isn't a cancellation.
function applyFeed(events, now = Date.now()) {
    const upsert = db.prepare(`
        INSERT INTO athletic_events(uid, starts_at, ends_at, summary, location, description, on_campus, last_seen_at, removed_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uid) DO UPDATE SET
            starts_at = excluded.starts_at, ends_at = excluded.ends_at,
            summary = excluded.summary, location = excluded.location,
            description = excluded.description, on_campus = excluded.on_campus,
            last_seen_at = excluded.last_seen_at,
            removed_at = CASE WHEN excluded.removed_at IS NULL THEN NULL
                              ELSE COALESCE(athletic_events.removed_at, excluded.removed_at) END
    `);
    db.exec('BEGIN');
    try {
        for (const e of events) {
            upsert.run(
                e.uid, e.startsAt, e.endsAt, e.summary, e.location, e.description,
                ON_CAMPUS_LOCATION.test(e.location) ? 1 : 0, now,
                CANCELLED_SUMMARY.test(e.summary) ? now : null
            );
        }
        // An empty feed is far more likely a CIAC hiccup than every future game
        // being called off at once, so it never removes anything.
        if (events.length) {
            db.prepare(`
                UPDATE athletic_events SET removed_at = ?
                WHERE removed_at IS NULL AND last_seen_at < ? AND starts_at >= ?
            `).run(now, now, now);
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

let inflight = null;

// Fetches and applies the feed. Concurrent callers share one in-flight run.
// Never throws: failures are recorded in the sync state for the admin UI, and
// the last good mirror stays in place.
function syncAthletics() {
    if (inflight) return inflight;
    const url = feedUrl();
    if (!url) return Promise.resolve(getSyncState());
    inflight = (async () => {
        const now = Date.now();
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!res.ok) throw new Error(`Feed responded ${res.status}`);
            const text = await res.text();
            if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Feed did not return a calendar');
            const events = parseIcs(text);
            applyFeed(events, now);
            saveSyncState({ lastAttemptAt: now, lastSuccessAt: now, error: '', eventCount: events.length });
        } catch (err) {
            console.error('Athletics sync failed:', err.message);
            saveSyncState({ lastAttemptAt: now, error: err.message || 'Sync failed' });
        } finally {
            inflight = null;
        }
        return getSyncState();
    })();
    return inflight;
}

// Syncs only when the mirror is stale. Awaited by the schedule API so the first
// page load after the machine wakes shows current games.
async function maybeSyncAthletics() {
    const state = getSyncState();
    if (!state.configured) return state;
    const now = Date.now();
    const fresh = state.lastSuccessAt && now - state.lastSuccessAt < SYNC_INTERVAL_MS;
    const backingOff = state.error && state.lastAttemptAt && now - state.lastAttemptAt < RETRY_AFTER_FAILURE_MS;
    if (fresh || backingOff) return state;
    return syncAthletics();
}

function startAthleticsSync() {
    syncAthletics();
    setInterval(syncAthletics, SYNC_INTERVAL_MS).unref();
}

module.exports = { parseIcs, applyFeed, syncAthletics, maybeSyncAthletics, startAthleticsSync, getSyncState };
