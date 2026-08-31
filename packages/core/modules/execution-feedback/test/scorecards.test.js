'use strict';
/* ============================================================================
 * The loop's second turn — supplier scorecards fed by matching (§14.6d).
 * The named proof `feedback/scorecard-matching-fed` (audit M4 scorecards).
 *
 * Every rule the contract names is pinned here: attribution follows the
 * DELIVERY (the line's actual supplier), the H2 due-line probe reproduced
 * through the FULL matching path (not on hand-built fixtures), cancelled
 * evidence excluded and disclosed, UNSOLICITED lines as evidence with the
 * honesty rules, the flag rollup additive, unattributed evidence a named
 * surface, the engine's OTIF semantics unchanged through composition, and
 * determinism. The engine `supplierScorecard` is composed, never re-implemented.
 * ==========================================================================*/
const assert = require('assert');
const { matchPoLines } = require('../src/matching.js');
const F = require('../src/feedback.js');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed += 1; }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* A realistic matching run: two proposals, two suppliers, one unsolicited
 * line — everything the contract talks about in one facts view. */
function buildMatched() {
  return matchPoLines({
    proposals: [
      { refId: 'R1', sku: 'FLOUR-1', supplier: 'Nile Perch Ltd', qty: 100, expectedUnitPrice: 2, raisedAt: '2026-08-01', poNumbers: ['PO-A'] },
      { refId: 'R2', sku: 'FLOUR-1', supplier: 'Maziwa Fresh', qty: 50, expectedUnitPrice: 2, raisedAt: '2026-08-02', poNumbers: ['PO-B'] },
    ],
    poLines: [
      { poNumber: 'PO-A', sku: 'FLOUR-1', ordered: 100, waiting: 0, received: 100, unitPrice: 2, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-B', sku: 'FLOUR-1', ordered: 50, waiting: 50, poCreationDate: '2026-08-04', expectedDelivery: '2026-08-20', supplierName: 'Maziwa Fresh' },
      { poNumber: 'PO-Z', sku: 'SALT-9', ordered: 40, waiting: 0, received: 40, poCreationDate: '2026-08-05', expectedDelivery: '2026-08-12', supplierName: 'Nile Perch Ltd' },
    ],
    events: [
      { poNumber: 'PO-A', sku: 'FLOUR-1', type: 'receipt', qty: 100, at: '2026-08-10', unitPrice: 2 },
      { poNumber: 'PO-Z', sku: 'SALT-9', type: 'receipt', qty: 40, at: '2026-08-13' },
    ],
    amendments: [],
  });
}

/* ---- attribution ------------------------------------------------------------ */
console.log('\nAttribution — the delivery, not the intent (§14.6d)');

test('evidence lands on the line supplier; the not-yet-due PO stays open', () => {
  const r = F.supplierScorecards(buildMatched());
  assert.deepStrictEqual(r.suppliers.map((s) => s.supplier), ['Maziwa Fresh', 'Nile Perch Ltd'], 'sorted by name');
  const nile = r.suppliers[1];
  assert.strictEqual(nile.dueLines, 2, 'the perfect FLOUR delivery + the unsolicited SALT delivery are due');
  assert.ok(near(nile.fillRate, 1.0));
  assert.strictEqual(nile.openLines, 0);
  const maziwa = r.suppliers[0];
  assert.strictEqual(maziwa.dueLines, 0, 'the open PO is not due — no receipts, promise in the future');
  assert.strictEqual(maziwa.openLines, 1);
  assert.strictEqual(maziwa.otif, null, 'no due lines — no fabricated score');
});
test("the audit's H2 probe through the FULL matching path: one perfect + one in-flight PO reads fill 1.0, never 0.5", () => {
  const r = F.supplierScorecards(buildMatched());
  const maziwa = r.suppliers[0];
  assert.strictEqual(maziwa.dueLines, 0, 'the in-flight PO has no receipt — not due, excluded');
  assert.strictEqual(maziwa.fillRate, null, 'no due evidence — no fabricated score');
  const nile = r.suppliers[1];
  assert.ok(near(nile.fillRate, 1.0), 'the perfect supplier is not deflated by in-flight POs');
});
test('a split across two POs of one supplier: both lines’ evidence lands; the topology flag stays on the proposal aggregate', () => {
  const matched = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'RICE-1', qty: 200, raisedAt: '2026-08-01', poNumbers: ['PO-1', 'PO-2'] }],
    poLines: [
      { poNumber: 'PO-1', sku: 'RICE-1', ordered: 120, waiting: 0, received: 120, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-2', sku: 'RICE-1', ordered: 80, waiting: 0, received: 80, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-12', supplierName: 'Nile Perch Ltd' },
    ],
    events: [
      { poNumber: 'PO-1', sku: 'RICE-1', type: 'receipt', qty: 120, at: '2026-08-10' },
      { poNumber: 'PO-2', sku: 'RICE-1', type: 'receipt', qty: 80, at: '2026-08-12' },
    ],
  });
  const r = F.supplierScorecards(matched);
  const nile = r.suppliers[0];
  assert.strictEqual(nile.dueLines, 2);
  assert.ok(near(nile.fillRate, 1.0));
  assert.strictEqual(nile.flagCounts.SPLIT_ACROSS_POS, undefined, 'the split names the buyer’s task, not the supplier — it lives on the aggregate');
  assert.ok(matched.proposals[0].flags.includes('SPLIT_ACROSS_POS'), 'and it is still on the aggregate, not lost');
});
test('SUPPLIER_CHANGED: the scorecard measures who DELIVERED; the deviation flag rides where it happened', () => {
  const matched = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'OIL-1', supplier: 'Maziwa Fresh', qty: 60, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'OIL-1', ordered: 60, waiting: 0, received: 60, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' }],
    events: [{ poNumber: 'PO-A', sku: 'OIL-1', type: 'receipt', qty: 60, at: '2026-08-10' }],
  });
  const r = F.supplierScorecards(matched);
  assert.deepStrictEqual(r.suppliers.map((s) => s.supplier), ['Nile Perch Ltd'], 'only the actual supplier holds evidence');
  assert.strictEqual(r.suppliers[0].flagCounts.SUPPLIER_CHANGED, 1, 'the deviation is disclosed on the card that delivered');
});

