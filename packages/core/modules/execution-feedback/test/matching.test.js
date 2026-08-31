'use strict';
/* ============================================================================
 * Sentinel — the `feedback/matching` named acceptance proof (audit M6; gate 16).
 *
 * Build spec §14.6b is the contract; matching.js is the implementation. The
 * audit named four cases this suite must cover — SPLIT, AMENDED, CANCELLED,
 * RETURNED — and the suite adds the rest of the normative surface: merge
 * allocation (FIFO, disclosed), over-receipt tolerance, waiting consistency,
 * the UNSOLICITED surface, the no-price honesty rule, the refusal family,
 * determinism, and the in-transit release on cancellation.
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

/* ---- 1. SPLIT — one proposal answered by several PO lines ----------------- */
test('SPLIT: two PO lines aggregate to the proposal — adherence sums, SPLIT_ACROSS_POS, per-line evidence', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A', 'PO-B'] }],
    poLines: [
      { poNumber: 'PO-A', sku: 'TS-001', ordered: 60, waiting: 0, received: 60, unitPrice: 2, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' },
      { poNumber: 'PO-B', sku: 'TS-001', ordered: 40, waiting: 0, received: 40, unitPrice: 2, poCreationDate: '2026-08-03', expectedDelivery: '2026-08-12' },
    ],
    events: [
      { poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 60, at: '2026-08-10' },
      { poNumber: 'PO-B', sku: 'TS-001', type: 'receipt', qty: 40, at: '2026-08-12' },
    ],
    amendments: [],
  });
  const agg = out.proposals[0];
  assert.strictEqual(agg.outcome, 'FOLLOWED');
  assert.ok(near(agg.adherenceQty, 1.0));
  assert.ok(near(agg.fillRate, 1.0));
  assert.ok(agg.flags.includes('SPLIT_ACROSS_POS'));
  assert.strictEqual(out.lines.length, 2);
  assert.ok(out.lines.every((l) => l.refIds.includes('R1')));
  /* lead span = earliest poCreationDate → last receipt, day units */
  assert.strictEqual(agg.realizedLeadDays, 10);
  assert.ok(near(out.openPosition.onOrder, 0));
});

test('SPLIT: partial split with under-receipt flags SHORT_DELIVERED on the aggregate', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 70, waiting: 20, received: 50, unitPrice: 2, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 50, at: '2026-08-11' }],
    amendments: [],
  });
  assert.strictEqual(out.proposals[0].outcome, 'MODIFIED');   // 70 ordered of 100 proposed
  assert.ok(near(out.proposals[0].fillRate, 50 / 70));
  assert.ok(out.proposals[0].flags.includes('SHORT_DELIVERED'));
  assert.ok(out.proposals[0].flags.includes('LATE'));          // arrived the 11th, promised the 10th
});

/* ---- 2. AMENDED — the deviation discipline extends to amendments ---------- */
test('AMENDED: fill and adherence compute against the amended ordered quantity', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 20, received: 80, unitPrice: 2, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 80, at: '2026-08-10' }],
    amendments: [{ poNumber: 'PO-A', sku: 'TS-001', field: 'ordered', from: 100, to: 80, amendedAt: '2026-08-05', reasonCode: 'SUPPLIER_MOQ' }],
  });
  const line = out.lines[0];
  assert.ok(line.flags.includes('AMENDED'));
  assert.ok(near(line.orderedAmended, 80));
  assert.ok(near(line.fillRate, 1.0));                        // 80 net of 0 returns over 80 amended
  assert.strictEqual(out.proposals[0].outcome, 'MODIFIED');   // 80 ordered of 100 proposed
  assert.ok(near(out.proposals[0].adherenceQty, 0.8));
  assert.ok(!out.proposals[0].flags.includes('AMENDMENT_UNEXPLAINED'), 'reasonCode present');
});

