'use strict';
/* ============================================================================
 * The scorecard rebuild — the H2 second arm, past-promise due-ness (§14.6f).
 * The named proof `feedback/scorecard-rebuild` (D-034's scheduled follow-on).
 *
 * Every rule the contract names is pinned here: the blind spot reproduced
 * through the FULL matching path (a never-delivered supplier is invisible in
 * the bare §14.6d wiring), the arm's four boundaries (unreceived + past
 * promise → due with derived lateness and the disclosure flag; promise not
 * yet broken → open; partial → observed lateness untouched; cancelled →
 * never due §14.6b verbatim; unpromised → never late §14.6c verbatim), the
 * never-delivered supplier finally scored, the refusal family, the Class-S
 * event shape (§16.2 fields, actor system posture, stamps), determinism, and
 * the composition pin (the H2 engine's denominators stay the engine's — the
 * arm fixes the input, never the engine). The engine `supplierScorecards` is
 * composed, never re-implemented.
 * ==========================================================================*/
const assert = require('assert');
const { matchPoLines } = require('../src/matching.js');
const F = require('../src/feedback.js');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed += 1; }
};
const refuses = (code, fn) => {
  try { fn(); return `expected ${code}, nothing threw`; }
  catch (e) { return e.message.includes(code) ? null : `expected ${code}, got: ${e.message}`; }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* A facts view with every boundary in it, promised around 2026-08:
 *   PO-BARE  — promised 2026-08-10, ZERO receipts  → the arm's subject
 *   PO-NEXT  — promised 2026-09-20, ZERO receipts  → promise not yet broken
 *   PO-PART  — promised 2026-08-05, partial receipt → observed lateness
 *   PO-DEAD  — promised 2026-08-01, CANCELLED, zero receipts → never due
 *   PO-OPEN  — waiting, NO promised date           → unpromised, never late
 *   PO-GOOD  — delivered in full on 2026-08-08     → the observed baseline
 */
function buildMatched() {
  return matchPoLines({
    proposals: [
      { refId: 'R-BARE', sku: 'FLOUR-1', supplier: 'Maziwa Fresh', qty: 50, expectedUnitPrice: 2, raisedAt: '2026-08-01', poNumbers: ['PO-BARE'] },
      { refId: 'R-NEXT', sku: 'SALT-9', supplier: 'Maziwa Fresh', qty: 40, expectedUnitPrice: 1, raisedAt: '2026-08-02', poNumbers: ['PO-NEXT'] },
      { refId: 'R-PART', sku: 'OIL-3', supplier: 'Nile Perch Ltd', qty: 100, expectedUnitPrice: 3, raisedAt: '2026-08-01', poNumbers: ['PO-PART'] },
      { refId: 'R-GOOD', sku: 'RICE-7', supplier: 'Nile Perch Ltd', qty: 80, expectedUnitPrice: 1.5, raisedAt: '2026-08-01', poNumbers: ['PO-GOOD'] },
      { refId: 'R-DEAD', sku: 'TEA-2', supplier: 'Nile Perch Ltd', qty: 30, expectedUnitPrice: 4, raisedAt: '2026-08-01', poNumbers: ['PO-DEAD'] },
    ],
    poLines: [
      { poNumber: 'PO-BARE', sku: 'FLOUR-1', ordered: 50, waiting: 50, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-10', supplierName: 'Maziwa Fresh' },
      { poNumber: 'PO-NEXT', sku: 'SALT-9', ordered: 40, waiting: 40, poCreationDate: '2026-08-04', expectedDelivery: '2026-09-20', supplierName: 'Maziwa Fresh' },
      { poNumber: 'PO-PART', sku: 'OIL-3', ordered: 100, waiting: 60, received: 40, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-05', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-DEAD', sku: 'TEA-2', ordered: 30, waiting: 30, status: 'CANCELLED', poCreationDate: '2026-08-03', expectedDelivery: '2026-08-01', supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-OPEN', sku: 'OATS-4', ordered: 20, waiting: 20, poCreationDate: '2026-08-05', supplierName: 'Maziwa Fresh' },
      { poNumber: 'PO-GOOD', sku: 'RICE-7', ordered: 80, waiting: 0, received: 80, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-08', supplierName: 'Nile Perch Ltd' },
    ],
    events: [
      { poNumber: 'PO-PART', sku: 'OIL-3', type: 'receipt', qty: 40, at: '2026-08-09' },
      { poNumber: 'PO-GOOD', sku: 'RICE-7', type: 'receipt', qty: 80, at: '2026-08-08' },
    ],
    amendments: [],
  });
}

const ASOF = '2026-09-01';   // ten days past PO-BARE's promise, past PO-PART's

/* ---- the blind spot, reproduced ------------------------------------------ */
console.log('\nThe blind spot — reproduced through the full matching path (§14.6f)');

test('the bare §14.6d wiring never judges the never-delivered supplier', () => {
  const bare = F.supplierScorecards(buildMatched());
  const maziwa = bare.suppliers.find((s) => s.supplier === 'Maziwa Fresh');
  assert.strictEqual(maziwa.dueLines, 0, 'zero receipts → lateByDays null → the H2 filter sees nothing due');
  assert.strictEqual(maziwa.otif, null, 'no fabricated score for the empty card — but no JUDGMENT either');
  assert.strictEqual(maziwa.fillRate, null, 'a supplier who never delivered reads unjudged, not failed — the blind spot');
});

/* ---- the arm's four boundaries ------------------------------------------- */
console.log('\nThe second arm — the four boundaries (§14.6f)');

test('unreceived + past promise → DUE, with the derived days-past-due lateness', () => {
  const r = F.rebuildScorecard(buildMatched(), { asOf: ASOF });
  const maziwa = r.scorecard.suppliers.find((s) => s.supplier === 'Maziwa Fresh');
  assert.strictEqual(maziwa.dueLines, 1, 'PO-BARE is due — the promise was broken, the truck never came');
  assert.strictEqual(maziwa.fillRate, 0, 'nothing came — the fill fact is zero');
  assert.strictEqual(maziwa.avgLateDays, 22, 'asOf 09-01 − promise 08-10 = 22 days past due (derived, canonical day units)');
  assert.strictEqual(maziwa.onTimeRate, 0);
  assert.strictEqual(maziwa.otif, 0, 'OTIF zero — genuinely earned, not fabricated (the fill IS zero)');
});

test('the derived lateness is DISCLOSED — PAST_PROMISE_UNRECEIVED marks the provenance', () => {
  const r = F.rebuildScorecard(buildMatched(), { asOf: ASOF });
  const line = r.scorecard;   // the rollup rode the armed reconciliations
  assert.strictEqual(r.secondArm.lines.length, 1);
  const armed = r.secondArm.lines[0];
  assert.strictEqual(armed.poNumber, 'PO-BARE');
  assert.strictEqual(armed.daysPastDue, 22);
  assert.strictEqual(armed.expectedDelivery, '2026-08-10');
  assert.ok(line);   // the named-lines surface is the disclosure — proven below via flags
  const maziwa = r.scorecard.suppliers.find((s) => s.supplier === 'Maziwa Fresh');
  assert.ok(maziwa.flagCounts.PAST_PROMISE_UNRECEIVED >= 1, 'the flag rides the rollup — the derivation is never disguised as observed lateness');
});

test('promise NOT yet broken → stays open (a promise kept on time is not evidence)', () => {
  const r = F.rebuildScorecard(buildMatched(), { asOf: ASOF });
  const next = r.scorecard;   // PO-NEXT promised 09-20, asOf 09-01
  assert.ok(next);
  assert.strictEqual(r.secondArm.lines.some((l) => l.poNumber === 'PO-NEXT'), false, 'PO-NEXT is not armed');
  const maziwa = r.scorecard.suppliers.find((s) => s.supplier === 'Maziwa Fresh');
  assert.strictEqual(maziwa.openLines, 2, 'PO-NEXT and the unpromised PO-OPEN stay open');
  assert.strictEqual(maziwa.dueLines, 1, 'only the broken promise is due');
});

test('PARTIAL delivery → the arm never touches observed lateness', () => {
  const r = F.rebuildScorecard(buildMatched(), { asOf: ASOF });
  const nile = r.scorecard.suppliers.find((s) => s.supplier === 'Nile Perch Ltd');
  assert.strictEqual(r.secondArm.lines.some((l) => l.poNumber === 'PO-PART'), false, 'a partial has receipts — its lateness is observed');
  assert.strictEqual(nile.dueLines, 2, 'PO-PART due through the FIRST arm (observed), PO-GOOD delivered');
  const part = nile.avgLateDays;
  assert.strictEqual(part, 4, "realized lead 08-03→08-09 = 6 minus promised lead 08-03→08-05 = 2 → observed late by 4 (the leaf's canon)");
  assert.ok(!nile.flagCounts.PAST_PROMISE_UNRECEIVED, 'no derived-lateness flag on the observed path');
});

test('CANCELLED promise → never due (§14.6b verbatim); UNPROMISED → never late (§14.6c verbatim)', () => {
  const r = F.rebuildScorecard(buildMatched(), { asOf: ASOF });
  assert.strictEqual(r.secondArm.lines.some((l) => l.poNumber === 'PO-DEAD'), false, 'a cancelled promise is not a late one');
  assert.strictEqual(r.secondArm.lines.some((l) => l.poNumber === 'PO-OPEN'), false, 'an unpromised line can never be late against no promise');
  const nile = r.scorecard.suppliers.find((s) => s.supplier === 'Nile Perch Ltd');
  assert.strictEqual(nile.cancelledLines, 1, 'the cancelled line is disclosed, not vanished (the §14.6d posture)');
});

/* ---- the never-delivered supplier, finally scored ------------------------- */
console.log('\nThe rebuild — the supplier who never delivers is finally scored');

test('the scorecard composes the engine UNCHANGED — the arm fixes the input, not the denominators', () => {
  /* the ARMED result, fed to the bare wiring by hand, must equal the rebuild's
   * scorecard — proving the rebuild adds no arithmetic of its own */
  const r = F.rebuildScorecard(buildMatched(), { asOf: ASOF });
  const armedMatched = buildMatched();
  armedMatched.lines = armedMatched.lines.map((l) => {
    const armedLine = r.secondArm.lines.find((x) => x.poNumber === l.poNumber && x.sku === l.sku);
    if (!armedLine) return l;
    return {
      ...l,
      reconciliations: l.reconciliations.map((rec) => ({
        ...rec, lateByDays: armedLine.daysPastDue,
        flags: Array.from(new Set([...(rec.flags || []), 'PAST_PROMISE_UNRECEIVED'])).sort(),
      })),
    };
  });
  const byHand = F.supplierScorecards(armedMatched);
  assert.deepStrictEqual(r.scorecard, byHand, 'the rebuild IS the §14.6d wiring over the armed input — one canon');
});

test('the never-delivered supplier now fails honestly — the scorecard can steer again', () => {
  const r = F.rebuildScorecard(buildMatched(), { asOf: ASOF });
  const maziwa = r.scorecard.suppliers.find((s) => s.supplier === 'Maziwa Fresh');
  assert.strictEqual(maziwa.fillRate, 0);
  assert.strictEqual(maziwa.avgLateDays, 22, 'days past due — visible at last');
  assert.strictEqual(maziwa.otif, 0);
  assert.strictEqual(maziwa.leadTime.suggested, null, 'no lead time invented from no data (the M2 canon holds)');
});

/* ---- the refusal family ---------------------------------------------------- */
console.log('\nRefusals — the fail-closed posture (§14.6f)');

test('ASOF_REQUIRED — a rebuild without its as-of is not a scorecard', () => {
  const err = refuses('ASOF_REQUIRED', () => F.rebuildScorecard(buildMatched(), {}));
  assert.strictEqual(err, null);
});
test('ASOF_INVALID — a non-canonical day refuses (the H4 canon never guesses)', () => {
  assert.strictEqual(refuses('ASOF_INVALID', () => F.rebuildScorecard(buildMatched(), { asOf: '09/01/2026' })), null);
  assert.strictEqual(refuses('ASOF_INVALID', () => F.rebuildScorecard(buildMatched(), { asOf: '2026-09-01T00:00:00Z' })), null);
  assert.strictEqual(refuses('ASOF_INVALID', () => F.rebuildScorecard(buildMatched(), { asOf: 'not-a-day' })), null);
});
test('TRIGGER_INVALID — the Class-S trigger vocabulary is closed', () => {
  assert.strictEqual(refuses('TRIGGER_INVALID', () => F.rebuildScorecard(buildMatched(), { asOf: ASOF, trigger: 'whenever' })), null);
});
test('WIRING_MALFORMED — raw evidence is not a matching result', () => {
  assert.strictEqual(refuses('WIRING_MALFORMED', () => F.rebuildScorecard({}, { asOf: ASOF })), null);
  assert.strictEqual(refuses('WIRING_MALFORMED', () => F.rebuildScorecard({ lines: [{}] }, { asOf: ASOF })), null);
});

/* ---- the Class-S event ----------------------------------------------------- */
console.log('\nThe Class-S SCORECARD_REBUILT event — the §16.1/§16.2 shape');

test('the event payload carries the §16.2 fields with the system posture', () => {
  const r = F.rebuildScorecard(buildMatched(), {
    asOf: ASOF, trigger: 'schedule', jobId: 'scorecard-nightly',
    engineVersion: '9.9.9', schemaVersion: '0009',
  });
  const e = r.event;
  assert.strictEqual(e.class, 'S', 'the §16.1 Class-S rollup');
  assert.strictEqual(e.entity, 'supplier_scorecard');
  assert.strictEqual(e.entityId, ASOF, 'the asOf is the entity identity — the day the score is about');
  assert.strictEqual(e.action, 'SCORECARD_REBUILT');
  assert.strictEqual(e.outcome, 'success');
  assert.strictEqual(e.before, null, 'a rollup writes no business value');
  assert.deepStrictEqual(e.after, {
    asOf: ASOF,
    suppliers: ['Maziwa Fresh', 'Nile Perch Ltd'],   // sorted — deterministic
    dueLines: 3,                                     // PO-BARE (armed) + PO-PART + PO-GOOD (observed)
    pastPromiseDue: 1,
  });
  assert.strictEqual(e.reason, 'trigger=schedule job=scorecard-nightly', 'trigger + job ride the reason (§16.1 Class S)');
  assert.strictEqual(e.engineVersion, '9.9.9', 'L-07 stamps carried for the door');
  assert.strictEqual(e.schemaVersion, '0009');
});

test('an empty arm is still recorded — zero counts, never suppressed', () => {
  const r = F.rebuildScorecard(buildMatched(), { asOf: '2026-08-04' });   // before every broken promise
  assert.strictEqual(r.secondArm.pastPromiseDue, 0);
  assert.strictEqual(r.event.after.pastPromiseDue, 0, 'an empty arm is a fact about the day, still recorded');
  assert.strictEqual(r.event.after.dueLines, 2, 'the OBSERVED due lines ride the facts view the caller presents (PO-PART, PO-GOOD) — the asOf governs the arm, the facts view stays the caller\'s contract (§14.6b)');
});

test('determinism — identical inputs produce deep-equal output; JSON round-trip holds', () => {
  const a = F.rebuildScorecard(buildMatched(), { asOf: ASOF, trigger: 'manual', jobId: 'j1', engineVersion: 'x', schemaVersion: 'y' });
  const b = F.rebuildScorecard(buildMatched(), { asOf: ASOF, trigger: 'manual', jobId: 'j1', engineVersion: 'x', schemaVersion: 'y' });
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
});

/* ---- summary --------------------------------------------------------------- */
console.log(`\nfeedback/scorecard-rebuild: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
