'use strict';
/* ============================================================================
 * The loop's learning turn — efficacy signals fed by matching (§14.6e).
 * The named proof `feedback/efficacy-matching-fed` (audit M3 efficacy).
 *
 * Every rule the contract names is pinned here: the M3 sample floor and
 * confidence grade standing through the wiring, only FOLLOWED judged, the
 * proposal as the unit of judgment (a split commitment is ONE entry), the
 * strict-boolean observation join with the observed/unobserved disclosure,
 * CANCELLED disclosed never judged, UNSOLICITED never entering proposal-level
 * efficacy, recall riding the same join (the missedShortages dangerous
 * class), unmatched observations a named surface, lead time from observed
 * reality, the flag rollup on the aggregates' own axes, the refusal family,
 * and determinism. The engines are composed, never re-implemented.
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
const throws = (fn, code) => {
  try { fn(); } catch (e) { return e.message.includes(code); }
  return false;
};

/* A realistic matching run: six proposals covering every outcome the loop
 * produces, plus one unsolicited line the engine never advised. */
function buildMatched() {
  return matchPoLines({
    proposals: [
      { refId: 'R1', sku: 'FLOUR-1', qty: 100, expectedUnitPrice: 2, raisedAt: '2026-08-01', poNumbers: ['PO-A'] },
      { refId: 'R2', sku: 'FLOUR-1', qty: 20, raisedAt: '2026-08-19', asOf: '2026-08-20', slaDays: 3, poNumbers: [] },
      { refId: 'R3', sku: 'FLOUR-1', qty: 30, raisedAt: '2026-08-01', poNumbers: ['PO-D'] },
      { refId: 'R4', sku: 'FLOUR-1', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-B', 'PO-C'] },
      { refId: 'R5', sku: 'SALT-9', qty: 15, raisedAt: '2026-08-01', asOf: '2026-08-20', poNumbers: [] },
      { refId: 'R6', sku: 'SALT-9', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-F'] },
    ],
    poLines: [
      { poNumber: 'PO-A', sku: 'FLOUR-1', ordered: 100, waiting: 0, received: 100, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-B', sku: 'FLOUR-1', ordered: 60, waiting: 0, received: 60, poCreationDate: '2026-08-04', expectedDelivery: '2026-08-12', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-C', sku: 'FLOUR-1', ordered: 40, waiting: 0, received: 40, poCreationDate: '2026-08-05', expectedDelivery: '2026-08-14', supplierName: 'Maziwa Fresh' },
      { poNumber: 'PO-D', sku: 'FLOUR-1', ordered: 30, waiting: 0, received: 0, status: 'CANCELLED', poCreationDate: '2026-08-03', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-F', sku: 'SALT-9', ordered: 60, waiting: 0, received: 60, poCreationDate: '2026-08-06', expectedDelivery: '2026-08-13', supplierName: 'Maziwa Fresh' },
      { poNumber: 'PO-Z', sku: 'SALT-9', ordered: 40, waiting: 0, received: 40, poCreationDate: '2026-08-05', expectedDelivery: '2026-08-12', supplierName: 'Nile Perch Ltd' },
    ],
    events: [
      { poNumber: 'PO-A', sku: 'FLOUR-1', type: 'receipt', qty: 100, at: '2026-08-10' },
      { poNumber: 'PO-B', sku: 'FLOUR-1', type: 'receipt', qty: 60, at: '2026-08-12' },
      { poNumber: 'PO-C', sku: 'FLOUR-1', type: 'receipt', qty: 40, at: '2026-08-14' },
      { poNumber: 'PO-F', sku: 'SALT-9', type: 'receipt', qty: 60, at: '2026-08-13' },
      { poNumber: 'PO-Z', sku: 'SALT-9', type: 'receipt', qty: 40, at: '2026-08-13' },
    ],
    amendments: [],
  });
}

/* The outcome map of buildMatched(): R1 FOLLOWED (lead 7), R2 PENDING,
 * R3 CANCELLED, R4 FOLLOWED + SPLIT_ACROSS_POS (lead 10), R5 IGNORED,
 * R6 MODIFIED (adherence 0.6 → DEVIATION_UNEXPLAINED, lead 7). PO-Z is
 * unsolicited and answers to no proposal. */

/* Hand-built aggregates of the exact §14.6 shape — for floor arithmetic that
 * would otherwise need a dozen PO fixtures. */
function agg(refId, outcome, flags, realizedLeadDays) {
  return { refId, outcome, adherenceQty: 1, receivedQty: 100, fillRate: 1,
           realizedLeadDays: realizedLeadDays == null ? null : realizedLeadDays,
           lateByDays: null, priceVariance: null, priceVariancePct: null,
           flags: flags || [], linesCancelled: 0, linesLive: 1 };
}
function followN(n, opts) {
  const o = opts || {};
  return Array.from({ length: n }, (_, i) =>
    agg(`R${String(i).padStart(2, '0')}`, 'FOLLOWED',
        o.stocked != null && i < o.stocked ? ['LATE'] : [], o.lead));
}

/* ---- the M3 gate stands through the wiring -------------------------------- */
console.log('\nThe M3 gate — sample floor and confidence grade through the wiring');

test('eleven followed refs with 55% stockouts raise no signal, confidence insufficient', () => {
  const m = { proposals: followN(11, { stocked: 6 }) };       // 6/11 ≈ 55% > 20%
  const obs = m.proposals.filter((_, i) => i < 6)
    .map((a) => ({ refId: a.refId, stockedOutAfter: true }));
  const r = F.efficacySignals(m, obs);
  assert.deepStrictEqual(r.efficacy.signals, []);
  assert.strictEqual(r.efficacy.confidence, 'insufficient');
  assert.strictEqual(r.efficacy.followed, 11);
});

test('the twelfth followed ref lets the signal fire — confidence medium', () => {
  const m = { proposals: followN(12, { stocked: 6 }) };
  const obs = m.proposals.filter((_, i) => i < 6)
    .map((a) => ({ refId: a.refId, stockedOutAfter: true }));
  const r = F.efficacySignals(m, obs);
  assert.ok(r.efficacy.signals.some((s) => s.param === 'safetyDays' && s.direction === 'increase'));
  assert.strictEqual(r.efficacy.confidence, 'medium');
  assert.strictEqual(r.efficacy.minSample, 12);
});

test('a stockout after IGNORED advice is not blamed on the parameters', () => {
  const m = { proposals: [...followN(12, { stocked: 0 }),
    ...Array.from({ length: 5 }, (_, i) => agg(`X${i}`, 'IGNORED', ['NO_COMMITMENT']))] };
  const obs = m.proposals.filter((a) => a.outcome === 'IGNORED')
    .map((a) => ({ refId: a.refId, stockedOutAfter: true }));
  const r = F.efficacySignals(m, obs);
  assert.strictEqual(r.efficacy.followed, 12);
  assert.strictEqual(r.efficacy.stockoutsAfterFollow, 0);
  assert.deepStrictEqual(r.efficacy.signals, []);
});

/* ---- the proposal is the unit of judgment --------------------------------- */
console.log('\nOne proposal, one judgment (§14.6e)');

test('a proposal split across two POs is ONE judgment with SPLIT_ACROSS_POS as its fact', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, []);
  assert.strictEqual(m.proposals.length, 6);
  assert.strictEqual(r.efficacy.n, 6);            // R1..R6 — never per-line
  assert.strictEqual(r.flagCounts.SPLIT_ACROSS_POS, 1);
});

test('an UNSOLICITED delivery never enters proposal-level efficacy', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, []);
  assert.strictEqual(m.unlinked.length, 1);        // PO-Z is real evidence
  assert.strictEqual(r.efficacy.n, 6);             // — but it is not advice
  assert.strictEqual(r.efficacy.followed, 2);      // R1, R4
});

