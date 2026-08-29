'use strict';
const assert = require('assert');
const F = require('../src/feedback');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }
const near = (a,b,eps=1e-6)=>Math.abs(a-b)<=eps;

const prop = { refId:'chicken-breast', sku:'FI30001720', supplier:'SupplierA', qty:1000,
               expectedUnitPrice:2.15, raisedAt:'2026-08-20', asOf:'2026-08-28' };

/* ---- reconcileProposal ---------------------------------------------------- */
console.log('\nProposal reconciliation');
test('never acted on → IGNORED with age', () => {
  const r = F.reconcileProposal(prop, null, []);
  assert.strictEqual(r.outcome, 'IGNORED');
  assert.strictEqual(r.ageDays, 8);
  assert.ok(r.flags.includes('NO_COMMITMENT'));
});
test('ordered as proposed and received in full → FOLLOWED', () => {
  const c = {poNumber:'PO1', sku:'FI30001720', supplier:'SupplierA', qty:1000, unitPrice:2.15,
             orderedAt:'2026-08-20', expectedDelivery:'2026-08-23'};
  const r = F.reconcileProposal(prop, c, [{qty:1000, receivedAt:'2026-08-23', unitPrice:2.15}]);
  assert.strictEqual(r.outcome, 'FOLLOWED');
  assert.ok(near(r.adherenceQty,1)); assert.ok(near(r.fillRate,1));
  assert.strictEqual(r.realizedLeadDays, 3);
  assert.strictEqual(r.lateByDays, 0);
  assert.deepStrictEqual(r.flags, []);
});
test('different quantity → MODIFIED, and unexplained deviation is flagged', () => {
  const c = {poNumber:'PO2', sku:'FI30001720', qty:400, unitPrice:2.15, orderedAt:'2026-08-20'};
  const r = F.reconcileProposal(prop, c, []);
  assert.strictEqual(r.outcome, 'MODIFIED');
  assert.ok(near(r.adherenceQty,0.4));
  assert.ok(r.flags.includes('DEVIATION_UNEXPLAINED'));
});
test('a supplied reason code clears the unexplained flag', () => {
  const c = {poNumber:'PO2', sku:'FI30001720', qty:400, orderedAt:'2026-08-20', reasonCode:'CASH_CONSTRAINT'};
  const r = F.reconcileProposal(prop, c, []);
  assert.ok(!r.flags.includes('DEVIATION_UNEXPLAINED'));
  assert.strictEqual(r.reasonCode, 'CASH_CONSTRAINT');
  assert.ok(F.REASON_CODES.includes(r.reasonCode));
});
test('a different SKU → SUBSTITUTED', () => {
  const c = {poNumber:'PO3', sku:'FI99999', supplier:'SupplierC', qty:1000, orderedAt:'2026-08-20', reasonCode:'SUPPLIER_UNAVAILABLE'};
  const r = F.reconcileProposal(prop, c, []);
  assert.strictEqual(r.outcome, 'SUBSTITUTED');
  assert.ok(r.flags.includes('SKU_SUBSTITUTED'));
  assert.ok(r.flags.includes('SUPPLIER_CHANGED'));
});
test('short delivery and lateness are detected', () => {
  const c = {poNumber:'PO4', sku:'FI30001720', qty:1000, unitPrice:2.15,
             orderedAt:'2026-08-20', expectedDelivery:'2026-08-23'};
  const r = F.reconcileProposal(prop, c, [{qty:700, receivedAt:'2026-08-27', unitPrice:2.15}]);
  assert.ok(near(r.fillRate,0.7));
  assert.strictEqual(r.realizedLeadDays, 7);
  assert.strictEqual(r.lateByDays, 4);
  assert.ok(r.flags.includes('SHORT_DELIVERED'));
  assert.ok(r.flags.includes('LATE'));
});
test('price above expectation is flagged with variance', () => {
  const c = {poNumber:'PO5', sku:'FI30001720', qty:1000, unitPrice:2.15, orderedAt:'2026-08-20'};
  const r = F.reconcileProposal(prop, c, [{qty:1000, receivedAt:'2026-08-23', unitPrice:2.50}]);
  assert.ok(near(r.priceVariance, 0.35, 1e-9));
  assert.ok(r.priceVariancePct > 0.16);
  assert.ok(r.flags.includes('PRICE_ABOVE_EXPECTED'));
});

