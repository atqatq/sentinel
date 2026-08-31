'use strict';
/* ============================================================================
 * Supply-status producer tests — the M5 named proof
 * `ingestion/supply-status-producers` (build spec §14.6c; audit M5).
 *
 * Every rule the contract names is pinned here: liveness (cancelled/closed
 * leave the loop, dead waiting is disclosed), the sums (openPO live-only,
 * overdue against an explicit asOf, partial on received>0), the banned-
 * supplier flag (live lines only), the unpromised disclosure, the refusal
 * family, and determinism. The classifier composition runs the REAL
 * E.supplyStatus — one vocabulary, no forked classification.
 * ==========================================================================*/
const assert = require('assert');
const E = require('../index.js');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

const line = (over) => ({
  poNumber: 'PO-1', sku: 'S1', waiting: 100, ...over,
});

/* ---- the sums --------------------------------------------------------------- */
console.log('\nLive-line sums (§14.6c rules)');

test('no lines → zero facts, no flags', () => {
  assert.deepStrictEqual(E.deriveSupplyFacts({ lines: [], asOf: '2026-03-01' }), {
    openPO: 0, overduePO: 0, partialPO: 0, supplierIssue: false,
    cancelledLines: 0, cancelledWaiting: 0, closedLines: 0, closedWaiting: 0,
    unpromisedLines: 0, unpromisedWaiting: 0,
  });
});
test('openPO sums live waiting; absent status degrades to live', () => {
  const f = E.deriveSupplyFacts({ lines: [line(), line({ poNumber: 'PO-2', waiting: 50 })], asOf: '2026-03-01' });
  assert.strictEqual(f.openPO, 150);
});
test('overdue: promised strictly before asOf counts; the asOf day itself does not', () => {
  const f = E.deriveSupplyFacts({ lines: [
    line({ poNumber: 'PO-A', expectedDelivery: '2026-02-28' }),
    line({ poNumber: 'PO-B', expectedDelivery: '2026-03-01' }),   // asOf day — not late yet
    line({ poNumber: 'PO-C', expectedDelivery: '2026-03-02' }),
  ], asOf: '2026-03-01' });
  assert.strictEqual(f.overduePO, 100);
});
test('partial: received > 0 with waiting > 0; received absent is not partial; a fully-received line (waiting 0) is not partial', () => {
  const f = E.deriveSupplyFacts({ lines: [
    line({ poNumber: 'PO-A', received: 40 }),
    line({ poNumber: 'PO-B' }),
    line({ poNumber: 'PO-C', received: 50, waiting: 0 }),
  ], asOf: '2026-03-01' });
  assert.strictEqual(f.partialPO, 100);
});
test('one line can be overdue AND partial — the sums are independent facts', () => {
  const f = E.deriveSupplyFacts({ lines: [line({ expectedDelivery: '2026-01-15', received: 30 })], asOf: '2026-03-01' });
  assert.strictEqual(f.openPO, 100);
  assert.strictEqual(f.overduePO, 100);
  assert.strictEqual(f.partialPO, 100);
});

/* ---- liveness --------------------------------------------------------------- */
console.log('\nLiveness — cancelled and closed lines leave the loop');

test('CANCELLED lines contribute nothing; dead waiting is disclosed', () => {
  const f = E.deriveSupplyFacts({ lines: [
    line({ poNumber: 'PO-A', status: 'OPEN' }),
    line({ poNumber: 'PO-B', status: 'CANCELLED', expectedDelivery: '2026-01-01', received: 5, supplierBanned: true }),
  ], asOf: '2026-03-01' });
  assert.strictEqual(f.openPO, 100);
  assert.strictEqual(f.overduePO, 0, 'a dead promise is not a late one');
  assert.strictEqual(f.partialPO, 0);
  assert.strictEqual(f.supplierIssue, false, 'a banned supplier on a DEAD line does not raise the flag');
  assert.strictEqual(f.cancelledLines, 1);
  assert.strictEqual(f.cancelledWaiting, 100);
});
test('CLOSED lines contribute nothing; closed waiting is disclosed', () => {
  const f = E.deriveSupplyFacts({ lines: [
    line({ poNumber: 'PO-A' }),
    line({ poNumber: 'PO-B', status: 'CLOSED', waiting: 30 }),
    line({ poNumber: 'PO-C', status: 'CLOSED', waiting: 0 }),   // honest closure: no disclosure
  ], asOf: '2026-03-01' });
  assert.strictEqual(f.openPO, 100);
  assert.strictEqual(f.closedLines, 2);
  assert.strictEqual(f.closedWaiting, 30);
});
test('unpromised live waiting: counts in openPO, never in overdue, disclosed', () => {
  const f = E.deriveSupplyFacts({ lines: [line()], asOf: '2026-03-01' });
  assert.strictEqual(f.openPO, 100);
  assert.strictEqual(f.overduePO, 0);
  assert.strictEqual(f.unpromisedLines, 1);
  assert.strictEqual(f.unpromisedWaiting, 100);
});
test('supplierIssue: any LIVE line from a banned supplier raises the flag', () => {
  const f = E.deriveSupplyFacts({ lines: [line({ supplierBanned: true })], asOf: '2026-03-01' });
  assert.strictEqual(f.supplierIssue, true);
});
test('supplierBanned absent is not banned', () => {
  const f = E.deriveSupplyFacts({ lines: [line()], asOf: '2026-03-01' });
  assert.strictEqual(f.supplierIssue, false);
});