test('a CANCELLED proposal is disclosed, never judged', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, []);
  assert.strictEqual(r.cancelledProposals, 1);     // R3 — visible
  assert.strictEqual(r.efficacy.followed, 2);      // — and not advice followed
  assert.strictEqual(r.flagCounts.PO_CANCELLED, 1);
});

test('PENDING rides its leaf outcome; IGNORED past SLA counts in decided', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, []);
  assert.strictEqual(r.quality.pending, 1);        // R2, inside the SLA
  assert.strictEqual(r.quality.decided, 5);        // R1, R3, R4, R5, R6
  assert.strictEqual(r.quality.acted, 4);          // decided minus IGNORED (R5)
  assert.ok(near(r.quality.actedRate, 0.8));
});

/* ---- the join is inventory's, not matching's ------------------------------ */
console.log('\nThe observation join — strict, disclosed, honest');

test('a missing observation is unobserved, never silently clean', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, [
    { refId: 'R1', stockedOutAfter: true },
    { refId: 'R4', overstockedAfter: true },
    { refId: 'R6', overstockedAfter: true },
  ]);
  assert.strictEqual(r.observed, 3);
  assert.strictEqual(r.unobserved, 3);             // R2, R3, R5 — disclosed
  assert.strictEqual(r.efficacy.stockoutsAfterFollow, 1);   // R1 — FOLLOWED, so judged
});

