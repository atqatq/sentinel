'use strict';
/* ============================================================================
 * File-kind signature binding tests — INGESTION_FILE_SPEC §1/§2/§3.1/§4.
 * Fixtures are checksum-pinned (H12): a drifted fixture fails this suite.
 * ==========================================================================*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('../src/filebinding');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }
const FIX = (f) => path.join(__dirname, '../../../../../fixtures/golden', f);
const readCsv = (f) => fs.readFileSync(FIX(f), 'utf8').split(/\r?\n/).filter((l) => l !== '').map((l) => l.split(','));

/* ---- normalizeHeader -------------------------------------------------------- */
console.log('\nHeader normalization (§3.1: trim, case-fold, alias — never exact)');

test('trims, case-folds, collapses whitespace', () => {
  assert.strictEqual(B.normalizeHeader('  SKU   * '), 'sku');
  assert.strictEqual(B.normalizeHeader('Business Unit Name '), 'business unit name');
});
test('strips bracket annotations and required markers into one canonical key', () => {
  assert.strictEqual(B.normalizeHeader('Inactive * [1=Inactive 0=Active]'), 'inactive');
  assert.strictEqual(B.normalizeHeader('Brand*'), 'brand');
  assert.strictEqual(B.normalizeHeader('Granularity [daily|weekly|monthly|quarterly|ytd]'), 'granularity');
});

/* ---- detectFileKind ---------------------------------------------------------- */
console.log('\nKind detection — signatures from the shipped template');

test('detects all 8 kinds from their template row-2 headers', () => {
  const t = JSON.parse(fs.readFileSync(FIX('template_headers.json'), 'utf8'));
  const expect = {
    '1_ITEMS': 'items', '2_INVENTORY': 'inventory_all_dimensions',
    '3_CONSUMPTION': 'consumption_balances', '4_OPEN_POS': 'open_pos',
    '5_SUPPLIERS': 'suppliers', '6_DELIVERIES': 'deliveries',
    '7_PLANNING_PARAMS': 'planning_params', '8_CATEGORY_OWNERS': 'category_owners',
  };
  for (const [tab, kind] of Object.entries(expect)) {
    const d = B.detectFileKind(t[tab]);
    assert.strictEqual(d.kind, kind, tab);
    assert.strictEqual(d.score, 1, `${tab} must fully match: missing ${d.missingRequired}`);
  }
});
test('template drift fails detection — fixture snapshot is the guard', () => {
  const t = JSON.parse(fs.readFileSync(FIX('template_headers.json'), 'utf8'));
  const broken = t['4_OPEN_POS'].filter((h) => B.normalizeHeader(h) !== 'ordered (quantity)');
  const d = B.detectFileKind(broken);
  assert.strictEqual(d.matched, true);
  assert.notStrictEqual(d.score, 1); // partial — bindGrid refuses to bind partials
});
test('kind signatures are unambiguous on their distinctive headers', () => {
  assert.strictEqual(B.detectFileKind(['Transfers - Goods In','Start Balance','SKU']).kind, 'consumption_balances');
  assert.strictEqual(B.detectFileKind(['Ordered (Quantity)','Purchase Order #']).kind, 'open_pos');
  assert.strictEqual(B.detectFileKind(['Warehouse','Quantity','Gross Total, Document Currency']).kind, 'inventory_all_dimensions');
  assert.strictEqual(B.detectFileKind(['Recipe Ref Name','Safety Days','MOQ']).kind, 'planning_params');
});
test('unrelated headers → NO_SIGNATURE_MATCH', () => {
  assert.strictEqual(B.detectFileKind(['foo','bar','baz']).matched, false);
});

/* ---- bindGrid ----------------------------------------------------------------- */
console.log('\nGrid binding — instruction rows stripped (§4 steps 1-2)');

test('Mode A fixture: binds past the 2 instruction rows, binds items fully', () => {
  const g = B.bindGrid(readCsv('items_modeA.csv'));
  assert.strictEqual(g.bound !== false, true);
  assert.strictEqual(g.kind, 'items');
  assert.strictEqual(g.instructionRowCount, 2);
  assert.strictEqual(g.detection.score, 1);
});
test('a grid with no matching header row reports NO_HEADER_ROW_FOUND', () => {
  const g = B.bindGrid([['junk'], ['more junk']]);
  assert.strictEqual(g.bound, false);
  assert.strictEqual(g.reason, 'NO_HEADER_ROW_FOUND');
});
test('partial signature match is reported but NOT bound (fail-closed)', () => {
  const g = B.bindGrid([['SKU *','Item Name *']]);
  assert.strictEqual(g.bound, false);
  assert.strictEqual(g.detection.score < 1, true);
});

/* ---- applyAllowList ------------------------------------------------------------ */
console.log('\nAllow-list (§2: anything not listed is dropped, never persisted, never logged)');

