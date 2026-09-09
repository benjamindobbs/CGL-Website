// Shared America/New_York calendar-date helpers, used anywhere a report needs
// to bucket transactions by store day rather than raw UTC instant (the
// register closes on ET wall-clock days regardless of DST).
const TIME_ZONE = 'America/New_York';

// Minutes that ET is ahead of UTC at the given instant (negative: ET is behind).
// -240 during EDT, -300 during EST.
function etOffsetMinutes(ms) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: TIME_ZONE, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(ms)).map((p) => [p.type, p.value])
    );
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
    return (asUtc - ms) / 60000;
}

// Epoch ms for a wall-clock time in America/New_York. The noon anchor picks the
// right DST offset for the date (it can be an hour off only for times within the
// 2 a.m. DST switch itself — immaterial for a sales log).
function etWallToUtc(y, mo, d, h, mi, s, msPart) {
    const off = etOffsetMinutes(Date.UTC(y, mo - 1, d, 12));
    return Date.UTC(y, mo - 1, d, h, mi, s, msPart) - off * 60000;
}

// Parses a YYYY-MM-DD string into an epoch-ms bound, read as an ET calendar
// day. `endOfDay` pushes it to 23:59:59.999 ET so a `to` filter includes that
// whole day. Unparseable input is ignored (returns null).
function dayBound(value, endOfDay = false) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, mo, d] = value.split('-').map(Number);
    return endOfDay ? etWallToUtc(y, mo, d, 23, 59, 59, 999) : etWallToUtc(y, mo, d, 0, 0, 0, 0);
}

// The America/New_York calendar date for an instant, as YYYY-MM-DD (en-CA).
function etDate(ms) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(ms));
}

module.exports = { TIME_ZONE, etOffsetMinutes, etWallToUtc, dayBound, etDate };
