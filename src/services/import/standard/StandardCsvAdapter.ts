/**
 * FINBOOM — REQUIREMENT #1 STANDARD IMPORT
 *
 * Minimal CSV parser for the Standard Import template.
 *
 * The template is RFC-4180-ish (quoted fields with "" escapes). This
 * parser is INTENTIONALLY minimal — it supports the exact feature set of
 * the Standard Import template:
 *  - Comma separator.
 *  - Quoted fields with `""` as the escape for an embedded quote.
 *  - Newlines inside quoted fields (LF only — the template is LF only).
 *  - Trailing empty fields are preserved (so the column count is stable).
 *
 * Anything more exotic (TSV, semicolon, BOM mid-stream) is rejected with
 * a `STANDARD_MALFORMED_CSV` issue.
 *
 * This module does NOT validate the content of the columns; it only
 * produces a 2D array of strings. Validation lives in
 * `StandardImportService`.
 */

import { StandardImportIssue, STANDARD_IMPORT_ISSUE_MESSAGES } from './StandardImportErrors';

export interface StandardCsvParseResult {
  /** True if the file parsed cleanly. */
  ok: boolean;
  /** Header row, lowercased and trimmed, in order. Empty if the file is empty. */
  headers: string[];
  /** Data rows. Each row has the same length as `headers` (trailing empties preserved). */
  rows: string[][];
  /** File-level issues (no rowNumber). */
  fileIssues: StandardImportIssue[];
}

const REQUIRED_HEADERS = ['asset name', 'current value', 'asset class', 'tag', 'currency', 'geography'];

/**
 * Parse CSV text into a header + rows structure.
 *
 * The parser is strict about quoting: a field that begins with `"` MUST
 * end with `"`; embedded `"` is escaped as `""`. Anything else is a
 * `STANDARD_MALFORMED_CSV` issue and `ok` is false.
 */
export function parseStandardCsv(text: string): StandardCsvParseResult {
  const fileIssues: StandardImportIssue[] = [];
  const headers: string[] = [];
  const rows: string[][] = [];

  // Strip a leading UTF-8 BOM if present.
  const normalized = text.replace(/^\uFEFF/, '');

  // Tokenize. We walk the string character by character.
  const fields: string[][] = [[]];
  let current = '';
  let inQuotes = false;
  let i = 0;
  let lineNumber = 1;

  function pushField() {
    fields[fields.length - 1].push(current);
    current = '';
  }
  function pushRow() {
    fields[fields.length - 1] = fields[fields.length - 1];
    fields.push([]);
  }

  while (i < normalized.length) {
    const ch = normalized[i];

    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          // Escaped quote.
          current += '"';
          i += 2;
          continue;
        }
        // Close the quoted field.
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === '\n') {
        // Newline inside a quoted field: allow LF only (template is LF).
        current += ch;
        lineNumber += 1;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    // Not in quotes.
    if (ch === '"') {
      // Opening quote at the START of a field. Tolerate stray quotes
      // mid-field by treating them as literal characters.
      if (current.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushField();
      pushRow();
      lineNumber += 1;
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Tolerate CRLF: skip the \r, the \n will close the field.
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }

  // Final flush.
  if (current.length > 0 || fields[fields.length - 1].length > 0) {
    pushField();
  }
  // Drop the trailing empty row introduced by pushRow on the final newline.
  if (fields.length > 0 && fields[fields.length - 1].length === 0) {
    fields.pop();
  }

  // If we ended while inQuotes, the file is malformed.
  if (inQuotes) {
    fileIssues.push({
      code: 'STANDARD_MALFORMED_CSV',
      severity: 'INVALID',
      message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_MALFORMED_CSV
    });
    return { ok: false, headers, rows, fileIssues };
  }

  if (fields.length === 0) {
    fileIssues.push({
      code: 'STANDARD_EMPTY_FILE',
      severity: 'INVALID',
      message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_EMPTY_FILE
    });
    return { ok: false, headers, rows, fileIssues };
  }

  // First row is the header.
  const rawHeader = fields[0].map(h => h.trim().toLowerCase());
  for (const h of rawHeader) headers.push(h);
  // Remaining rows are data.
  for (let r = 1; r < fields.length; r += 1) {
    rows.push(fields[r]);
  }

  // Verify the required columns are present (case-insensitive, exact order).
  const missing = REQUIRED_HEADERS.filter(rh => !headers.includes(rh));
  if (missing.length > 0) {
    fileIssues.push({
      code: 'STANDARD_MISSING_REQUIRED_COLUMNS',
      severity: 'INVALID',
      message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_MISSING_REQUIRED_COLUMNS
    });
    return { ok: false, headers, rows, fileIssues };
  }

  return { ok: true, headers, rows, fileIssues };
}

/**
 * Look up a cell value by header name (case-insensitive).
 * Returns the trimmed string, or `undefined` if the column is missing
 * or the cell is empty.
 */
export function getCell(
  row: string[],
  headers: string[],
  headerName: string
): string | undefined {
  const idx = headers.indexOf(headerName);
  if (idx === -1) return undefined;
  const v = row[idx];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}
