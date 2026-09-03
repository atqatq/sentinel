'use strict';
/* ============================================================================
 * ingest-service — xlsx.js: the workbook byte→grids extractor (§4.1).
 *
 * The boundary the XLSX_EXTRACTION_NOT_WIRED refusal named: workbook BYTES
 * become per-sheet STRING GRIDS here, in the worker layer, with a real
 * reading library (exceljs, exact-pinned) — never a hand-rolled XML parser,
 * and never inside the pure ingestion module.
 *
 * Determinism contract: identical bytes produce deep-equal sheets. Cell →
 * text is display-honest:
 *   string            → verbatim
 *   number            → shortest round-trip (String(n))
 *   boolean           → 'TRUE' | 'FALSE'
 *   Date (midnight)   → 'YYYY-MM-DD'        (a styled date-only cell)
 *   Date (other)      → 'YYYY-MM-DD HH:mm:ss' — Excel datetimes are NAIVE wall
 *                       values; UTC-shaped formatting reconstructs the wall
 *                       time so H4's tenant-timezone conversion downstream
 *                       reads exactly what the workbook showed.
 *   formula           → its cached result, stringified by the same rules
 *   rich text / error / hyperlink objects → their text / '' (never a JS
 *                       object stringified into a data column)
 *
 * The grids ride the IDENTICAL downstream pipeline as a text file (strip
 * tips → bind → allow-list → strict parse) — the workbook never gets a
 * second, softer parser.
 *
 * Caps (D-028's posture: the byte cap bounds nothing about grid memory once
 * inflated): maxSheets, maxRows per sheet, maxCells total — a breach refuses
 * GRID_CAPS_EXCEEDED, nothing partial is returned.
 * ==========================================================================*/

const ExcelJS = require('exceljs');

const DEFAULT_MAX_SHEETS = 64;   // the template carries 8; 64 is generous
const DEFAULT_MAX_ROWS = 250000; // the parseGrid cap, mirrored per sheet
const DEFAULT_MAX_CELLS = 5000000;

const pad2 = (n) => String(n).padStart(2, '0');

/** Date cell → honest text (UTC-shaped; see the header contract). */
function dateToText(d) {
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
  const h = d.getUTCHours(), mi = d.getUTCMinutes(), s = d.getUTCSeconds();
  if (h === 0 && mi === 0 && s === 0) return `${y}-${pad2(mo)}-${pad2(da)}`;
  return `${y}-${pad2(mo)}-${pad2(da)} ${pad2(h)}:${pad2(mi)}:${pad2(s)}`;
}

/** One cell value → its display-honest string. Deterministic, no clock. */
function cellToText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return dateToText(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => (r && typeof r.text === 'string' ? r.text : '')).join('');
    if (v.formula !== undefined || v.sharedFormula !== undefined) {
      return cellToText(v.result !== undefined ? v.result : null); // the cached result — what the workbook displayed
    }
    if (v.error !== undefined) return ''; // an errored cell carries no data
    if (v.text !== undefined) return cellToText(v.text); // hyperlink cells: their display text
  }
  return '';
}

/**
 * Extract every sheet of an XLSX workbook into string grids.
 *
 * @param {Uint8Array|Buffer} bytes — the workbook payload (H10 already gated it)
 * @param {object} [opts]
 *   maxSheets (64) | maxRows (250000 per sheet) | maxCells (5,000,000 total)
 * @returns {Promise<{ok:true, sheets:{name:string, rows:string[][]}[]}>}
 *   | {ok:false, reason:'EMPTY_PAYLOAD'|'WORKBOOK_UNREADABLE'|'GRID_CAPS_EXCEEDED', detail?}
 */
async function extractWorkbook(bytes, opts) {
  const o = opts || {};
  const maxSheets = o.maxSheets ?? DEFAULT_MAX_SHEETS;
  const maxRows = o.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCells = o.maxCells ?? DEFAULT_MAX_CELLS;

  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return { ok: false, reason: 'EMPTY_PAYLOAD', detail: 'workbook extraction: no bytes' };
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes));
  } catch (e) {
    return { ok: false, reason: 'WORKBOOK_UNREADABLE', detail: `the workbook could not be read: ${e && e.message ? e.message : String(e)}` };
  }

  if (wb.worksheets.length > maxSheets) {
    return { ok: false, reason: 'GRID_CAPS_EXCEEDED', detail: `workbook carries ${wb.worksheets.length} sheets — the cap is ${maxSheets}` };
  }

  const sheets = [];
  let totalCells = 0;
  for (const ws of wb.worksheets) {
    const rowCount = ws.actualRowCount;
    if (rowCount > maxRows) {
      return { ok: false, reason: 'GRID_CAPS_EXCEEDED', detail: `sheet '${ws.name}' has ${rowCount} rows — the per-sheet cap is ${maxRows}` };
    }
    const rows = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (!row || row.cellCount === 0) { rows.push([]); continue; }
      const out = new Array(row.cellCount);
      for (let c = 1; c <= row.cellCount; c++) out[c - 1] = cellToText(row.getCell(c).value);
      rows.push(out);
    }
    totalCells += rows.reduce((s, r) => s + r.length, 0);
    if (totalCells > maxCells) {
      return { ok: false, reason: 'GRID_CAPS_EXCEEDED', detail: `workbook inflates to ${totalCells} cells — the total cap is ${maxCells}` };
    }
    sheets.push({ name: ws.name, rows });
  }
  return { ok: true, sheets };
}

module.exports = { extractWorkbook, cellToText, dateToText };