/* ---- classifier composition (the REAL vocabulary, unchanged) ---------------- */
console.log('\nClassifier composition — E.supplyStatus over the produced facts');

test('overdue live waiting classifies Late PO', () => {
  const f = E.deriveSupplyFacts({ lines: [line({ expectedDelivery: '2026-01-15' })], asOf: '2026-03-01' });
  assert.strictEqual(E.supplyStatus(f), 'Late PO');
});
test('partial without lateness classifies Partial Delivery', () => {
  const f = E.deriveSupplyFacts({ lines: [line({ received: 30 })], asOf: '2026-03-01' });
  assert.strictEqual(E.supplyStatus(f), 'Partial Delivery');
});
test('banned supplier outranks lateness (Supplier Issue first)', () => {
  const f = E.deriveSupplyFacts({ lines: [line({ expectedDelivery: '2026-01-15', supplierBanned: true })], asOf: '2026-03-01' });
  assert.strictEqual(E.supplyStatus(f), 'Supplier Issue');
});
test('live waiting without findings classifies Follow-up with Supplier; nothing live is Normal', () => {
  const f = E.deriveSupplyFacts({ lines: [line()], asOf: '2026-03-01' });
  assert.strictEqual(E.supplyStatus(f), 'Follow-up with Supplier');
  assert.strictEqual(E.supplyStatus(E.deriveSupplyFacts({ lines: [], asOf: '2026-03-01' })), 'Normal');
});

/* ---- refusal family (fail-closed) ------------------------------------------ */
console.log('\nRefusals — a wiring error is loud, never guessed');

test('ASOF_REQUIRED — the producer owns no clock', () => {
  assert.throws(() => E.deriveSupplyFacts({ lines: [] }), /ASOF_REQUIRED/);
  assert.throws(() => E.deriveSupplyFacts({ lines: [], asOf: null }), /ASOF_REQUIRED/);
});
test('ASOF_INVALID — non-canonical or impossible dates refuse', () => {
  assert.throws(() => E.deriveSupplyFacts({ lines: [], asOf: '20260301' }), /ASOF_INVALID/);
  assert.throws(() => E.deriveSupplyFacts({ lines: [], asOf: '2026-3-1' }), /ASOF_INVALID/);
  assert.throws(() => E.deriveSupplyFacts({ lines: [], asOf: '2026-02-30' }), /ASOF_INVALID/);
});
test('LINE_MALFORMED — missing identity, non-boolean flag, non-array lines', () => {
  assert.throws(() => E.deriveSupplyFacts({ lines: [{ sku: 'S1', waiting: 1 }], asOf: '2026-03-01' }), /LINE_MALFORMED/);
  assert.throws(() => E.deriveSupplyFacts({ lines: [line({ supplierBanned: 1 })], asOf: '2026-03-01' }), /LINE_MALFORMED/);
  assert.throws(() => E.deriveSupplyFacts({ lines: 'nope', asOf: '2026-03-01' }), /LINES_MALFORMED/);
});
test('LINE_QTY_INVALID — negative or non-finite waiting; negative received', () => {
  assert.throws(() => E.deriveSupplyFacts({ lines: [line({ waiting: -5 })], asOf: '2026-03-01' }), /LINE_QTY_INVALID/);
  assert.throws(() => E.deriveSupplyFacts({ lines: [line({ waiting: null })], asOf: '2026-03-01' }), /LINE_QTY_INVALID/);
  assert.throws(() => E.deriveSupplyFacts({ lines: [line({ received: -1 })], asOf: '2026-03-01' }), /LINE_QTY_INVALID/);
});
test('LINE_STATUS_UNKNOWN — the vocabulary is closed', () => {
  assert.throws(() => E.deriveSupplyFacts({ lines: [line({ status: 'pending' })], asOf: '2026-03-01' }), /LINE_STATUS_UNKNOWN/);
  assert.throws(() => E.deriveSupplyFacts({ lines: [line({ status: 1 })], asOf: '2026-03-01' }), /LINE_STATUS_UNKNOWN/);
});
test('LINE_DATE_INVALID — non-canonical or impossible promised dates refuse', () => {
  assert.throws(() => E.deriveSupplyFacts({ lines: [line({ expectedDelivery: '2026-3-1' })], asOf: '2026-03-01' }), /LINE_DATE_INVALID/);
  assert.throws(() => E.deriveSupplyFacts({ lines: [line({ expectedDelivery: '2026-02-30' })], asOf: '2026-03-01' }), /LINE_DATE_INVALID/);
});
test('LINE_DUPLICATE — the (poNumber, sku) identity must stay unique', () => {
  assert.throws(() => E.deriveSupplyFacts({ lines: [line(), line()], asOf: '2026-03-01' }), /LINE_DUPLICATE/);
});

/* ---- determinism ------------------------------------------------------------ */
console.log('\nDeterminism');

test('identical inputs produce deep-equal output; the receipt survives a JSON round-trip', () => {
  const lines = [
    line({ poNumber: 'PO-A', expectedDelivery: '2026-01-15', received: 30 }),
    line({ poNumber: 'PO-B', status: 'CANCELLED', waiting: 40 }),
    line({ poNumber: 'PO-C', supplierBanned: true }),
  ];
  const a = E.deriveSupplyFacts({ lines, asOf: '2026-03-01' });
  const b = E.deriveSupplyFacts({ lines, asOf: '2026-03-01' });
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
