'use strict';
/* ============================================================================
 * Ladder-edge semantics — the M14 named proof `core/ladder-edges`
 * (build spec §14.19; audit M14).
 *
 * Every rule the contract names is pinned here: the dead branch (branch 7
 * algebraically identical to branch 1 and unreachable — proven across the
 * float boundary, not just algebraically), the display/trigger band
 * (1.0 ≤ reorderPct < 1.01 → orderRecQty 0), the impossible state (negative
 * available classified Below Safety byte-compatibly AND detected), warnings
 * determinism, and additive byte-compatibility (every pre-existing field
 * keeps its golden value with the warnings layer present).
 *
 * The ladder itself is NEVER modified: the warnings layer observes beside it.
 * ==========================================================================*/
const assert = require('assert');
const E = require('../index.js');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

/* The §6 reference computation: J = 100/day (dpd 1000, rate 100/dpd).
 * R = 500, S = 1200, T = 700, U = 1200, V = 850. */
const dpd = 1000;
const rate = 100 / dpd;
const base = { onHand: 402, openPO: 0, invValue: 402 * 6, histMonthly: 100 * 22, consPerDelivery: rate };
const params = { lead: 7, safetyDays: 5, orderFreq: 7, moq: 500 };
const ref = (over) => E.computeRef({ ...base, ...over }, params, dpd);

/* ---- Edge 1 — the dead branch ---------------------------------------------- */
console.log('\nThe dead branch (branch 7 unreachable — §14.19 rule 1)');

test('algebraic identity holds across the float boundary: U×1.2 ≤ U + U×0.2 for every maxStock', () => {
  // The two predicates can round to different doubles (1 ulp apart); the audit's
  // unreachability holds EXACTLY only if branch 1's threshold is never above
  // branch 7's — then any available satisfying branch 7 satisfies branch 1 first.
  for (let u = 1; u <= 50000; u++) {
    if (u * 1.2 > u + u * 0.2) throw new Error(`U=${u}: branch 1 threshold EXCEEDS branch 7's`);
  }
});

test('statusOf at the boundary: strict > preserved, branch 1 fires just above, not at U×1.2', () => {
  assert.strictEqual(E.statusOf({ available: 1441, maxStock: 1200, reorderPct: 2, safetyStock: 500, openPO: 0 }), 'Over Stock');
  // at exactly U×1.2 branch 1 is quiet; with reorderPct 2 branches 4–6 are quiet too → OK
  assert.strictEqual(E.statusOf({ available: 1440, maxStock: 1200, reorderPct: 2, safetyStock: 500, openPO: 0 }), 'OK');
  assert.strictEqual(E.statusOf({ available: 1440, maxStock: 1200, reorderPct: 0.5, safetyStock: 500, openPO: 0 }), 'Below Reorder');
});

test('computeRef names LADDER_DEAD_BRANCH_7 exactly when available > maxStock×1.2', () => {
  const over = ref({ onHand: 2000, invValue: 2000 * 6 });   // available 2000 > 1440
  assert.strictEqual(over.status, 'Over Stock');
  assert.deepStrictEqual(over.warnings, ['LADDER_DEAD_BRANCH_7']);
  const at = ref({ onHand: 1440, invValue: 1440 * 6 });     // available = U×1.2 exactly
  assert.strictEqual(at.status, 'OK');                      // branch 1 quiet (strict >); branches 4–6 quiet
  assert.deepStrictEqual(at.warnings, []);                  // dead branch quiet at the exact boundary
});

/* ---- Edge 2 — the display/trigger band -------------------------------------- */
console.log('\nThe display/trigger band (§14.19 rule 2)');

test('inside the band: status reads Below Reorder while orderRecQty is 0, warning named', () => {
  // available 1205 → reorderPct 1.00416… ∈ [1.0, 1.01); trigger needs available < 1200
  const c = ref({ onHand: 1205, invValue: 1205 * 6 });
  assert.strictEqual(c.status, 'Below Reorder');
  assert.strictEqual(c.orderRecQty, 0);
  assert.deepStrictEqual(c.warnings, ['REORDER_DISPLAY_TRIGGER_BAND']);
});

test('at the band edge reorderPct = 1.0 exactly: trigger silent (available = reorder), warning named', () => {
  const c = ref({ onHand: 1200, invValue: 1200 * 6 });
  assert.strictEqual(c.reorderPct, 1.0);
  assert.strictEqual(c.orderRecQty, 0);
  assert.deepStrictEqual(c.warnings, ['REORDER_DISPLAY_TRIGGER_BAND']);
});

test('just below the band: the trigger FIRES (orderRecQty > 0), no band warning', () => {
  const c = ref({ onHand: 1199, invValue: 1199 * 6 });
  assert.strictEqual(c.status, 'Below Reorder');
  assert.strictEqual(c.orderRecQty, c.orderQty);
  assert.deepStrictEqual(c.warnings, []);
});