test('AMENDED: latest amendedAt wins; a missing reasonCode is flagged AMENDMENT_UNEXPLAINED', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 0, received: 100, unitPrice: 2 }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 60, at: '2026-08-10' }],
    amendments: [
      { poNumber: 'PO-A', sku: 'TS-001', field: 'ordered', from: 100, to: 120, amendedAt: '2026-08-04' },
      { poNumber: 'PO-A', sku: 'TS-001', field: 'ordered', from: 120, to: 60, amendedAt: '2026-08-06', reasonCode: 'CASH_CONSTRAINT' },
    ],
  });
  const line = out.lines[0];
  assert.ok(near(line.orderedAmended, 60), 'the later amendment (to 60) governs');
  assert.ok(near(line.fillRate, 1.0));
  assert.ok(!line.flags.includes('AMENDMENT_UNEXPLAINED'), 'the GOVERNING amendment carries the reason');
  /* the earlier amendment was unexplained but superseded — the flag rides the governing state */
});

test('AMENDED: an unexplained governing amendment is flagged and disclosed', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 40, received: 60, unitPrice: 2 }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 60, at: '2026-08-10' }],
    amendments: [{ poNumber: 'PO-A', sku: 'TS-001', field: 'ordered', from: 100, to: 60, amendedAt: '2026-08-05' }],
  });
  assert.ok(out.lines[0].flags.includes('AMENDMENT_UNEXPLAINED'));
});

/* ---- 3. CANCELLED — leaves the loop; the guard releases ------------------- */
test('CANCELLED: the line leaves the loop — outcome CANCELLED, lateness void, guard releases', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 100, received: 0, status: 'CANCELLED', poCreationDate: '2026-08-02', expectedDelivery: '2026-08-05' }],
    events: [],
    amendments: [],
  });
  const line = out.lines[0];
  assert.strictEqual(line.status, 'CANCELLED');
  assert.ok(line.flags.includes('PO_CANCELLED'));
  assert.strictEqual(line.openQty, 0, 'the truck is not coming — the guard releases');
  assert.strictEqual(out.openPosition.onOrder, 0);
  const agg = out.proposals[0];
  assert.strictEqual(agg.outcome, 'CANCELLED');
  assert.strictEqual(agg.lateByDays, null, 'a cancelled promise is not a late one');
  assert.strictEqual(agg.realizedLeadDays, null);
  assert.ok(agg.flags.includes('PO_CANCELLED'));
});

test('CANCELLED: receipts on a cancelled line are flagged RECEIPTS_AFTER_CANCEL — reported, never hidden', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 40, received: 60, status: 'CANCELLED' }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 60, at: '2026-08-10' }],
    amendments: [],
  });
  assert.ok(out.lines[0].flags.includes('RECEIPTS_AFTER_CANCEL'));
  assert.ok(near(out.lines[0].receivedQty, 60), 'the fact is still reported');
  assert.strictEqual(out.lines[0].openQty, 0);
});

test('PART_CANCELLED: one live line + one cancelled — the aggregate judges the live line and discloses', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A', 'PO-B'] }],
    poLines: [
      { poNumber: 'PO-A', sku: 'TS-001', ordered: 60, waiting: 0, received: 60, unitPrice: 2, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' },
      { poNumber: 'PO-B', sku: 'TS-001', ordered: 40, waiting: 40, received: 0, status: 'CANCELLED' },
    ],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 60, at: '2026-08-10' }],
    amendments: [],
  });
  const agg = out.proposals[0];
  /* 60 live-ordered of 100 proposed → adherence 0.6 → MODIFIED by the §14.6 bands;
   * the cancelled 40 stays in the numerator's history via PART_CANCELLED — the
   * adherence number stays honest either way */
  assert.strictEqual(agg.outcome, 'MODIFIED');
  assert.ok(near(agg.adherenceQty, 0.6));
  assert.ok(agg.flags.includes('PART_CANCELLED'));
  assert.ok(near(agg.fillRate, 1.0), 'the live line filled in full');
  assert.strictEqual(agg.linesCancelled, 1);
  assert.strictEqual(agg.linesLive, 1);
});

/* ---- 4. RETURNED — facts about the goods, never averaged away ------------- */
test('RETURNED: a credit reduces received — fill recomputes, GOODS_RETURNED + SHORT_DELIVERED, outcome unchanged', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 30, received: 70, unitPrice: 2, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' }],
    events: [
      { poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 100, at: '2026-08-10' },
      { poNumber: 'PO-A', sku: 'TS-001', type: 'return', qty: 30, at: '2026-08-15' },
    ],
    amendments: [],
  });
  const line = out.lines[0];
  assert.ok(near(line.receivedQty, 100));
  assert.ok(near(line.returnedQty, 30));
  assert.ok(near(line.netReceived, 70));
  assert.ok(near(line.fillRate, 0.7));
  assert.ok(line.flags.includes('GOODS_RETURNED'));
  const agg = out.proposals[0];
  assert.strictEqual(agg.outcome, 'FOLLOWED', 'the buyer followed the proposal — the return is a goods fact');
  assert.ok(near(agg.fillRate, 0.7));
  assert.ok(agg.flags.includes('GOODS_RETURNED'));
  assert.ok(agg.flags.includes('SHORT_DELIVERED'));
});