test('no observations at all is honest — everything unobserved, no stockout events', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, null);
  assert.strictEqual(r.observed, 0);
  assert.strictEqual(r.unobserved, 6);
  assert.strictEqual(r.quality.stockouts, 0);
  assert.strictEqual(r.quality.recall, null);
  assert.deepStrictEqual(r.efficacy.signals, []);  // nothing judged unjudged
});

test('an observation naming no proposal is unmatched; its stockout is the missedShortage class', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, [
    { refId: 'R1', stockedOutAfter: true },
    { refId: 'GHOST-2', overstockedAfter: true },
    { refId: 'GHOST-1', stockedOutAfter: true },
  ]);
  assert.strictEqual(r.unmatchedObservations, 2);  // named, never silent
  assert.strictEqual(r.quality.missedShortages, 1);// GHOST-1 — the dangerous class
  assert.deepStrictEqual(r.quality.missedRefs, ['GHOST-1']);
  assert.ok(near(r.quality.recall, 0.5));          // 1 warned of 2 stockouts
});

test('overstock rides efficacy; it is not a stockout event', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, [
    { refId: 'R1', stockedOutAfter: false, overstockedAfter: true },
    { refId: 'R4', stockedOutAfter: false, overstockedAfter: true },
  ]);
  assert.strictEqual(r.quality.stockouts, 0);
  assert.strictEqual(r.efficacy.overstockAfterFollow, 2);
  assert.strictEqual(r.efficacy.stockoutsAfterFollow, 0);
});

/* ---- additive signals ------------------------------------------------------ */
console.log('\nThe flag rollup — the aggregates\' own axes');

test('the rollup rides the proposal aggregates — leaf-derived and topology facts', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, []);
  assert.strictEqual(r.flagCounts.PENDING_DECISION, 1);       // R2
  assert.strictEqual(r.flagCounts.NO_COMMITMENT, 1);          // R5
  /* DEVIATION_UNEXPLAINED on two proposals, each once: R4 — the split's
   * per-line leaf outcomes read MODIFIED-unexplained against the whole-proposal
   * qty (the as-built §14.6b leaf semantics), R6 — the unexplained 0.6
   * adherence; the builder's own push cannot duplicate the rec-raised flag. */
  assert.strictEqual(r.flagCounts.DEVIATION_UNEXPLAINED, 2);
  assert.strictEqual(r.flagCounts.SPLIT_ACROSS_POS, 1);       // R4
  assert.strictEqual(r.flagCounts.PO_CANCELLED, 1);           // R3
  assert.strictEqual(Object.keys(r.flagCounts).length, 5);
});