/* ---- lead-time learning (PLAN) ------------------------------------------- */
console.log('\nLead-time learning — closes the 84% gap from observed reality');
test('no observations → no suggestion (never invent a lead time)', () => {
  const e = F.leadTimeEstimate([]);
  assert.strictEqual(e.suggested, null);
  assert.strictEqual(e.confidence, 'none');
});
test('p80 is the default basis and is >= median', () => {
  const obs = [2,3,3,3,4,4,5,9].map(d=>({realizedLeadDays:d}));
  const e = F.leadTimeEstimate(obs);
  assert.strictEqual(e.basis, 'p80');
  assert.ok(e.p80 >= e.median);
  assert.strictEqual(e.suggested, Math.ceil(e.p80));
  assert.strictEqual(e.n, 8);
  assert.strictEqual(e.confidence, 'medium');
});
test('median basis is selectable and lower on a skewed sample', () => {
  const obs = [2,3,3,3,4,4,5,20].map(d=>({realizedLeadDays:d}));
  const p80 = F.leadTimeEstimate(obs).suggested;
  const med = F.leadTimeEstimate(obs, {basis:'median'}).suggested;
  assert.ok(med <= p80);
});
test('confidence rises with sample size', () => {
  const mk = n => Array.from({length:n},()=>({realizedLeadDays:3}));
  assert.strictEqual(F.leadTimeEstimate(mk(3)).confidence, 'low');
  assert.strictEqual(F.leadTimeEstimate(mk(6)).confidence, 'medium');
  assert.strictEqual(F.leadTimeEstimate(mk(15)).confidence, 'high');
});
test('junk observations are ignored, not averaged in', () => {
  const e = F.leadTimeEstimate([{realizedLeadDays:null},{realizedLeadDays:0},{realizedLeadDays:4}]);
  assert.strictEqual(e.n, 1);
  assert.strictEqual(e.suggested, 4);
});

/* ---- parameter efficacy (PLAN → optimizer) ------------------------------- */
console.log('\nParameter efficacy — the optimizer training signal');
test('stockouts after following advice → raise safety days', () => {
  const h = Array.from({length:12},(_,i)=>({outcome:'FOLLOWED', stockedOutAfter: i<4}));  // 33% > 20%
  const s = F.parameterEfficacy(h).signals;
  assert.ok(s.some(x=>x.param==='safetyDays' && x.direction==='increase'));
});
test('overstock with no stockouts → lower safety and order frequency', () => {
  const h = Array.from({length:12},()=>({outcome:'FOLLOWED', overstockedAfter:true}));
  const s = F.parameterEfficacy(h).signals;
  assert.ok(s.some(x=>x.param==='orderFreq' && x.direction==='decrease'));
  assert.ok(s.some(x=>x.param==='safetyDays' && x.direction==='decrease'));
});
test('a stockout after advice was IGNORED is not blamed on the parameters', () => {
  const h = Array.from({length:5},()=>({outcome:'IGNORED', stockedOutAfter:true}));
  const e = F.parameterEfficacy(h);
  assert.strictEqual(e.followed, 0);
  assert.deepStrictEqual(e.signals, []);
});

/* ---- proposal quality (PLAN) --------------------------------------------- */
console.log('\nProposal quality — including the shortages we never warned about');
test('missed shortages are surfaced, not hidden by adherence', () => {
  const props = [{refId:'A', outcome:'FOLLOWED'}, {refId:'B', outcome:'IGNORED'}];
  const stockouts = [{refId:'B'}, {refId:'Z'}];
  const q = F.proposalQuality(props, stockouts);
  assert.strictEqual(q.missedShortages, 1);
  assert.deepStrictEqual(q.missedRefs, ['Z']);
  assert.ok(near(q.recall, 0.5));
  assert.ok(near(q.actedRate, 0.5));
});

/* ---- supplier scorecard (SRM) -------------------------------------------- */
console.log('\nSupplier scorecard from execution facts');
test('OTIF requires both on-time AND in-full', () => {
  const lines = [
    {lateByDays:0,  fillRate:1.0,  priceVariancePct:0.0,  realizedLeadDays:3, quarantinedQty:0},
    {lateByDays:4,  fillRate:1.0,  priceVariancePct:0.01, realizedLeadDays:7, quarantinedQty:0},
    {lateByDays:0,  fillRate:0.70, priceVariancePct:0.10, realizedLeadDays:3, quarantinedQty:5},
  ];
  const s = F.supplierScorecard(lines);
  assert.ok(near(s.onTimeRate, 2/3));
  assert.ok(near(s.inFullRate, 2/3));
  assert.ok(near(s.otif, 1/3));           // only line 1 is both
  assert.ok(near(s.quarantineRate, 1/3));
  assert.ok(near(s.priceAdherence, 2/3));
  assert.strictEqual(s.avgLateDays, 4);
  assert.strictEqual(s.leadTime.n, 3);    // scorecard also yields a lead-time estimate
});
test('empty history yields nulls, never fabricated scores', () => {
  const s = F.supplierScorecard([]);
  assert.strictEqual(s.n, 0);
  assert.strictEqual(s.otif, null);
});

