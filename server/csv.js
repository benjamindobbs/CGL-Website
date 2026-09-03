// RFC-4180 CSV helpers shared by the export routes.

// One field: wrap in quotes and double any embedded quote when the value
// contains a comma, quote, CR, or LF.
function csvField(value) {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Full CSV document: header row + data rows, CRLF endings, UTF-8 BOM (Excel opens
// UTF-8 correctly only with a BOM). `rows` is an array of arrays.
function csvDocument(headers, rows) {
    const lines = [headers.map(csvField).join(',')];
    for (const row of rows) lines.push(row.map(csvField).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { csvField, csvDocument };