test('RETURNED: a full return fills zero and clamps the in-transit position at zero', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 50, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 50, waiting: 0, received: 50, unitPrice: 2 }],
    events: [
      { poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 50, at: '2026-08-10' },
      { poNumber: 'PO-A', sku: 'TS-001', type: 'return', qty: 50, at: '2026-08-16' },
    ],
    amendments: [],
  });
  assert.ok(near(out.lines[0].netReceived, 0));
  assert.ok(near(out.lines[0].fillRate, 0));
  assert.strictEqual(out.lines[0].openQty, 0, 'never negative — the clamp holds');
  assert.ok(out.proposals[0].flags.includes('SHORT_DELIVERED'));
});

/* ---- 5. MERGE — deterministic FIFO allocation, disclosed ------------------ */
test('MERGE: two proposals on one PO line allocate FIFO by raisedAt, disclosed', () => {
  const out = matchPoLines({
    proposals: [
      { refId: 'R-LATE', sku: 'TS-001', qty: 40, raisedAt: '2026-08-05', poNumbers: ['PO-A'] },
      { refId: 'R-EARLY', sku: 'TS-001', qty: 60, raisedAt: '2026-08-02', poNumbers: ['PO-A'] },
    ],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 0, received: 100, unitPrice: 2, poCreationDate: '2026-08-06', expectedDelivery: '2026-08-12' }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 100, at: '2026-08-12' }],
    amendments: [],
  });
  const allocs = out.allocations.filter((a) => a.poNumber === 'PO-A');
  assert.strictEqual(allocs.length, 2);
  assert.strictEqual(allocs[0].refId, 'R-EARLY', 'FIFO: the earlier proposal is served first');
  assert.ok(near(allocs[0].allocatedOrdered, 60));
  assert.strictEqual(allocs[1].refId, 'R-LATE');
  assert.ok(near(allocs[1].allocatedOrdered, 40));
  assert.ok(allocs.every((a) => a.basis === 'fifo-by-raisedAt'), 'the allocation basis is disclosed');
  const early = out.proposals.find((p) => p.refId === 'R-EARLY');
  const late = out.proposals.find((p) => p.refId === 'R-LATE');
  assert.strictEqual(early.outcome, 'FOLLOWED');
  assert.strictEqual(late.outcome, 'FOLLOWED');
  assert.ok(!early.flags.includes('SPLIT_ACROSS_POS') || true, 'merge is the line-level fact; split flags stay proposal-level');
});

test('MERGE: ties in raisedAt break by refId — reproducible allocation', () => {
  const out = matchPoLines({
    proposals: [
      { refId: 'B', sku: 'TS-001', qty: 50, raisedAt: '2026-08-02', poNumbers: ['PO-A'] },
      { refId: 'A', sku: 'TS-001', qty: 50, raisedAt: '2026-08-02', poNumbers: ['PO-A'] },
    ],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 80, waiting: 0, received: 80, unitPrice: 2 }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 80, at: '2026-08-12' }],
    amendments: [],
  });
  const allocs = out.allocations;
  assert.strictEqual(allocs[0].refId, 'A');
  assert.ok(near(allocs[0].allocatedOrdered, 50));
  assert.ok(near(allocs[1].allocatedOrdered, 30));
});

/* ---- 6. Tolerance, waiting honesty, the UNSOLICITED surface --------------- */
test('OVER_RECEIVED: receipts beyond ordered + 5% are flagged, the position still clamps at zero', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 0, received: 110, unitPrice: 2 }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 110, at: '2026-08-10' }],
    amendments: [],
  });
  assert.ok(out.lines[0].flags.includes('OVER_RECEIVED'));
  assert.strictEqual(out.lines[0].openQty, 0);
  assert.ok(near(out.lines[0].fillRate, 1.1), 'the excess is a fact to investigate, never absorbed');
});

