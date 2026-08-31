'use strict';
/* ============================================================================
 * Ingestion normalization stage — unit resolution, C1 conversion, C2 money.
 *
 * Golden threads under test:
 *  - C1: conversion happens AT INGESTION, refuses when the factor is absent
 *        (engine R3 code MISSING_CONVERSION_FACTOR) — a missed conversion is
 *        an order-of-magnitude error in both directions.
 *  - C2: money normalizes at ingestion (documentCurrency + tenantValue at
 *        the pinned rate); a third currency is REFUSED, never summed — the
 *        audit probe (10,000 BHD + 10,000 AED = 20,000) dies here.
 *  - R1 mirror: tenantCurrency is mandatory; a missing pin withholds the
 *        row (RATE_NOT_PINNED) instead of guessing.
 *  - Stage composition: parse.js guarantees finite numbers; a non-finite
 *        value reaching this stage is a wiring error and THROWS.
 * ==========================================================================*/
const assert = require('assert');
const N = require('../src/normalize');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }
const near = (a,b,eps=1e-9)=>Math.abs(a-b)<=eps;

const CATALOG = {
  canonical: ['PCS', 'CTN', 'KG', 'BTL'],
  aliases: { 'PIECES': 'PCS', 'PIECE': 'PCS', 'CASES': 'CTN', 'BOTTLES': 'BTL', 'KILOGRAMS': 'KG' },
};

/* ---- validateUnitCatalog --------------------------------------------------- */
console.log('\nUnit catalog validation (fail-closed)');

test('accepts a well-formed catalog with aliases', () => {
  assert.strictEqual(N.validateUnitCatalog(CATALOG), true);
});
test('accepts a catalog with no aliases at all', () => {
  assert.strictEqual(N.validateUnitCatalog({ canonical: ['PCS'] }), true);
});
test('rejects an empty canonical list', () => {
  assert.throws(() => N.validateUnitCatalog({ canonical: [] }), /non-empty array/);
});
test('rejects duplicate canonical entries differing only by case', () => {
  assert.throws(() => N.validateUnitCatalog({ canonical: ['CTN', 'ctn'] }), /duplicate canonical/);
});
test('rejects an alias pointing outside the canonical set', () => {
  assert.throws(() => N.validateUnitCatalog({ canonical: ['PCS'], aliases: { CASES: 'CTN' } }), /not a canonical unit/);
});
test('rejects aliases that collide after normalization', () => {
  assert.throws(() => N.validateUnitCatalog({ canonical: ['CTN'], aliases: { 'CASES': 'CTN', 'cases ': 'CTN' } }), /collide/);
});
test('rejects a non-object catalog', () => {
  assert.throws(() => N.validateUnitCatalog(null), TypeError);
  assert.throws(() => N.validateUnitCatalog(['PCS']), TypeError);
});

/* ---- resolveUnit ------------------------------------------------------------ */
console.log('\nUnit resolution — unresolved spellings are data-health, never guesses');

test('resolves an exact canonical spelling', () => {
  const r = N.resolveUnit('CTN', CATALOG);
  assert.ok(r.ok); assert.strictEqual(r.unit, 'CTN');
});
test('resolution is trimmed and case-insensitive', () => {
  const r = N.resolveUnit('  ctn ', CATALOG);
  assert.ok(r.ok); assert.strictEqual(r.unit, 'CTN');
});
test('resolves an alias to its canonical unit', () => {
  const r = N.resolveUnit('CASES', CATALOG);
  assert.ok(r.ok); assert.strictEqual(r.unit, 'CTN');
});
test('resolves a padded, lowercased alias', () => {
  const r = N.resolveUnit(' cases ', CATALOG);
  assert.ok(r.ok); assert.strictEqual(r.unit, 'CTN');
});
test('null and undefined units are MISSING', () => {
  assert.strictEqual(N.resolveUnit(null, CATALOG).reason, 'MISSING');
  assert.strictEqual(N.resolveUnit(undefined, CATALOG).reason, 'MISSING');
});
test('a whitespace-only unit is MISSING', () => {
  assert.strictEqual(N.resolveUnit('   ', CATALOG).reason, 'MISSING');
});
test('a non-string unit is NOT_A_STRING', () => {
  const r = N.resolveUnit(42, CATALOG);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'NOT_A_STRING');
});
test('an unknown spelling is UNRESOLVED_UNIT with the raw value preserved', () => {
  const r = N.resolveUnit('CRT', CATALOG);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'UNRESOLVED_UNIT'); assert.strictEqual(r.raw, 'CRT');
});