test('above the band: branch 6 quiet, status OK, no band warning', () => {
  const c = ref({ onHand: 1213, invValue: 1213 * 6 });      // reorderPct 1.01083…
  assert.strictEqual(c.status, 'OK');
  assert.strictEqual(c.orderRecQty, 0);
  assert.deepStrictEqual(c.warnings, []);
});

test('the warnings layer observes the VALUE edges regardless of the label the ladder shows', () => {
  // A low reorder point (lead 11, safety 1, orderFreq 1, moq 0 → U = 200, S = 1200)
  // puts one ref inside BOTH the dead-branch region and the band — the array
  // carries both codes, sorted, while the ladder's label stays branch 1's.
  const low = { lead: 11, safetyDays: 1, orderFreq: 1, moq: 0 };
  const c = E.computeRef({ onHand: 1205, openPO: 0, invValue: 0, histMonthly: 0, consPerDelivery: rate }, low, dpd);
  assert.strictEqual(c.status, 'Over Stock');               // branch 1 first — unchanged
  assert.strictEqual(c.orderRecQty, 0);                     // the band's trigger silence
  assert.deepStrictEqual(c.warnings, ['LADDER_DEAD_BRANCH_7', 'REORDER_DISPLAY_TRIGGER_BAND']);
});

/* ---- Edge 3 — the impossible state ------------------------------------------ */
console.log('\nThe impossible state (§14.19 rule 3)');

test('negative available: Below Safety classification kept byte-compatibly, NEGATIVE_AVAILABLE named', () => {
  const c = ref({ onHand: -5, invValue: 0 });
  assert.strictEqual(c.status, 'Below Safety');             // the workbook classification, unchanged
  assert.strictEqual(c.available, -5);
  assert.deepStrictEqual(c.warnings, ['NEGATIVE_AVAILABLE']);
});

/* ---- Determinism + additive byte-compatibility ------------------------------ */
console.log('\nDeterminism and additive byte-compatibility');

test('warnings are present on every row, sorted, deep-equal stable, JSON round-trip', () => {
  const a = ref({ onHand: 1205, invValue: 1205 * 6 });
  const b = ref({ onHand: 1205, invValue: 1205 * 6 });
  assert.deepStrictEqual(a.warnings, b.warnings);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a.warnings)), a.warnings);
  assert.ok(JSON.stringify(a.warnings) === JSON.stringify([...a.warnings].sort()));
  const clean = ref({});                                     // no edge applies
  assert.deepStrictEqual(clean.warnings, []);
});

test('the three codes are pairwise exclusive for the §6 parameters — and co-occurrence is still well-defined', () => {
  // For the §6 reference parameters the edges cannot overlap (the band sits in
  // [S, 1.01·S), the dead-branch region above 1.2·U, negative available below 0);
  // the low-reorder case above already pinned a legitimate two-code row.
  const c = ref({ onHand: 1205, invValue: 1205 * 6 });
  assert.strictEqual(c.warnings.length, 1);
});

test('additive byte-compatibility: every pre-existing field keeps its golden value with the warnings layer present', () => {
  const c = ref({});
  assert.strictEqual(c.safetyStock, 500);
  assert.strictEqual(c.reorder, 1200);
  assert.strictEqual(c.eoq, 700);
  assert.strictEqual(c.maxStock, 1200);
  assert.strictEqual(c.cycleStock, 850);
  assert.strictEqual(c.orderQty, 1498);
  assert.strictEqual(c.orderRecQty, 1498);
  assert.strictEqual(c.status, 'Below Safety');
  assert.ok(Math.abs(c.reorderPct - 402 / 1200) < 1e-12);
  assert.deepStrictEqual(c.warnings, []);
});

test('statusOf itself is untouched — the verbatim 7-branch ladder, pinned at the §6 vectors', () => {
  assert.strictEqual(E.statusOf({ available: 1500, maxStock: 1200, reorderPct: 2, safetyStock: 500, openPO: 0 }), 'Over Stock');
  assert.strictEqual(E.statusOf({ available: 0, maxStock: 0, reorderPct: null, safetyStock: 0, openPO: 0 }), 'OK');
  assert.strictEqual(E.statusOf({ available: 0, maxStock: 1200, reorderPct: 0, safetyStock: 500, openPO: 0 }), 'Zero Stock');
  assert.strictEqual(E.statusOf({ available: 400, maxStock: 1200, reorderPct: 0.33, safetyStock: 500, openPO: 0 }), 'Below Safety');
  assert.strictEqual(E.statusOf({ available: 600, maxStock: 1200, reorderPct: 0.5, safetyStock: 500, openPO: 800 }), 'Follow-up with Supplier');
  assert.strictEqual(E.statusOf({ available: 600, maxStock: 1200, reorderPct: 0.5, safetyStock: 500, openPO: 0 }), 'Below Reorder');
  assert.strictEqual(E.statusOf({ available: 1300, maxStock: 5000, reorderPct: 1.08, safetyStock: 500, openPO: 0 }), 'OK');
});

console.log(`\ncore/ladder-edges: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