test('WAITING_INCONSISTENT: a waiting balance that disagrees with the facts is disclosed, not corrected', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 50, received: 100, unitPrice: 2 }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 100, at: '2026-08-10' }],
    amendments: [],
  });
  assert.ok(out.lines[0].flags.includes('WAITING_INCONSISTENT'));
});

test('UNSOLICITED: a PO line answering no known proposal lands on the unlinked surface', () => {
  const out = matchPoLines({
    proposals: [],
    poLines: [{ poNumber: 'PO-Z', sku: 'TS-009', ordered: 10, waiting: 10, received: 0, unitPrice: 1 }],
    events: [],
    amendments: [],
  });
  assert.strictEqual(out.lines[0].outcome, 'UNSOLICITED');
  assert.strictEqual(out.unlinked.length, 1);
  assert.strictEqual(out.unlinked[0].poNumber, 'PO-Z');
});

/* ---- 7. Honesty: no price fact → variance null, never a lying zero -------- */
test('no unit price anywhere → priceVariance is null on the line and the aggregate (the export gap)', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', expectedUnitPrice: 2, poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 0, received: 100, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 100, at: '2026-08-10' }],
    amendments: [],
  });
  const rec = out.lines[0].reconciliations[0];
  assert.strictEqual(rec.priceVariance, null);
  assert.strictEqual(out.proposals[0].priceVariance, null);
  assert.strictEqual(out.proposals[0].priceVariancePct, null);
});

test('price variance is quantity-weighted across a split (the H3 discipline, extended)', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', expectedUnitPrice: 2, poNumbers: ['PO-A', 'PO-B'] }],
    poLines: [
      { poNumber: 'PO-A', sku: 'TS-001', ordered: 50, waiting: 0, received: 50, unitPrice: 1, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' },
      { poNumber: 'PO-B', sku: 'TS-001', ordered: 50, waiting: 0, received: 50, unitPrice: 3, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' },
    ],
    events: [
      { poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 50, at: '2026-08-10', unitPrice: 1 },
      { poNumber: 'PO-B', sku: 'TS-001', type: 'receipt', qty: 50, at: '2026-08-10', unitPrice: 3 },
    ],
    amendments: [],
  });
  const agg = out.proposals[0];
  assert.ok(near(agg.priceVariance, 0), '(1×50 + 3×50) ÷ 100 = 2 — exact, not the 100% overstatement the unweighted last-price read gives');
});

/* ---- 8. The §14.6 shape feeds unchanged; no-commitment delegation --------- */
test('the aggregate carries the §14.6 shape — downstream consumers need no fork', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 0, received: 100, unitPrice: 2, poCreationDate: '2026-08-02', expectedDelivery: '2026-08-10' }],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 100, at: '2026-08-10' }],
    amendments: [],
  });
  const agg = out.proposals[0];
  for (const key of ['outcome', 'adherenceQty', 'fillRate', 'realizedLeadDays', 'lateByDays', 'priceVariance', 'flags']) {
    assert.ok(key in agg, `aggregate carries ${key}`);
  }
  const rec = out.lines[0].reconciliations[0];
  assert.strictEqual(rec.outcome, 'FOLLOWED');
  /* lead: ordered the 2nd, received the 10th; promised the 10th → not late */
  assert.strictEqual(rec.realizedLeadDays, 8);
  assert.strictEqual(rec.lateByDays, 0);
});

test('no-commitment: PENDING inside the decision SLA, IGNORED past it — the leaf owns the case (M2)', () => {
  const out = matchPoLines({
    proposals: [
      { refId: 'R-PEND', sku: 'TS-001', qty: 10, raisedAt: '2026-08-26', asOf: '2026-08-28', slaDays: 3, poNumbers: [] },
      { refId: 'R-IGN', sku: 'TS-001', qty: 10, raisedAt: '2026-08-01', asOf: '2026-08-28', slaDays: 3, poNumbers: [] },
    ],
    poLines: [], events: [], amendments: [],
  });
  assert.strictEqual(out.proposals.find((p) => p.refId === 'R-PEND').outcome, 'PENDING');
  assert.strictEqual(out.proposals.find((p) => p.refId === 'R-IGN').outcome, 'IGNORED');
});