/* ---- convertOpenPoRows (C1) -------------------------------------------------- */
console.log('\nC1 — openPO conversion at ingestion, before the engine sees rows');

test('converts waiting × factor and carries the factor onto the row', () => {
  const rows = [{ sku: 'SKU-1', poNumber: 'PO-9', waiting: 30, unit: 'CTN' }];
  const out = N.convertOpenPoRows(rows, { 'SKU-1': 100 }, '2026-08-30');
  assert.strictEqual(out.convertedCount, 1);
  assert.strictEqual(out.converted[0].waitingConverted, 3000);
  assert.strictEqual(out.converted[0].conversionFactor, 100);
  assert.strictEqual(out.unconverted.length, 0);
});
test('a missing factor refuses the line — never guesses 1.0', () => {
  const rows = [{ sku: 'SKU-X', waiting: 5 }];
  const out = N.convertOpenPoRows(rows, { 'SKU-1': 100 }, '2026-08-30');
  assert.strictEqual(out.convertedCount, 0);
  assert.strictEqual(out.unconverted[0].reason, 'MISSING_CONVERSION_FACTOR');
  assert.strictEqual(out.unconverted[0].sku, 'SKU-X');
  assert.strictEqual(out.unconverted[0].asOf, '2026-08-30');
});
test('a zero, negative or non-finite factor is INVALID, not applied', () => {
  for (const bad of [0, -2, NaN, 'abc']) {
    const out = N.convertOpenPoRows([{ sku: 'S', waiting: 5 }], { S: bad }, '2026-08-30');
    assert.strictEqual(out.unconverted[0].reason, 'INVALID_CONVERSION_FACTOR', `cf=${bad}`);
    assert.strictEqual(out.convertedCount, 0);
  }
});
test('zero waiting with a valid factor converts to zero', () => {
  const out = N.convertOpenPoRows([{ sku: 'S', waiting: 0 }], { S: 12 }, '2026-08-30');
  assert.strictEqual(out.convertedCount, 1);
  assert.strictEqual(out.converted[0].waitingConverted, 0);
});
test('mixed batch: order preserved, original fields intact, split exact', () => {
  const rows = [
    { sku: 'A', poNumber: 'PO-1', waiting: 2 },
    { sku: 'B', poNumber: 'PO-1', waiting: 3 },
    { sku: 'C', poNumber: 'PO-2', waiting: 4 },
  ];
  const out = N.convertOpenPoRows(rows, { A: 10, C: 0.5 }, '2026-08-30');
  assert.strictEqual(out.convertedCount, 2);
  assert.strictEqual(out.converted[0].sku, 'A');
  assert.strictEqual(out.converted[0].waitingConverted, 20);
  assert.strictEqual(out.converted[1].sku, 'C');
  assert.strictEqual(out.converted[1].waitingConverted, 2);
  assert.strictEqual(out.converted[0].poNumber, 'PO-1');
  assert.strictEqual(out.unconverted.length, 1);
  assert.strictEqual(out.unconverted[0].rowIndex, 1);
  assert.strictEqual(out.unconverted[0].sku, 'B');
});
test('a non-finite waiting is a wiring error and throws (parse stage must run first)', () => {
  assert.throws(() => N.convertOpenPoRows([{ sku: 'A', waiting: '12' }], { A: 10 }, '2026-08-30'), TypeError);
  assert.throws(() => N.convertOpenPoRows([{ sku: 'A', waiting: NaN }], { A: 10 }, '2026-08-30'), TypeError);
});
test('an empty rows array yields empty outputs without throwing', () => {
  const out = N.convertOpenPoRows([], { A: 10 }, '2026-08-30');
  assert.strictEqual(out.converted.length, 0);
  assert.strictEqual(out.unconverted.length, 0);
});
test('a missing factor map sends every row to data-health, none converted', () => {
  const out = N.convertOpenPoRows([{ sku: 'A', waiting: 1 }, { sku: 'B', waiting: 2 }], null, '2026-08-30');
  assert.strictEqual(out.convertedCount, 0);
  assert.strictEqual(out.unconverted.length, 2);
  assert.ok(out.unconverted.every(u => u.reason === 'MISSING_CONVERSION_FACTOR'));
});

