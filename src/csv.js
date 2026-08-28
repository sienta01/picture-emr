/**
 * RFC 4180 field escaping. Diagnoses are multi-line by design, and a quoted field
 * may legally contain newlines — Excel, LibreOffice and Sheets all read them back
 * as a single cell.
 */
function escapeField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function toCsv(header, rows) {
  const lines = [header.map(escapeField).join(',')];
  for (const row of rows) lines.push(row.map(escapeField).join(','));
  // CRLF line endings and a UTF-8 BOM keep Excel on Windows from mangling
  // accented names and from guessing the wrong encoding.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Collapses a multi-line diagnosis onto one line for users who prefer flat cells. */
export function flattenLines(text, separator = '; ') {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(separator);
}