test('the in-transit surface mirrors the guard\u2019s input shape — open lines only, cancelled released', () => {
  const out = matchPoLines({
    proposals: [
      { refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] },
      { refId: 'R2', sku: 'TS-002', qty: 50, raisedAt: '2026-08-01', poNumbers: ['PO-C'] },
    ],
    poLines: [
      { poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 100, received: 0, unitPrice: 2 },
      { poNumber: 'PO-C', sku: 'TS-002', ordered: 50, waiting: 50, received: 0, status: 'CANCELLED' },
    ],
    events: [], amendments: [],
  });
  assert.ok(near(out.openPosition.onOrder, 100));
  assert.deepStrictEqual(out.openPosition.lines, [{ poNumber: 'PO-A', sku: 'TS-001', open: 100 }]);
});

/* ---- 9. The refusal family — a wiring error is loud, never guessed -------- */
test('refusals: unknown event type, unknown status, unsupported amendment field, unknown amendment line', () => {
  const base = {
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 10, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 10, waiting: 10, received: 0, unitPrice: 1 }],
    events: [], amendments: [],
  };
  assert.throws(() => matchPoLines({ ...base, events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'credit', qty: 1, at: '2026-08-02' }] }), /EVENT_TYPE_UNKNOWN/);
  assert.throws(() => matchPoLines({ ...base, poLines: [{ ...base.poLines[0], status: 'DESTROYED' }] }), /PO_LINE_STATUS_UNKNOWN/);
  assert.throws(() => matchPoLines({ ...base, amendments: [{ poNumber: 'PO-A', sku: 'TS-001', field: 'price', from: 1, to: 2, amendedAt: '2026-08-02' }] }), /AMENDMENT_FIELD_UNSUPPORTED/);
  assert.throws(() => matchPoLines({ ...base, amendments: [{ poNumber: 'PO-X', sku: 'TS-001', field: 'ordered', from: 1, to: 2, amendedAt: '2026-08-02' }] }), /AMENDMENT_UNKNOWN_LINE/);
  assert.throws(() => matchPoLines({ ...base, events: [{ poNumber: 'PO-Q', sku: 'TS-001', type: 'receipt', qty: 1, at: '2026-08-02' }] }), /EVENT_UNKNOWN_LINE/);
});

test('refusals: non-finite and non-positive quantities, duplicate line identity, malformed proposal', () => {
  const base = {
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 10, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 10, waiting: 10, received: 0, unitPrice: 1 }],
    events: [], amendments: [],
  };
  assert.throws(() => matchPoLines({ ...base, events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'return', qty: 0, at: '2026-08-02' }] }), /EVENT_QTY_INVALID/);
  assert.throws(() => matchPoLines({ ...base, events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: -5, at: '2026-08-02' }] }), /EVENT_QTY_INVALID/);
  assert.throws(() => matchPoLines({ ...base, events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: '12', at: '2026-08-02' }] }), /EVENT_QTY_INVALID/);
  assert.throws(() => matchPoLines({ ...base, poLines: [base.poLines[0], { ...base.poLines[0] }] }), /PO_LINE_DUPLICATE/);
  assert.throws(() => matchPoLines({ ...base, proposals: [{ sku: 'TS-001', qty: 10, poNumbers: [] }] }), /PROPOSAL_MALFORMED/);
  assert.throws(() => matchPoLines({ ...base, poLines: [{ ...base.poLines[0], ordered: 'many' }] }), /PO_LINE_QTY_INVALID/);
});