/* ---- normalizeMoney (C2) ------------------------------------------------------ */
console.log('\nC2 — money normalized at ingestion; third currencies refused, never summed');

const RATES = { usdToLocalByDay: { '2026-08-29': 0.375, '2026-08-30': 0.376 } };

test('a local-currency row passes through at rate 1, source LOCAL', () => {
  const r = N.normalizeMoney({ amount: 250, documentCurrency: 'BHD', asOfDay: '2026-08-30' }, 'BHD', RATES);
  assert.ok(r.ok);
  assert.strictEqual(r.tenantValue, 250);
  assert.strictEqual(r.rate, 1);
  assert.strictEqual(r.rateSource, 'LOCAL');
});
test('a USD row converts at the pinned rate: 10 USD → 3.76 BHD (direction sanity)', () => {
  const r = N.normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-30' }, 'BHD', RATES);
  assert.ok(r.ok);
  assert.ok(near(r.tenantValue, 3.76));
  assert.ok(near(r.rate, 0.376));
  assert.strictEqual(r.rateSource, 'PINNED_USD');
});
test('currency codes are trimmed and case-folded to ISO upper', () => {
  const r = N.normalizeMoney({ amount: 10, documentCurrency: ' usd ', asOfDay: '2026-08-30' }, ' bhd ', RATES);
  assert.ok(r.ok);
  assert.strictEqual(r.documentCurrency, 'USD');
  assert.strictEqual(r.tenantCurrency, 'BHD');
});
test('a USD row on a late-pinned day CONTINUES on the last pinned rate — stale-visible (M10; the D-015 blanket refusal narrowed to never-pinned, ADR-0003/D-038)', () => {
  const r = N.normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-31' }, 'BHD', RATES);
  assert.ok(r.ok);                                       // the money KEEPS FLOWING (the M10 fix)
  assert.strictEqual(r.rateSource, 'PINNED_USD');
  assert.strictEqual(r.stale, true);
  assert.deepStrictEqual(r.rateStale, { pinnedFor: '2026-08-30', staleDays: 1 });
});
test('a USD row with NO pin on or before its day is still refused — RATE_NOT_PINNED, fail-closed (D-015 verbatim)', () => {
  const r = N.normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-31' }, 'BHD', { usdToLocalByDay: {} });
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, 'RATE_NOT_PINNED');
  assert.strictEqual(r.asOfDay, '2026-08-31');
});
test('a third currency is refused — the 10,000 BHD + 10,000 AED poison dies here', () => {
  const r = N.normalizeMoney({ amount: 10000, documentCurrency: 'AED', asOfDay: '2026-08-30' }, 'BHD', RATES);
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, 'CURRENCY_NOT_SUPPORTED');
  assert.strictEqual(r.documentCurrency, 'AED');
});
test('tenantCurrency is mandatory and throws when absent (R1 mirror)', () => {
  assert.throws(() => N.normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-30' }, undefined, RATES), /tenantCurrency is required/);
  assert.throws(() => N.normalizeMoney({ amount: 10, documentCurrency: 'BHD', asOfDay: '2026-08-30' }, '', RATES), /tenantCurrency is required/);
});
test('a non-finite amount is a wiring error and throws (parse stage must run first)', () => {
  assert.throws(() => N.normalizeMoney({ amount: '12.5', documentCurrency: 'USD', asOfDay: '2026-08-30' }, 'BHD', RATES), TypeError);
  assert.throws(() => N.normalizeMoney({ amount: NaN, documentCurrency: 'USD', asOfDay: '2026-08-30' }, 'BHD', RATES), TypeError);
});
test('a row with no currency code is MISSING_CURRENCY (data problem, not a throw)', () => {
  const r = N.normalizeMoney({ amount: 10, asOfDay: '2026-08-30' }, 'BHD', RATES);
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, 'MISSING_CURRENCY');
});
test('a USD-tenant ingesting USD rows needs no pin: USD is local to itself', () => {
  const r = N.normalizeMoney({ amount: 99, documentCurrency: 'USD', asOfDay: '2026-08-30' }, 'USD', { usdToLocalByDay: {} });
  assert.ok(r.ok);
  assert.strictEqual(r.rateSource, 'LOCAL');
  assert.strictEqual(r.tenantValue, 99);
});