/* ---- cancelled ---------------------------------------------------------------- */
console.log('\nCancelled evidence — never due, never vanished');

test('a cancelled line falls out of the denominators and is disclosed', () => {
  const matched = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'RICE-1', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [
      { poNumber: 'PO-A', sku: 'RICE-1', ordered: 100, waiting: 100, status: 'CANCELLED', poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-B', sku: 'RICE-1', ordered: 100, waiting: 0, received: 100, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
    ],
    events: [{ poNumber: 'PO-B', sku: 'RICE-1', type: 'receipt', qty: 100, at: '2026-08-10' }],
  });
  const r = F.supplierScorecards(matched);
  const nile = r.suppliers[0];
  assert.strictEqual(nile.dueLines, 1, 'the cancelled promise is not evidence');
  assert.ok(near(nile.fillRate, 1.0), 'the live delivery carries the score alone');
  assert.strictEqual(nile.cancelledLines, 1, 'the exclusion is disclosed, not vanished');
  assert.strictEqual(nile.flagCounts.PO_CANCELLED, 1);
});
test('receipts after cancellation are visible on the card (RECEIPTS_AFTER_CANCEL) and still not due', () => {
  const matched = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'RICE-1', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'RICE-1', ordered: 100, waiting: 40, status: 'CANCELLED', poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' }],
    events: [{ poNumber: 'PO-A', sku: 'RICE-1', type: 'receipt', qty: 60, at: '2026-08-12' }],
  });
  const r = F.supplierScorecards(matched);
  const nile = r.suppliers[0];
  assert.strictEqual(nile.dueLines, 0);
  assert.strictEqual(nile.cancelledLines, 1);
  assert.strictEqual(nile.flagCounts.RECEIPTS_AFTER_CANCEL, 1, 'the anomaly is reportable');
});

