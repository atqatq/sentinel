'use strict';
/* ============================================================================
 * ingest-service — the §4.1 workbook extraction suite (named proof
 * `ingest/xlsx-extraction`): the boundary the XLSX_EXTRACTION_NOT_WIRED
 * refusal named.
 *
 * The workbooks under test are GENERATED here with the same exact-pinned
 * reader library (exceljs) — no binary fixture rides the repo, and the
 * generator doubles as proof that the extractor reads what a real workbook
 * writes. Every cell→text rule, the caps, the determinism and the
 * downstream-identity (a workbook grid parses EXACTLY like its CSV twin)
 * are pinned.
 * ==========================================================================*/
const assert = require('assert');
const ExcelJS = require('exceljs');
const path = require('path');

const XLSX = require(path.join(__dirname, '..', 'src', 'xlsx.js'));

/* ---- workbook generators ---------------------------------------------------- */

async function workbookFrom(rowsPerSheet) {
  const wb = new ExcelJS.Workbook();
  for (const { name, rows } of rowsPerSheet) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf);
}

async function workbookFromSheets(sheets) { return workbookFrom(sheets); }

/* ---- the runner -------------------------------------------------------------- */
let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  const pass = () => { passed++; console.log('  ✓ ' + name); };
  const fail = (e) => { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); };
  let out;
  try { out = fn(); } catch (e) { fail(e); return; }
  if (out && typeof out.then === 'function') pending.push(out.then(pass, fail));
  else pass();
}

/* ---- cell → text rules -------------------------------------------------------- */

test('a string cell comes out verbatim; blank cells are empty strings', async () => {
  const bytes = await workbookFrom([{ name: 'S', rows: [['Plain text', null, '']] }]);
  const r = await XLSX.extractWorkbook(bytes);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.sheets[0].rows[0], ['Plain text', '', '']);
});

test('a number cell takes its shortest round-trip; a boolean reads TRUE/FALSE', async () => {
  const bytes = await workbookFrom([{ name: 'S', rows: [[42, 3.5, -0.25, true, false]] }]);
  const r = await XLSX.extractWorkbook(bytes);
  assert.deepStrictEqual(r.sheets[0].rows[0], ['42', '3.5', '-0.25', 'TRUE', 'FALSE']);
});

test('a date-only styled cell reads YYYY-MM-DD; a datetime cell reads the naive wall time', async () => {
  const bytes = await workbookFrom([{ name: 'S', rows: [[new Date(Date.UTC(2026, 1, 28)), new Date(Date.UTC(2026, 1, 28, 14, 5, 9))]] }]);
  const r = await XLSX.extractWorkbook(bytes);
  assert.deepStrictEqual(r.sheets[0].rows[0], ['2026-02-28', '2026-02-28 14:05:09']);
});

test('a formula cell reads its cached result — what the workbook displayed', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getCell('A1').value = 2;
  ws.getCell('A2').value = 3;
  ws.getCell('A3').value = { formula: 'A1+A2', result: 5 };
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
  const r = await XLSX.extractWorkbook(bytes);
  assert.deepStrictEqual(r.sheets[0].rows[2], ['5']);
});

test('rich text and hyperlink cells reduce to their display text; an errored cell carries none', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getCell('A1').value = { richText: [{ text: 'Su' }, { text: 'preme' }] };
  ws.getCell('B1').value = { text: 'Supplier portal', hyperlink: 'https://intranet.example/supplier' };
  ws.getCell('C1').value = { error: { error: '#DIV/0!' } };
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
  const r = await XLSX.extractWorkbook(bytes);
  assert.deepStrictEqual(r.sheets[0].rows[0], ['Supreme', 'Supplier portal', '']);
});

/* ---- structure ------------------------------------------------------------------ */

test('every sheet lands with its name, in workbook order', async () => {
  const bytes = await workbookFromSheets([
    { name: '1_ITEMS', rows: [['SKU *'], ['S1']] },
    { name: '6_DELIVERIES', rows: [['Period Start'], ['2026-02-01']] },
  ]);
  const r = await XLSX.extractWorkbook(bytes);
  assert.deepStrictEqual(r.sheets.map((s) => s.name), ['1_ITEMS', '6_DELIVERIES']);
  assert.deepStrictEqual(r.sheets[0].rows[1], ['S1']);
});

test('extraction is deterministic — identical bytes, deep-equal sheets', async () => {
  const build = async () => workbookFrom([{ name: 'S', rows: [['a', 1, true], ['b', 2.5, false]] }]);
  const [r1, r2] = [await XLSX.extractWorkbook(await build()), await XLSX.extractWorkbook(await build())];
  assert.deepStrictEqual(r1, r2);
});

test('an empty workbook yields an empty sheet list, not a refusal', async () => {
  const wb = new ExcelJS.Workbook();
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
  const r = await XLSX.extractWorkbook(bytes);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.sheets, []);
});

test('non-workbook bytes refuse WORKBOOK_UNREADABLE — the H10 gate has already screened, this is the second fence', async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]); // ZIP start, garbage after
  const r = await XLSX.extractWorkbook(bytes);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'WORKBOOK_UNREADABLE');
});

/* ---- the caps (D-028's posture) ---------------------------------------------------- */

test('GRID_CAPS_EXCEEDED: too many sheets refuses whole — nothing partial returns', async () => {
  const bytes = await workbookFromSheets([
    { name: 'A', rows: [['x']] },
    { name: 'B', rows: [['y']] },
  ]);
  const r = await XLSX.extractWorkbook(bytes, { maxSheets: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'GRID_CAPS_EXCEEDED');
  assert.match(r.detail, /2 sheets/);
});

test('GRID_CAPS_EXCEEDED: a sheet over the row cap refuses with the sheet named', async () => {
  const rows = [['h'], ['r1'], ['r2'], ['r3']];
  const bytes = await workbookFrom([{ name: 'BIG', rows }]);
  const r = await XLSX.extractWorkbook(bytes, { maxRows: 2 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'GRID_CAPS_EXCEEDED');
  assert.match(r.detail, /BIG/);
});

test('GRID_CAPS_EXCEEDED: the total-cell cap bounds inflated grid memory', async () => {
  const bytes = await workbookFrom([{ name: 'S', rows: [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]] }]);
  const r = await XLSX.extractWorkbook(bytes, { maxCells: 5 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'GRID_CAPS_EXCEEDED');
});

/* ---- the downstream-identity promise: the grid parses EXACTLY like its CSV twin ---- */

test('the extracted grid rides the SAME strict parser as the CSV twin — deliveries rows deep-equal', async () => {
  const header = ['Period Start', 'Period End', 'Deliveries'];
  const dataRows = [
    ['2026-02-01', '2026-02-01', '120'],
    ['2026-02-02', '2026-02-02', '130'],
  ];
  const bytes = await workbookFrom([{ name: '6_DELIVERIES', rows: [header, ...dataRows] }]);
  const r = await XLSX.extractWorkbook(bytes);
  assert.ok(r.ok);

  const csvText = [header.join(','), ...dataRows.map((x) => x.join(','))].join('\n');
  const csvGrid = require(path.join(__dirname, '..', 'src', 'csv.js')).parseGrid(csvText, {});
  assert.ok(csvGrid.ok);

  assert.deepStrictEqual(r.sheets[0].rows, csvGrid.rows,
    'the workbook path must produce the identical grid the CSV path produces — one parser, no softer twin');
});

/* ---- the verdict: async assertions must COMPLETE before the summary ---------- */
(async () => {
  for (const p of pending) await p;
  console.log(`\nxlsx-extraction: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