test('items fixture maps canonical fields at the right source indexes', () => {
  const rows = readCsv('items_modeA.csv');
  const r = B.applyAllowList('items', rows[2]);
  const byField = Object.fromEntries(r.kept.map((k) => [k.field, k.sourceIndex]));
  assert.strictEqual(byField.sku, 0);
  assert.strictEqual(byField.recipeRef, 10);
  assert.strictEqual(byField.shelfLifeDays, 18);
  assert.ok(r.droppedCount >= 0 && r.kept.length === 23);
});
test('supplier banking/tax columns are ALL dropped from the suppliers fixture', () => {
  const rows = readCsv('suppliers_modeA_with_bank_columns.csv');
  const det = B.detectFileKind(rows[2]);
  assert.strictEqual(det.kind, 'suppliers');
  const r = B.applyAllowList('suppliers', rows[2]);
  const fields = r.kept.map((k) => k.field);
  for (const banned of ['bankAccountNumber','iban','swift','taxId','pan','legalAddress','phoneNumber']) {
    assert.strictEqual(fields.includes(banned), false, banned);
  }
  // every banned raw column landed in the dropped count — fixture carries 13 of
  // §2's 14 discard-list columns (Bank Address omitted; NEVER_KEPT still lists it)
  assert.strictEqual(r.droppedCount, 13);
  assert.deepStrictEqual(fields, ['supplierName','supplierActive','leadTimeDays','moqValue','paymentTerms','currency']);
});
test('dropped entries carry NO content — indexes only (§2: never logged)', () => {
  const rows = readCsv('suppliers_modeA_with_bank_columns.csv');
  const r = B.applyAllowList('suppliers', rows[2]);
  for (const d of r.dropped) assert.deepStrictEqual(Object.keys(d), ['sourceIndex']);
});
test('alias maps serve Mode A and Mode B with one table (§3.1)', () => {
  // Precoro export alias and template header both map to the same field
  assert.strictEqual(B.ALIASES.items['item name'], 'itemName');
  assert.strictEqual(B.ALIASES.open_pos['currency'], 'currency');
  assert.strictEqual(B.ALIASES.suppliers['supplier'], 'supplierName');
});
test('a blocklisted column can never be kept — mapping it throws', () => {
  const broken = Object.assign({}, B.ALIASES.suppliers, { 'iban': 'iban' });
  const orig = B.ALIASES.suppliers;
  B.ALIASES.suppliers = broken;
  try {
    assert.throws(() => B.applyAllowList('suppliers', ['IBAN']), /blocklisted/);
  } finally { B.ALIASES.suppliers = orig; }
});
test('deliveries template tab binds and maps qty from the Deliveries column', () => {
  const rows = readCsv('deliveries_template_tab.csv');
  const bound = B.bindGrid(rows);
  assert.strictEqual(bound.kind, 'deliveries');
  assert.strictEqual(bound.instructionRowCount, 1); // banner row skipped
  const r = B.applyAllowList('deliveries', rows[1]);
  const byField = Object.fromEntries(r.kept.map((k) => [k.field, k.sourceIndex]));
  assert.strictEqual(byField.qty, 2);
  assert.strictEqual(byField.granularity, 1);
});
test('every kind exposes a signature and an alias map — completeness pair', () => {
  assert.deepStrictEqual(
    Object.keys(B.SIGNATURES).sort(),
    Object.keys(B.ALIASES).sort());
  assert.strictEqual(Object.keys(B.SIGNATURES).length, 8);
});

/* ---- H7 supplier identity (delivery-spec A8) --------------------------------- */
console.log('\nH7 supplier identity');

test("'Supplier ID' binds to supplierExternalId — the identity key (H7/A8)", () => {
  const r = B.applyAllowList('suppliers', ['Name *', 'Supplier ID', 'Active * [0=Inactive 1=Active]', 'Payment Terms']);
  const f = r.kept.find((k) => k.field === 'supplierExternalId');
  assert.ok(f, 'supplierExternalId was not kept');
  assert.strictEqual(f.sourceIndex, 1);
});
test('alias is trim/case tolerant like every other header', () => {
  const r = B.applyAllowList('suppliers', [' supplier id ', 'NAME']);
  assert.ok(r.kept.some((k) => k.field === 'supplierExternalId'));
  assert.ok(r.kept.some((k) => k.field === 'supplierName'));
});
test('without the column, current-template binding succeeds — interim name identity (D-016)', () => {
  const rows = readCsv('suppliers_modeA_with_bank_columns.csv');
  const r = B.applyAllowList('suppliers', rows[2]);
  assert.ok(!r.kept.some((k) => k.field === 'supplierExternalId'), 'no Supplier ID column exists yet');
  assert.ok(r.kept.some((k) => k.field === 'supplierName'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