/* ---- unsolicited ---------------------------------------------------------------- */
console.log('\nUNSOLICITED evidence — a real delivery is a fact');

test('an unsolicited delivery is due evidence: net fill, honest lateness, UNSOLICITED disclosed', () => {
  const matched = matchPoLines({
    proposals: [],
    poLines: [{ poNumber: 'PO-Z', sku: 'SALT-9', ordered: 40, waiting: 0, received: 40, poCreationDate: '2026-08-05', expectedDelivery: '2026-08-12', supplierName: 'Nile Perch Ltd' }],
    events: [{ poNumber: 'PO-Z', sku: 'SALT-9', type: 'receipt', qty: 40, at: '2026-08-13' }],
  });
  const r = F.supplierScorecards(matched);
  const nile = r.suppliers[0];
  assert.strictEqual(nile.dueLines, 1);
  assert.ok(near(nile.fillRate, 1.0));
  assert.strictEqual(nile.unsolicitedLines, 1);
  assert.strictEqual(nile.flagCounts.UNSOLICITED, 1);
  assert.strictEqual(nile.flagCounts.LATE, 1, 'arrived a day past the promise — visible');
});
test('unsolicited price honesty: no expected price exists, so priceAdherence stays null', () => {
  const matched = matchPoLines({
    proposals: [],
    poLines: [{ poNumber: 'PO-Z', sku: 'SALT-9', ordered: 40, waiting: 0, received: 40, poCreationDate: '2026-08-05', expectedDelivery: '2026-08-12', supplierName: 'Nile Perch Ltd' }],
    events: [{ poNumber: 'PO-Z', sku: 'SALT-9', type: 'receipt', qty: 40, at: '2026-08-13' }],
  });
  const nile = F.supplierScorecards(matched).suppliers[0];
  assert.strictEqual(nile.priceAdherence, null, 'never a fabricated zero-variance');
});
test('an unsolicited line with no promised date cannot be late — open, still disclosed', () => {
  const matched = matchPoLines({
    proposals: [],
    poLines: [{ poNumber: 'PO-Z', sku: 'SALT-9', ordered: 40, waiting: 0, received: 40, poCreationDate: '2026-08-05', supplierName: 'Nile Perch Ltd' }],
    events: [{ poNumber: 'PO-Z', sku: 'SALT-9', type: 'receipt', qty: 40, at: '2026-08-13' }],
  });
  const nile = F.supplierScorecards(matched).suppliers[0];
  assert.strictEqual(nile.dueLines, 0);
  assert.strictEqual(nile.openLines, 1);
  assert.strictEqual(nile.unsolicitedLines, 1);
});

/* ---- returns, flags, refusals, determinism -------------------------------------- */
console.log('\nReturns, the flag rollup, refusals, determinism');

