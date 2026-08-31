'use strict';
/* ============================================================================
 * ingest-service — RFC-4180 delimited-text grid parser.
 *
 * The file-to-rows worker's byte→grid step for TEXT payloads (the H10 gate
 * has already proven the bytes decode strictly as UTF-8/UTF-16 and that a
 * ZIP is an XLSX workbook — workbooks are a named follow-on, refused by the
 * worker with XLSX_EXTRACTION_NOT_WIRED, never hand-parsed XML).
 *
 * Delimiter is an EXPLICIT option (',' default; ';' and '\t' accepted) —
 * sniffing a dialect from the first line is a guess, and this pipeline does
 * not guess. Quoted cells follow RFC-4180: a quoted cell may contain the
 * delimiter, CR/LF and doubled quotes; an unquoted cell is taken verbatim.
 * CRLF and LF both end rows; a final line without a newline still lands.
 *
 * Caps: a row-count cap refuses ROWS_EXCEEDED — the byte cap bounds nothing
 * about grid memory once inflated. The cap is a worker decision (D-028),
 * named here and pinned by test.
 *
 * Purity: no-db, no-io, no-clock. Deterministic: identical text produces
 * deep-equal grids.
 * ==========================================================================*/

const DEFAULT_MAX_ROWS = 250000;

const DELIMITERS = new Set([',', ';', '\t']);

/**
 * Parse delimited text into a grid of string cells.
 *
 * @param {string} text — the decoded payload (BOM already stripped by the sniffer's decode)
 * @param {object} [opts]
 *   delimiter  — ',' (default) | ';' | '\t'
 *   maxRows    — row-count cap (default 250000)
 * @returns {{ok:true, rows:string[][], rowCount:number, delimiter:string}}
 *   | {ok:false, reason:'ROWS_EXCEEDED'|'INVALID_DELIMITER'|'UNTERMINATED_QUOTE', detail?:string}
 */
function parseGrid(text, opts) {
  const o = opts || {};
  const delimiter = o.delimiter === undefined ? ',' : o.delimiter;
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || !DELIMITERS.has(delimiter)) {
    return { ok: false, reason: 'INVALID_DELIMITER', detail: `delimiter must be one of ',', ';', '\\t' — sniffing a dialect is a guess` };
  }
  const maxRows = o.maxRows === undefined ? DEFAULT_MAX_ROWS : o.maxRows;
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    return { ok: false, reason: 'INVALID_DELIMITER', detail: 'maxRows must be a positive integer' };
  }
  if (typeof text !== 'string') {
    return { ok: false, reason: 'INVALID_DELIMITER', detail: 'text must be a string (decode before parsing)' };
  }

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      cell += ch; i += 1; continue;
    }
    if (ch === '"') {
      if (cell === '') { inQuotes = true; i += 1; continue; }
      cell += ch; i += 1; continue; // a quote inside an unquoted cell is data (RFC-4180 lenient read)
    }
    if (ch === delimiter) { row.push(cell); cell = ''; i += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      rows.push(row); row = [];
      if (rows.length > maxRows) return { ok: false, reason: 'ROWS_EXCEEDED', detail: `grid exceeds the ${maxRows}-row cap — split the drop` };
      i += 1; continue;
    }
    cell += ch; i += 1;
  }
  if (inQuotes) return { ok: false, reason: 'UNTERMINATED_QUOTE', detail: 'a quoted cell never closed' };
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
    if (rows.length > maxRows) return { ok: false, reason: 'ROWS_EXCEEDED', detail: `grid exceeds the ${maxRows}-row cap — split the drop` };
  }
  return { ok: true, rows, rowCount: rows.length, delimiter };
}

module.exports = { parseGrid, DEFAULT_MAX_ROWS };