/* ---- validateRateTable ---------------------------------------------------------- */
console.log('\nRate table validation (fail-closed)');

test('accepts a well-formed table and an empty pin map', () => {
  assert.strictEqual(N.validateRateTable(RATES), true);
  assert.strictEqual(N.validateRateTable({ usdToLocalByDay: {} }), true);
});
test('rejects zero, negative or non-finite rates', () => {
  assert.throws(() => N.validateRateTable({ usdToLocalByDay: { '2026-08-30': 0 } }), /positive finite/);
  assert.throws(() => N.validateRateTable({ usdToLocalByDay: { '2026-08-30': -0.5 } }), /positive finite/);
  assert.throws(() => N.validateRateTable({ usdToLocalByDay: { '2026-08-30': NaN } }), /positive finite/);
});
test('rejects a typo day key that would silently miss its pin', () => {
  assert.throws(() => N.validateRateTable({ usdToLocalByDay: { '2026-1-5': 0.376 } }), /YYYY-MM-DD/);
});
test('rejects a malformed table structure', () => {
  assert.throws(() => N.validateRateTable(null), TypeError);
  assert.throws(() => N.validateRateTable({}), /usdToLocalByDay/);
  assert.throws(() => N.validateRateTable({ usdToLocalByDay: [] }), TypeError);
});

/* ---- §14.6c — the Purchase Order Status surface ----------------------------------- */
console.log('\nPo-status normalization (§14.6c: closed vocabulary, degrade-or-quarantine)');

test('the vocabulary normalizes trim + case-fold', () => {
  assert.deepStrictEqual(N.normalizePoStatus('OPEN'), { ok: true, value: 'OPEN', degraded: false });
  assert.deepStrictEqual(N.normalizePoStatus(' cancelled '), { ok: true, value: 'CANCELLED', degraded: false });
  assert.deepStrictEqual(N.normalizePoStatus('Closed'), { ok: true, value: 'CLOSED', degraded: false });
});
test('absent or blank degrades to live — never an error, never a guess', () => {
  assert.strictEqual(N.normalizePoStatus(undefined).value, null);
  assert.strictEqual(N.normalizePoStatus(null).value, null);
  assert.strictEqual(N.normalizePoStatus('   ').value, null);
  assert.strictEqual(N.normalizePoStatus('').degraded, true);
});
test('present-but-unknown refuses by name — the INVALID_CONVERSION_FACTOR posture', () => {
  const r = N.normalizePoStatus('pending');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'PO_STATUS_UNKNOWN');
  assert.ok(/OPEN \| CANCELLED \| CLOSED/.test(r.detail));
  assert.strictEqual(N.normalizePoStatus(1).ok, false);
});

/* ---- summary --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