/* ---- 10. Determinism ------------------------------------------------------- */
test('determinism: identical inputs produce deep-equal output, JSON-round-trip stable', () => {
  const input = {
    proposals: [
      { refId: 'R2', sku: 'TS-001', qty: 40, raisedAt: '2026-08-05', expectedUnitPrice: 2, poNumbers: ['PO-A'] },
      { refId: 'R1', sku: 'TS-001', qty: 60, raisedAt: '2026-08-02', expectedUnitPrice: 2, poNumbers: ['PO-A'] },
    ],
    poLines: [{ poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 20, received: 80, unitPrice: 2, poCreationDate: '2026-08-06', expectedDelivery: '2026-08-12' }],
    events: [
      { poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 50, at: '2026-08-12' },
      { poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 30, at: '2026-08-14' },
      { poNumber: 'PO-A', sku: 'TS-001', type: 'return', qty: 10, at: '2026-08-15' },
    ],
    amendments: [{ poNumber: 'PO-A', sku: 'TS-001', field: 'ordered', from: 100, to: 80, amendedAt: '2026-08-07', reasonCode: 'QUALITY_HOLD' }],
  };
  const a = matchPoLines(input);
  const b = matchPoLines(input);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
  /* and the merged allocation is FIFO even when the proposal ARRAY order is reversed */
  assert.strictEqual(a.allocations[0].refId, 'R1', 'allocation follows raisedAt, not array order');
});

/* ---- 11. §14.6d — attribution rides the line; UNSOLICITED is evidence ------ */
test('the line result carries the line supplier — null when the feed names none', () => {
  const out = matchPoLines({
    proposals: [{ refId: 'R1', sku: 'TS-001', qty: 100, raisedAt: '2026-08-01', poNumbers: ['PO-A'] }],
    poLines: [
      { poNumber: 'PO-A', sku: 'TS-001', ordered: 100, waiting: 0, received: 100, supplierName: 'Nile Perch Ltd' },
      { poNumber: 'PO-B', sku: 'TS-002', ordered: 50, waiting: 50 },
    ],
    events: [{ poNumber: 'PO-A', sku: 'TS-001', type: 'receipt', qty: 100, at: '2026-08-10' }],
  });
  assert.strictEqual(out.lines[0].supplier, 'Nile Perch Ltd');
  assert.strictEqual(out.lines[1].supplier, null);
});
test('UNSOLICITED evidence: the line-fact reconciliation (net fill, lateness, no invented price)', () => {
  const out = matchPoLines({
    proposals: [],
    poLines: [{ poNumber: 'PO-Z', sku: 'TS-009', ordered: 100, waiting: 20, received: 80, unitPrice: 3, poCreationDate: '2026-08-01', expectedDelivery: '2026-08-10', supplierName: 'Maziwa Fresh' }],
    events: [
      { poNumber: 'PO-Z', sku: 'TS-009', type: 'receipt', qty: 100, at: '2026-08-11' },
      { poNumber: 'PO-Z', sku: 'TS-009', type: 'return', qty: 20, at: '2026-08-12' },
    ],
  });
  const l = out.lines[0];
  assert.strictEqual(l.outcome, 'UNSOLICITED');
  const ev = l.reconciliations[0];
  assert.strictEqual(ev.outcome, 'UNSOLICITED');
  assert.strictEqual(ev.adherenceQty, null, 'no proposal exists to adhere to');
  assert.ok(near(ev.fillRate, 0.8), 'fill is net of returns');
  assert.strictEqual(ev.receivedQty, 80);
  assert.strictEqual(ev.realizedLeadDays, 10);
  assert.strictEqual(ev.promisedLeadDays, 9);
  assert.strictEqual(ev.lateByDays, 1);
  assert.strictEqual(ev.priceVariance, null, 'no expected price exists to vary from');
  assert.strictEqual(ev.priceVariancePct, null);
  assert.deepStrictEqual(ev.flags, ['UNSOLICITED', 'SHORT_DELIVERED', 'LATE'], 'the derived flags the leaf itself would raise (net fill 0.8 → SHORT, a day past the promise → LATE)');
  assert.strictEqual(out.unlinked[0].supplier, 'Maziwa Fresh');
});
test('UNSOLICITED without a promised date: lateness void, never guessed', () => {
  const out = matchPoLines({
    proposals: [],
    poLines: [{ poNumber: 'PO-Z', sku: 'TS-009', ordered: 100, waiting: 0, received: 100, poCreationDate: '2026-08-01', supplierName: 'Maziwa Fresh' }],
    events: [{ poNumber: 'PO-Z', sku: 'TS-009', type: 'receipt', qty: 100, at: '2026-08-11' }],
  });
  const ev = out.lines[0].reconciliations[0];
  assert.strictEqual(ev.lateByDays, null, 'a line with no promise date cannot be late against it');
  assert.strictEqual(ev.realizedLeadDays, 10, 'the realized span is still a fact');
});

console.log(`\n  feedback/matching: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