test('a line-level fact that cannot name exactly one proposal is never fused onto one', () => {
  const m = matchPoLines({
    proposals: [
      { refId: 'R1', sku: 'FLOUR-1', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] },
    ],
    poLines: [
      { poNumber: 'PO-A', sku: 'FLOUR-1', ordered: 100, waiting: 0, received: 100, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-10', supplierName: 'Nile Perch Ltd' },
    ],
    events: [{ poNumber: 'PO-A', sku: 'FLOUR-1', type: 'receipt', qty: 100, at: '2026-08-10' }],
    amendments: [{ poNumber: 'PO-A', sku: 'FLOUR-1', field: 'ordered', from: 100, to: 100, amendedAt: '2026-08-06' }],  // unexplained
  });
  const line = m.lines[0];
  assert.ok(line.flags.includes('AMENDMENT_UNEXPLAINED'));     // the §14.6b line fact stands
  const r = F.efficacySignals(m, []);
  assert.strictEqual(r.flagCounts.AMENDMENT_UNEXPLAINED, undefined); // — and stays there
  assert.strictEqual(r.efficacy.followed, 1);                  // R1 is still FOLLOWED
});

/* ---- lead time from observed reality --------------------------------------- */
console.log('\nLead time — the p80 canon over the realized spans');

test('leadTime rides the aggregates\' realizedLeadDays — p80 basis, confidence low at n=3', () => {
  const m = buildMatched();
  const r = F.efficacySignals(m, []);
  assert.strictEqual(r.leadTime.n, 3);             // R1 7, R4 10, R6 7
  assert.strictEqual(r.leadTime.suggested, 7);     // p80 of [7,7,10]
  assert.strictEqual(r.leadTime.confidence, 'low');
  assert.strictEqual(r.leadTime.basis, 'p80');
});

test('lead time is never invented from no data', () => {
  const m = { proposals: [agg('R1', 'FOLLOWED', [], null), agg('R2', 'IGNORED', [], null)] };
  const r = F.efficacySignals(m, []);
  assert.deepStrictEqual(r.leadTime, { suggested: null, n: 0, confidence: 'none' });
});

/* ---- the refusal family ---------------------------------------------------- */
console.log('\nRefusals — the §14.6d posture');

test('a non-§14.6b shape refuses WIRING_MALFORMED', () => {
  assert.ok(throws(() => F.efficacySignals({}), 'WIRING_MALFORMED'));
  assert.ok(throws(() => F.efficacySignals({ proposals: 'R1' }), 'WIRING_MALFORMED'));
  assert.ok(throws(() => F.efficacySignals({ proposals: [{ outcome: 'FOLLOWED' }] }), 'WIRING_MALFORMED'));
  assert.ok(throws(() => F.efficacySignals({ proposals: [{ refId: 'R1' }] }), 'WIRING_MALFORMED'));
});

test('observations refuse by name — malformed, non-boolean, duplicate', () => {
  const m = { proposals: [agg('R1', 'FOLLOWED')] };
  assert.ok(throws(() => F.efficacySignals(m, 'R1'), 'OBSERVATIONS_MALFORMED'));
  assert.ok(throws(() => F.efficacySignals(m, [{ stockedOutAfter: true }]), 'OBSERVATION_MALFORMED'));
  assert.ok(throws(() => F.efficacySignals(m, [{ refId: 'R1', stockedOutAfter: 'yes' }]), 'OBSERVATION_MALFORMED'));
  assert.ok(throws(() => F.efficacySignals(m, [{ refId: 'R1', overstockedAfter: 1 }]), 'OBSERVATION_MALFORMED'));
  assert.ok(throws(() => F.efficacySignals(m, [
    { refId: 'R1', stockedOutAfter: true }, { refId: 'R1', stockedOutAfter: false },
  ]), 'OBSERVATION_DUPLICATE'));
});

/* ---- determinism ------------------------------------------------------------ */
console.log('\nDeterminism — identical inputs, identical output');

test('identical inputs are deep-equal, survive a JSON round-trip, and obs order is irrelevant', () => {
  const m = buildMatched();
  const obs = [
    { refId: 'GHOST-1', stockedOutAfter: true },
    { refId: 'R1', stockedOutAfter: true },
    { refId: 'R4', overstockedAfter: true },
    { refId: 'R6', stockedOutAfter: true },
  ];
  const a = F.efficacySignals(m, obs);
  const b = F.efficacySignals(m, [obs[2], obs[0], obs[3], obs[1]]);
  assert.deepStrictEqual(a, b);                                    // order-insensitive join
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);        // round-trip
  assert.deepStrictEqual(a.quality.missedRefs, ['GHOST-1']);       // sorted
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