/* ---- realized savings (SOURCE) ------------------------------------------- */
console.log('\nRealized savings — only counted on receipt');
test('saving computed per baseline, never blended', () => {
  const s = F.realizedSaving({previousPrice:2.50, budget:2.40, benchmark:2.30, bestQuote:2.20}, 2.15, 1000);
  assert.ok(near(s.perBaseline.previousPrice, 350));
  assert.ok(near(s.perBaseline.budget, 250));
  assert.ok(near(s.perBaseline.benchmark, 150));
  assert.ok(near(s.perBaseline.bestQuote, 50));
  assert.strictEqual(s.realized, true);
});
test('a missing baseline stays null rather than becoming zero', () => {
  const s = F.realizedSaving({previousPrice:2.50}, 2.15, 100);
  assert.strictEqual(s.perBaseline.budget, null);
});
test('nothing received → nothing realized', () => {
  const s = F.realizedSaving({previousPrice:2.50}, 2.15, 0);
  assert.strictEqual(s.realized, false);
  assert.ok(near(s.perBaseline.previousPrice, 0));
});

/* ---- in-transit guard (INVENTORY) ---------------------------------------- */
console.log('\nDouble-order guard');
test('open committed quantity suppresses a repeat proposal', () => {
  const t = F.inTransitPosition(
    [{poNumber:'PO1', sku:'FI1', qty:1000, expectedDelivery:'2026-08-30'}],
    {PO1:[{qty:400}]});
  assert.strictEqual(t.onOrder, 600);
  assert.strictEqual(t.suppressesProposal, true);
  assert.strictEqual(t.lines[0].open, 600);
});
test('fully received PO stops suppressing', () => {
  const t = F.inTransitPosition([{poNumber:'PO1', sku:'FI1', qty:1000}], {PO1:[{qty:1000}]});
  assert.strictEqual(t.onOrder, 0);
  assert.strictEqual(t.suppressesProposal, false);
});
test('over-receipt never produces a negative open position', () => {
  const t = F.inTransitPosition([{poNumber:'PO1', qty:100}], {PO1:[{qty:150}]});
  assert.strictEqual(t.onOrder, 0);
});

/* ---- Audit remediation (SENT-AUDIT-002) ---------------------------------- */
console.log('\nAudit fixes — feedback module');
test('M3: a small sample emits NO signal (was 3, now 12)', () => {
  const h = Array.from({length:5},()=>({outcome:'FOLLOWED', stockedOutAfter:true}));
  const e = F.parameterEfficacy(h);
  assert.deepStrictEqual(e.signals, []);
  assert.strictEqual(e.confidence, 'insufficient');
});
test('H3: actual price is quantity-weighted across partial receipts', () => {
  const r = F.reconcileProposal({qty:1000, expectedUnitPrice:2.0, sku:'A'},
    {poNumber:'P', sku:'A', qty:1000, unitPrice:2.0, orderedAt:'2026-08-01'},
    [{qty:500, receivedAt:'2026-08-05', unitPrice:2.0},
     {qty:500, receivedAt:'2026-08-06', unitPrice:3.0}]);
  assert.ok(near(r.actualPrice, 2.5));         // was 3.0 (last receipt)
  assert.ok(near(r.priceVariance, 0.5));       // was 1.0 — a 100% overstatement
  assert.strictEqual(r.mixedPrice, true);
  assert.ok(r.flags.includes('MIXED_RECEIPT_PRICES'));
});
test('H2: a not-yet-due PO does not drag the scorecard down', () => {
  const s = F.supplierScorecard([
    {lateByDays:0, fillRate:1.0, realizedLeadDays:3},
    {lateByDays:null, fillRate:null, realizedLeadDays:null}]);   // in flight, not due
  assert.strictEqual(s.dueLines, 1);
  assert.strictEqual(s.openLines, 1);
  assert.ok(near(s.fillRate, 1.0));            // was 0.5
  assert.ok(near(s.otif, 1.0));
});
test('H2: no late lines reports null, not a flattering zero', () => {
  const s = F.supplierScorecard([{lateByDays:0, fillRate:1.0, realizedLeadDays:3}]);
  assert.strictEqual(s.avgLateDays, null);
});
test('M2: a proposal inside its SLA is PENDING, not IGNORED', () => {
  const r = F.reconcileProposal({qty:100, raisedAt:'2026-08-27', asOf:'2026-08-28', slaDays:3}, null, []);
  assert.strictEqual(r.outcome, 'PENDING');
  assert.ok(r.flags.includes('PENDING_DECISION'));
});
test('M2: past SLA it becomes IGNORED', () => {
  const r = F.reconcileProposal({qty:100, raisedAt:'2026-08-20', asOf:'2026-08-28', slaDays:3}, null, []);
  assert.strictEqual(r.outcome, 'IGNORED');
});
test('M2: actedRate excludes in-window proposals', () => {
  const q = F.proposalQuality([{refId:'A',outcome:'FOLLOWED'},{refId:'B',outcome:'PENDING'}], []);
  assert.strictEqual(q.pending, 1);
  assert.strictEqual(q.decided, 1);
  assert.ok(near(q.actedRate, 1.0));           // was 0.5, unfairly penalising the buyer
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