test('GOODS_RETURNED rides the card: fill is net, the flag is visible', () => {
  const matched = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'OIL-1', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'OIL-1', ordered: 100, waiting: 10, received: 90, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Maziwa Fresh' }],
    events: [
      { poNumber: 'PO-A', sku: 'OIL-1', type: 'receipt', qty: 100, at: '2026-08-10' },
      { poNumber: 'PO-A', sku: 'OIL-1', type: 'return', qty: 10, at: '2026-08-11' },
    ],
  });
  const maziwa = F.supplierScorecards(matched).suppliers[0];
  assert.ok(near(maziwa.fillRate, 0.9));
  assert.strictEqual(maziwa.flagCounts.GOODS_RETURNED, 1);
  assert.strictEqual(maziwa.flagCounts.SHORT_DELIVERED, 1, 'net fill re-syncs the derived flags');
});
test('the flag rollup counts across evidence lines', () => {
  const matched = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'RICE-1', qty: 300, raisedAt: '2026-08-01', poNumbers: ['PO-1', 'PO-2'] }],
    poLines: [
      { poNumber: 'PO-1', sku: 'RICE-1', ordered: 150, waiting: 0, received: 120, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-2', sku: 'RICE-1', ordered: 150, waiting: 0, received: 120, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
    ],
    events: [
      { poNumber: 'PO-1', sku: 'RICE-1', type: 'receipt', qty: 120, at: '2026-08-11' },
      { poNumber: 'PO-2', sku: 'RICE-1', type: 'receipt', qty: 120, at: '2026-08-11' },
    ],
  });
  const nile = F.supplierScorecards(matched).suppliers[0];
  assert.strictEqual(nile.flagCounts.SHORT_DELIVERED, 2);
  assert.strictEqual(nile.flagCounts.LATE, 2);
});
test('a line naming no supplier lands in unattributed — never a guess, never dropped', () => {
  const matched = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'OIL-1', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'OIL-1', ordered: 100, waiting: 0, received: 100, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' }],
    events: [{ poNumber: 'PO-A', sku: 'OIL-1', type: 'receipt', qty: 100, at: '2026-08-10' }],
  });
  const r = F.supplierScorecards(matched);
  assert.deepStrictEqual(r.suppliers, [], 'no supplier entry is fabricated');
  assert.strictEqual(r.unattributedLines, 1);
});
test('WIRING_MALFORMED — the wiring consumes a matching result, raw evidence refuses', () => {
  assert.throws(() => F.supplierScorecards({ lines: 'nope' }), /WIRING_MALFORMED/);
  assert.throws(() => F.supplierScorecards({}), /WIRING_MALFORMED/);
  assert.throws(() => F.supplierScorecards({ lines: [{ supplier: 'X' }] }), /WIRING_MALFORMED/);
  assert.throws(() => F.supplierScorecards(null), /WIRING_MALFORMED/);
});
test('the engine unchanged through composition: OTIF is on-time AND in-full', () => {
  const matched = matchPoLines({
    proposals: [
      { refId: 'R1', sku: 'RICE-1', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-1'] },
      { refId: 'R2', sku: 'RICE-1', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-2'] },
    ],
    poLines: [
      { poNumber: 'PO-1', sku: 'RICE-1', ordered: 100, waiting: 0, received: 70, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-2', sku: 'RICE-1', ordered: 100, waiting: 0, received: 100, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
    ],
    events: [
      { poNumber: 'PO-1', sku: 'RICE-1', type: 'receipt', qty: 70, at: '2026-08-10' },
      { poNumber: 'PO-2', sku: 'RICE-1', type: 'receipt', qty: 100, at: '2026-08-12' },
    ],
  });
  const nile = F.supplierScorecards(matched).suppliers[0];
  assert.ok(near(nile.onTimeRate, 0.5));
  assert.ok(near(nile.inFullRate, 0.5));
  assert.ok(near(nile.otif, 0.0), 'neither line is both — the average of the two would lie');
  assert.strictEqual(nile.avgLateDays, 2, 'line PO-2 arrived two days late');
});
test('determinism: sorted suppliers, deep-equal on identical inputs, JSON round-trip', () => {
  const a = F.supplierScorecards(buildMatched());
  const b = F.supplierScorecards(buildMatched());
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
  const names = a.suppliers.map((s) => s.supplier);
  assert.deepStrictEqual(names, [...names].sort(), 'suppliers sorted by name (code-unit order)');
});
test('an empty matching result yields an empty register — nothing invented', () => {
  const r = F.supplierScorecards(matchPoLines({ proposals: [], poLines: [], events: [], amendments: [] }));
  assert.deepStrictEqual(r, { suppliers: [], unattributedLines: 0 });
});

console.log(`\n  feedback/scorecard-matching-fed: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
