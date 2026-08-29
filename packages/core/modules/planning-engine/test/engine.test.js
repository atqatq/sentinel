'use strict';
const assert = require('assert');
const E = require('../src/engine');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }
const near = (a,b,eps=1e-6)=>Math.abs(a-b)<=eps;

/* ---- 1. Consumption reconciliation + rate seeding (Consumption S/T/U/V/W) ---- */
console.log('\nConsumption chain (deliveries as primitive)');
test('reconcile unit = start + in - end - out', () => {
  assert.strictEqual(E.reconcileConsumptionUnit({start:100,goodsIn:20,goodsOut:5,end:30}), 85);
});
test('consPerDelivery rate = convertedConsumption / historical deliveries', () => {
  // T=8800 converted over 737750 historical deliveries
  const v = E.seedConsPerDelivery(8800, 737750);
  assert.ok(near(v, 8800/737750));
});
test('rate is zero-safe when historical deliveries = 0', () => {
  assert.strictEqual(E.seedConsPerDelivery(500, 0), 0);
});
test('magnified monthly = rate × DPD × 22 (W = V*W1*22)', () => {
  const rate = E.seedConsPerDelivery(8800, 737750);       // V
  const dpd = 12000;                                       // W1
  const r = E.computeRef({onHand:0,openPO:0,invValue:0,histMonthly:0,consPerDelivery:rate},
                         {lead:0,safetyDays:0,orderFreq:0,moq:0}, dpd);
  assert.ok(near(r.monthlyMagnified, rate*dpd*22, 1e-6));
  assert.ok(near(r.dailyConsumption, rate*dpd, 1e-6));     // J = L/22 = rate*dpd
});

/* ---- 2. Master Data derived columns R,S,T,U,V,X,Y,Z ------------------------- */
console.log('\nMaster Data derived columns');
// Construct a ref whose dailyConsumption is a clean number: pick rate*dpd = 100/day.
const dpd = 1000;
const rate = 100/dpd;                    // consPerDelivery so that J = 100
const ref = { onHand: 402, openPO: 0, invValue: 402*6, histMonthly: 100*22, consPerDelivery: rate };
const params = { lead: 7, safetyDays: 5, orderFreq: 7, moq: 500 };
const c = E.computeRef(ref, params, dpd);
test('dailyConsumption J = 100', () => assert.ok(near(c.dailyConsumption,100)));
test('safetyStock R = safetyDays × J = 500', () => assert.strictEqual(c.safetyStock, 500));
test('reorder S = (lead+safety) × J = 1200', () => assert.strictEqual(c.reorder, 1200));
test('eoq T = max(moq, orderFreq×J) = max(500,700) = 700', () => assert.strictEqual(c.eoq, 700));
test('maxStock U = T + R = 1200', () => assert.strictEqual(c.maxStock, 1200));
test('cycleStock V = R + T/2 = 850', () => assert.strictEqual(c.cycleStock, 850));
test('unitValue = invValue/onHand = 6', () => assert.ok(near(c.unitValue,6)));
test('targetInvValue X = unitValue × cycleStock = 5100', () => assert.ok(near(c.targetInvValue,5100)));
test('maxInvValue Y = unitValue × maxStock = 7200', () => assert.ok(near(c.maxInvValue,7200)));
test('orderQty Z (below reorder) = max(moq, eoq+(reorder-onHand))', () => {
  // onHand 402 < reorder 1200 → 700 + (1200-402)=1498 ; max(500,1498)=1498
  assert.strictEqual(c.orderQty, 1498);
  assert.strictEqual(c.orderRecQty, 1498);
});
test('orderQty Z (at/above reorder) = max(moq, eoq), rec = 0', () => {
  const hi = E.computeRef({...ref, onHand: 5000}, params, dpd);
  assert.strictEqual(hi.orderQty, 700);      // max(500,700)
  assert.strictEqual(hi.orderRecQty, 0);     // not triggered
});
test('run-out uses HISTORICAL daily, not magnified', () => {
  // histMonthly 2200 → histDaily 100 → runOut = 402/100 = 4.02
  assert.ok(near(c.runOut, 4.02, 1e-6));
});

/* ---- 3. Status ladder — all 7 branches (MRP!O2) ---------------------------- */
console.log('\nStatus ladder (7 branches, verbatim MRP!O2)');
const S = (o) => E.statusOf(o);
test('Over Stock when onHand > maxStock×1.2', () =>
  assert.strictEqual(S({available:1500,maxStock:1200,reorderPct:2,safetyStock:500,openPO:0}), 'Over Stock'));
test('OK (NC) when no consumption (reorderPct null)', () =>
  assert.strictEqual(S({available:0,maxStock:0,reorderPct:null,safetyStock:0,openPO:0}), 'OK'));
test('Zero Stock when onHand = 0 and has consumption', () =>
  assert.strictEqual(S({available:0,maxStock:1200,reorderPct:0,safetyStock:500,openPO:0}), 'Zero Stock'));
test('Below Safety when onHand < safetyStock', () =>
  assert.strictEqual(S({available:400,maxStock:1200,reorderPct:0.33,safetyStock:500,openPO:0}), 'Below Safety'));
test('Follow-up with Supplier when short-ish but openPO > 0', () =>
  assert.strictEqual(S({available:600,maxStock:1200,reorderPct:0.5,safetyStock:500,openPO:800}), 'Follow-up with Supplier'));
test('Below Reorder when reorderPct < 101% and no open PO', () =>
  assert.strictEqual(S({available:600,maxStock:1200,reorderPct:0.5,safetyStock:500,openPO:0}), 'Below Reorder'));
test('OK when covered above reorder', () =>
  assert.strictEqual(S({available:1300,maxStock:5000,reorderPct:1.08,safetyStock:500,openPO:0}), 'OK'));
test('computeRef surfaces Below Safety for the sample ref', () =>
  assert.strictEqual(c.status, 'Below Safety'));

/* ---- 4. Deliveries-primitive property: scaling deliveries scales planning --- */
console.log('\nDeliveries-primitive scaling property');
test('doubling deliveries/day doubles dailyConsumption and all derived levels', () => {
  const a = E.computeRef(ref, params, dpd);
  const b = E.computeRef(ref, params, dpd*2);
  assert.ok(near(b.dailyConsumption, a.dailyConsumption*2));
  assert.ok(near(b.safetyStock, a.safetyStock*2));
  assert.ok(near(b.reorder, a.reorder*2));
  // run-out is historical → unaffected by the forward delivery driver
  assert.ok(near(b.runOut, a.runOut));
});
test('zero deliveries → no consumption → status collapses to OK (NC)', () => {
  const z = E.computeRef(ref, params, 0);
  assert.strictEqual(z.dailyConsumption, 0);
  assert.strictEqual(z.reorderPct, null);
  assert.strictEqual(z.status, 'OK');
  assert.strictEqual(z.inactive, true);
});

/* ---- 5. Live param edit (Planning Profiles behaviour) ---------------------- */
console.log('\nLive parameter edits');
test('cutting safetyDays lowers safetyStock & reorder', () => {
  const before = E.computeRef(ref, params, dpd);
  const after  = E.computeRef(ref, {...params, safetyDays: 1}, dpd);
  assert.ok(after.safetyStock < before.safetyStock);
  assert.ok(after.reorder < before.reorder);
});
test('raising MOQ floors EOQ', () => {
  const after = E.computeRef(ref, {...params, moq: 5000}, dpd);
  assert.strictEqual(after.eoq, 5000);        // max(5000, 700)
});

/* ---- 6. Portfolio KPIs / DIO (Target Inventory sheet) ---------------------- */
console.log('\nPortfolio KPIs & DIO (Target Inventory sheet)');
test('dailyCOGS = cogs × avgRev × DPD ; targetInvValue = DIO × dailyCOGS', () => {
  const targets = { targetDIO: 26, cogsPct: 0.33, avgRevPerDelivery: 18.38 };
  const k = E.portfolioKPIs([c], targets, 12000, 'BHD');
  const expectedDailyCOGS = 0.33 * 18.38 * 12000;
  assert.ok(near(k.dailyCOGS, expectedDailyCOGS, 1e-3));
  assert.ok(near(k.targetInvValueTopDown, 26 * expectedDailyCOGS, 1e-3));
  assert.ok(near(k.targetInvValueNoStaging, 26 * expectedDailyCOGS * 0.79, 1e-3));
});
test('actualDIO = actualInvValue / dailyCOGS', () => {
  const targets = { targetDIO: 26, cogsPct: 0.33, avgRevPerDelivery: 18.38 };
  const k = E.portfolioKPIs([c], targets, 12000, 'BHD');
  assert.ok(near(k.actualDIO, k.actualInvValue / k.dailyCOGS, 1e-6));
});
test('KPI counts tally by status', () => {
  const rows = [c, E.computeRef({...ref,onHand:0}, params, dpd)];
  const k = E.portfolioKPIs(rows, {targetDIO:26,cogsPct:0.33,avgRevPerDelivery:18.38}, 12000, 'BHD');
  assert.strictEqual(k.counts['Below Safety'], 1);
  assert.strictEqual(k.counts['Zero Stock'], 1);
});

/* ---- 7. Display status override (§2.2 — show Inactive) --------------------- */
console.log('\nDisplay status (Inactive override)');
test('no-consumption row displays Inactive, not raw OK', () => {
  const z = E.computeRef(ref, params, 0);        // zero deliveries → NC
  assert.strictEqual(z.status, 'OK');            // raw follows workbook
  assert.strictEqual(z.inactive, true);
  assert.strictEqual(E.displayStatus(z), 'Inactive');   // UI shows Inactive
});
test('active row displays its real status unchanged', () => {
  assert.strictEqual(E.displayStatus(c), 'Below Safety');
});

/* ---- 8. Available stock as planning trigger (ontology) --------------------- */
console.log('\nAvailable stock (planning trigger nets out quarantine)');
test('available = onHand − quarantine − reserved − damaged', () => {
  const r = E.computeRef({...ref, onHand: 1000, quarantine: 120, reserved: 30, damaged: 10,
    histMonthly: 100*22, consPerDelivery: rate}, params, dpd);
  assert.strictEqual(r.available, 840);
});
test('quarantined stock does not count toward coverage — can flip status to short', () => {
  // on-hand 1300 looks covered, but 900 quarantined → available 400 < safetyStock 500
  const shorted = E.computeRef({...ref, onHand: 1300, quarantine: 900}, params, dpd);
  assert.strictEqual(shorted.available, 400);
  assert.strictEqual(shorted.status, 'Below Safety');
  const healthy = E.computeRef({...ref, onHand: 1300, quarantine: 0}, params, dpd);
  assert.notStrictEqual(healthy.status, 'Below Safety'); // same on-hand, nothing held → not short
});
test('order recommendation sizes against available, not on-hand', () => {
  const r = E.computeRef({...ref, onHand: 1300, quarantine: 900}, params, dpd); // available 400
  // avail 400 < reorder 1200 → 700 + (1200-400)=1500 ; max(500,1500)=1500
  assert.strictEqual(r.orderRecQty, 1500);
});

/* ---- 9. Supply-status axis (additive second axis) ------------------------- */
console.log('\nSupply-status axis (independent of inventory health)');
test('Normal when no open PO', () => assert.strictEqual(E.supplyStatus({openPO:0}), 'Normal'));
test('Follow-up with Supplier when open PO exists', () =>
  assert.strictEqual(E.supplyStatus({openPO:500}), 'Follow-up with Supplier'));
test('Partial Delivery outranks plain follow-up', () =>
  assert.strictEqual(E.supplyStatus({openPO:500, partialPO:100}), 'Partial Delivery'));
test('Late PO outranks partial', () =>
  assert.strictEqual(E.supplyStatus({openPO:500, partialPO:100, overduePO:200}), 'Late PO'));
test('Supplier Issue is top severity', () =>
  assert.strictEqual(E.supplyStatus({openPO:500, overduePO:200, supplierIssue:true}), 'Supplier Issue'));
test('health and supply axes are independent (healthy item can have a late PO)', () => {
  const healthy = E.computeRef({...ref, onHand: 5000, quarantine: 0}, params, dpd);
  assert.notStrictEqual(healthy.status, 'Below Safety');
  assert.strictEqual(E.supplyStatus({openPO:800, overduePO:800}), 'Late PO');
});

/* ---- 10. Parameter provenance resolver (Parameter Engine) ----------------- */
console.log('\nParameter provenance (calculated / manual / override → active)');
test('manual override wins over calculated and manual', () => {
  const r = E.resolveParam({manual:5, calculated:8, override:3});
  assert.deepStrictEqual(r, {value:3, source:'manual-override'});
});
test('calculated used when no override', () => {
  assert.deepStrictEqual(E.resolveParam({manual:5, calculated:8}), {value:8, source:'calculated'});
});
test('falls back to manual input when nothing else', () => {
  assert.deepStrictEqual(E.resolveParam({manual:5}), {value:5, source:'manual'});
});
test('activeParams resolves the 4 planning params and feeds computeRef', () => {
  const ap = E.activeParams({ lead:{calculated:7}, safetyDays:{manual:5, override:3},
    orderFreq:{manual:7}, moq:{calculated:400, override:500} });
  assert.deepStrictEqual(ap, {lead:7, safetyDays:3, orderFreq:7, moq:500});
  const r = E.computeRef(ref, ap, dpd);      // resolved params drive the engine
  assert.strictEqual(r.safetyStock, 3*100);  // safetyDays resolved to override 3
  assert.strictEqual(r.eoq, 700);            // max(moq 500, orderFreq 7 × J 100) = 700
});

/* ---- 11. Shelf-life cap (fresh-food guard) -------------------------------- */
console.log('\nShelf-life cap on order quantity');
test('non-perishable ref is uncapped', () => {
  const r = E.computeRef(ref, params, dpd);
  assert.strictEqual(r.shelfLifeCap, null);
  assert.strictEqual(r.shelfLifeCapped, false);
  assert.strictEqual(r.orderQty, 1498);
});
test('perishable ref caps order at shelfLifeDays of cover', () => {
  // J=100/day, shelf life 3d → cap 300; uncapped order would be 1498
  const r = E.computeRef({...ref, shelfLifeDays: 3}, {...params, moq: 0}, dpd);
  assert.strictEqual(r.shelfLifeCap, 300);
  assert.strictEqual(r.orderQty, 300);
  assert.strictEqual(r.shelfLifeCapped, true);
});
test('cap does not raise a smaller order', () => {
  const r = E.computeRef({...ref, onHand: 1150, shelfLifeDays: 30}, {...params, moq: 0}, dpd);
  assert.ok(r.orderQty <= r.shelfLifeCap);
  assert.strictEqual(r.shelfLifeCapped, false);
});
test('MOQ above the shelf-life cap is flagged, not silently obeyed', () => {
  const r = E.computeRef({...ref, shelfLifeDays: 2}, {...params, moq: 5000}, dpd);
  assert.strictEqual(r.moqExceedsShelfLife, true);   // 5000 > cap 200
  assert.strictEqual(r.shelfLifeCapped, false);      // cannot fix by sizing down
});
test('zero consumption disables the cap (no divide-by-nothing surprise)', () => {
  const r = E.computeRef({...ref, shelfLifeDays: 3}, params, 0);
  assert.strictEqual(r.shelfLifeCapped, false);
});

/* ---- 12. Preferred ordering SKU ------------------------------------------ */
console.log('\nPreferred ordering SKU resolution');
const members = [
  {sku:'FI001', active:true, purchasedQty:1200, purchaseCount:9, conversionFactor:1, primarySupplier:'SupplierA', lastPurchasedAt:'2026-08-20'},
  {sku:'FI002', active:true, purchasedQty:300,  purchaseCount:2, conversionFactor:1, primarySupplier:'SupplierC', lastPurchasedAt:'2026-08-25'},
  {sku:'FI003', active:false,purchasedQty:9999, purchaseCount:9, conversionFactor:1, primarySupplier:'Old',    lastPurchasedAt:'2026-01-01'},
];
test('picks the highest purchase-weight active SKU and its supplier', () => {
  const r = E.resolveOrderingSku(members);
  assert.strictEqual(r.sku, 'FI001');
  assert.strictEqual(r.supplier, 'SupplierA');
  assert.strictEqual(r.source, 'history');
});
test('inactive SKUs are never chosen even with the best history', () => {
  assert.notStrictEqual(E.resolveOrderingSku(members).sku, 'FI003');
});
test('a pinned preferred SKU overrides history', () => {
  const r = E.resolveOrderingSku(members, {preferredSku:'FI002'});
  assert.strictEqual(r.sku, 'FI002');
  assert.strictEqual(r.source, 'pinned');
});
test('falls back to most recent purchase when no quantities exist', () => {
  const none = members.map(m => ({...m, purchasedQty:0, purchaseCount:0}));
  const r = E.resolveOrderingSku(none);
  assert.strictEqual(r.sku, 'FI002');      // most recent 2026-08-25
  assert.strictEqual(r.source, 'recent');
});
test('unresolved when there are no active members', () => {
  const r = E.resolveOrderingSku([{sku:'X', active:false}]);
  assert.strictEqual(r.sku, null);
  assert.strictEqual(r.source, 'none');
});

/* ---- 13. TSRC / seasonality overlay -------------------------------------- */
console.log('\nSeasonality overlay (deliveries multiplier only)');
test('no factors = exact baseline (engine cannot drift)', () => {
  assert.strictEqual(E.effectiveDeliveriesPerDay(12000, null), 12000);
  assert.strictEqual(E.effectiveDeliveriesPerDay(12000, {}), 12000);
});
test('factors compose multiplicatively', () => {
  assert.ok(Math.abs(E.effectiveDeliveriesPerDay(1000,{trend:1.1,seasonal:1.5,cyclical:1.0}) - 1650) < 1e-9);
});
test('invalid or zero factors are ignored rather than zeroing demand', () => {
  assert.strictEqual(E.effectiveDeliveriesPerDay(1000,{seasonal:0}), 1000);
  assert.strictEqual(E.effectiveDeliveriesPerDay(1000,{seasonal:'x'}), 1000);
});
test('seasonal uplift raises derived levels exactly as more deliveries would', () => {
  const base = E.computeRef(ref, params, dpd);
  const peak = E.computeRef(ref, params, E.effectiveDeliveriesPerDay(dpd,{seasonal:2}));
  assert.ok(Math.abs(peak.reorder - base.reorder*2) <= 1);
  assert.ok(Math.abs(peak.runOut - base.runOut) < 1e-9);   // run-out stays historical
});

/* ---- 14. Data-state discriminator (day-one correctness) ------------------ */
console.log('\nData state — "no params" must not masquerade as "Inactive"');
test('consuming ref with NO planning params reads Not Planned, not Inactive', () => {
  const r = E.computeRef(ref, {lead:0,safetyDays:0,orderFreq:0,moq:0}, dpd);
  assert.ok(r.dailyConsumption > 0);            // it IS consuming
  assert.strictEqual(r.dataState, 'NO_PARAMS');
  assert.strictEqual(E.displayStatus(r), 'Not Planned');
});
test('genuinely dormant ref still reads Inactive', () => {
  const r = E.computeRef(ref, params, 0);       // no deliveries -> no usage
  assert.strictEqual(r.dataState, 'NO_USAGE');
  assert.strictEqual(E.displayStatus(r), 'Inactive');
});
test('missing lead time is called out separately (84% of suppliers)', () => {
  const r = E.computeRef(ref, {...params, lead:0}, dpd);
  assert.strictEqual(r.dataState, 'NO_LEAD_TIME');
  assert.strictEqual(E.displayStatus(r), 'No Lead Time');
});
test('fully specified ref is unaffected — golden ladder preserved', () => {
  const r = E.computeRef(ref, params, dpd);
  assert.strictEqual(r.dataState, 'OK');
  assert.strictEqual(E.displayStatus(r), 'Below Safety');
  assert.strictEqual(r.status, 'Below Safety');
});

/* ---- 15. Deliveries granularity normalization ---------------------------- */
console.log('\nDeliveries input — daily / weekly / monthly / quarterly / YTD');
test('daily input passes through unchanged', () => {
  const d = E.normalizeDeliveries(12000, 'daily');
  assert.strictEqual(d.deliveriesPerDay, 12000);
  assert.strictEqual(d.confidence, 'high');
});
test('monthly input cancels exactly against the ×22 magnification', () => {
  const monthly = 264000;                         // 12000/day × 22
  const d = E.normalizeDeliveries(monthly, 'monthly');
  assert.ok(near(d.deliveriesPerDay, 12000));
  // and the round-trip through the engine reproduces the monthly total exactly
  const r = E.computeRef({...ref, consPerDelivery: 0.01}, params, d.deliveriesPerDay);
  assert.ok(near(r.monthlyMagnified, 0.01 * monthly, 1e-6));
});
test('weekly divides by 5.5 to stay on the same basis', () => {
  const d = E.normalizeDeliveries(66000, 'weekly');   // 12000 × 5.5
  assert.ok(near(d.deliveriesPerDay, 12000));
  assert.strictEqual(d.confidence, 'medium');
});
test('quarterly divides by 66', () => {
  assert.ok(near(E.normalizeDeliveries(792000, 'quarterly').deliveriesPerDay, 12000));
});
test('YTD requires months elapsed and uses it', () => {
  const bad = E.normalizeDeliveries(1000000, 'ytd');
  assert.strictEqual(bad.valid, false);
  const good = E.normalizeDeliveries(12000 * 22 * 8, 'ytd', {monthsElapsed: 8});
  assert.ok(near(good.deliveriesPerDay, 12000));
  assert.strictEqual(good.confidence, 'low');
});
test('all granularities agree for the same underlying rate', () => {
  const dpd = 12000;
  const each = [
    E.normalizeDeliveries(dpd, 'daily'),
    E.normalizeDeliveries(dpd*5.5, 'weekly'),
    E.normalizeDeliveries(dpd*22, 'monthly'),
    E.normalizeDeliveries(dpd*66, 'quarterly'),
    E.normalizeDeliveries(dpd*22*3, 'ytd', {monthsElapsed:3}),
  ];
  each.forEach(d => assert.ok(near(d.deliveriesPerDay, dpd, 1e-6)));
});
test('bad input is rejected, never silently zeroed into a plan', () => {
  assert.strictEqual(E.normalizeDeliveries(100, 'fortnightly').valid, false);
  assert.strictEqual(E.normalizeDeliveries(-5, 'daily').valid, false);
});

/* ---- Audit remediation (SENT-AUDIT-002) ---------------------------------- */
console.log('\nAudit fixes — engine');
test('C1: purchase units convert to planning units', () => {
  const c = E.toPlanningUnits(10, 100);        // 10 CTN x 100 = 1000 pieces
  assert.strictEqual(c.value, 1000);
  assert.strictEqual(c.valid, true);
});
test('C1: a missing conversion factor REFUSES rather than guessing', () => {
  assert.strictEqual(E.toPlanningUnits(10, 0).valid, false);
  assert.strictEqual(E.toPlanningUnits(10, null).valid, false);
  assert.strictEqual(E.toPlanningUnits(10, undefined).value, null);
});
test('C1: PO lines aggregate to converted open PO and report unconvertible lines', () => {
  const r = E.convertPoLines([
    {sku:'A', waiting:10, conversionFactor:100},
    {sku:'B', waiting:5,  conversionFactor:1},
    {sku:'C', waiting:7,  conversionFactor:null}]);
  assert.strictEqual(r.openPOConverted, 1005);
  assert.strictEqual(r.unconverted.length, 1);
  assert.strictEqual(r.unconverted[0].sku, 'C');
});
test('C2: KPIs refuse to sum mixed currencies silently', () => {
  const mk=(v,cur)=>({...E.computeRef({invValue:v,onHand:100,openPO:0,histMonthly:2200,consPerDelivery:0.1},
    {lead:3,safetyDays:5,orderFreq:7,moq:0},1000), currency:cur});
  const k = E.portfolioKPIs([mk(10000,'BHD'), mk(10000,'AED')],
    {targetDIO:26,cogsPct:0.33,avgRevPerDelivery:18}, 1000, 'BHD');
  assert.strictEqual(k.currencyMixed, true);
  assert.strictEqual(k.valuesTrustworthy, false);
  assert.deepStrictEqual(k.mixedCurrencies, ['AED']);
});
test('C2: single-currency rows are trustworthy', () => {
  const mk=v=>({...E.computeRef({invValue:v,onHand:100,openPO:0,histMonthly:2200,consPerDelivery:0.1},
    {lead:3,safetyDays:5,orderFreq:7,moq:0},1000), currency:'BHD'});
  const k = E.portfolioKPIs([mk(10000)], {targetDIO:26,cogsPct:0.33,avgRevPerDelivery:18}, 1000, 'BHD');
  assert.strictEqual(k.valuesTrustworthy, true);
});
test('M1: an unplanned ref is NOT counted as Over Stock and does not inflate service level', () => {
  const np = E.computeRef({invValue:100,onHand:100,openPO:0,histMonthly:2200,consPerDelivery:0.1},
                          {lead:0,safetyDays:0,orderFreq:0,moq:0}, dpd);
  const k = E.portfolioKPIs([np], {targetDIO:26,cogsPct:0.33,avgRevPerDelivery:18}, dpd, 'BHD');
  assert.strictEqual(k.counts['Over Stock'], undefined);   // was 1 — a day-one Over-Stock flood
  assert.strictEqual(k.counts['Not Planned'], 1);
  assert.strictEqual(k.active, 0);
  assert.strictEqual(k.unplanned, 1);
  assert.ok(near(k.unplannedShare, 1));
});
test('H1: preferred SKU weighs PLANNING units, so cartons beat loose pieces', () => {
  const r = E.resolveOrderingSku([
    {sku:'CTN', active:true, purchasedQty:30,  purchaseCount:9, conversionFactor:100}, // 3,000
    {sku:'PCS', active:true, purchasedQty:500, purchaseCount:1, conversionFactor:1}]); // 500
  assert.strictEqual(r.sku, 'CTN');            // was PCS
  assert.strictEqual(r.unitNormalized, true);
});
test('H1/R3: a missing conversion factor is surfaced AND blocks history ranking', () => {
  const r = E.resolveOrderingSku([
    {sku:'A', active:true, purchasedQty:10, purchaseCount:1, lastPurchasedAt:'2026-08-01'},
    {sku:'B', active:true, purchasedQty:5,  purchaseCount:1, conversionFactor:2, lastPurchasedAt:'2026-08-09'}]);
  assert.notStrictEqual(r.source, 'history');       // must not rank mixed denominations
  assert.strictEqual(r.unitNormalized, false);
  assert.ok(r.warning);
  assert.strictEqual(r.dataHealth, 'MISSING_CONVERSION_FACTOR');
});
test('M4: unit value falls back to master price when on-hand is zero', () => {
  const r = E.computeRef({invValue:0, onHand:0, openPO:500, histMonthly:2200,
                          consPerDelivery:0.1, masterPrice:2.15}, params, dpd);
  assert.ok(near(r.unitValue, 2.15));
  assert.strictEqual(r.unitValueFallback, true);
  assert.ok(r.targetInvValue > 0);             // was 0 — understated exactly when it matters
});

/* ---- Re-audit residuals (SENT-AUDIT-003) --------------------------------- */
console.log('\nRe-audit fixes — fail-closed money layer and unit philosophy');
test('R1: tenantCurrency is mandatory — omitting it throws, never sums silently', () => {
  assert.throws(() => E.portfolioKPIs([], {targetDIO:26,cogsPct:0.33,avgRevPerDelivery:18}, 1000));
});
test('R1: mixed currencies WITHHOLD money KPIs rather than returning a poisoned sum', () => {
  const mk=(v,cur)=>({...E.computeRef({invValue:v,onHand:100,openPO:0,histMonthly:2200,consPerDelivery:0.1},
    {lead:3,safetyDays:5,orderFreq:7,moq:0},1000), currency:cur});
  const k = E.portfolioKPIs([mk(10000,'BHD'), mk(10000,'AED')],
    {targetDIO:26,cogsPct:0.33,avgRevPerDelivery:18}, 1000, 'BHD');
  assert.strictEqual(k.actualInvValue, null);       // was 20000 — BHD + AED
  assert.strictEqual(k.actualDIO, null);
  assert.strictEqual(k.kpiWithheld, true);
  assert.ok(k.withheldReason);
});
test('R1: normalized rows sum normally', () => {
  const mk=v=>({...E.computeRef({invValue:v,onHand:100,openPO:0,histMonthly:2200,consPerDelivery:0.1},
    {lead:3,safetyDays:5,orderFreq:7,moq:0},1000), currency:'BHD'});
  const k = E.portfolioKPIs([mk(10000), mk(5000)], {targetDIO:26,cogsPct:0.33,avgRevPerDelivery:18}, 1000, 'BHD');
  assert.strictEqual(k.kpiWithheld, false);
  assert.ok(near(k.actualInvValue, 15000));
});
test('R2: service level is null (not 100%) when nothing is plannable', () => {
  const np = E.computeRef({invValue:100,onHand:100,openPO:0,histMonthly:2200,consPerDelivery:0.1},
                          {lead:0,safetyDays:0,orderFreq:0,moq:0}, dpd);
  const k = E.portfolioKPIs([np], {targetDIO:26,cogsPct:0.33,avgRevPerDelivery:18}, dpd, 'BHD');
  assert.strictEqual(k.active, 0);
  assert.strictEqual(k.serviceLevel, null);        // was 1.0 over a dormant catalogue
});
test('R3: a missing conversion factor degrades to recency, never mixed-denomination ranking', () => {
  const r = E.resolveOrderingSku([
    {sku:'CTN', active:true, purchasedQty:30,  purchaseCount:9, lastPurchasedAt:'2026-08-01'},
    {sku:'PCS', active:true, purchasedQty:500, purchaseCount:1, conversionFactor:1, lastPurchasedAt:'2026-08-20'}]);
  assert.strictEqual(r.source, 'recent');          // not 'history' on raw numbers
  assert.strictEqual(r.dataHealth, 'MISSING_CONVERSION_FACTOR');
});
test('R4: shelf-life cap floors rather than rounding up past the cover', () => {
  const r = E.computeRef({...ref, shelfLifeDays: 3}, {...params, moq: 0}, 1020); // J=102
  assert.strictEqual(r.shelfLifeCap, Math.floor(3 * r.dailyConsumption));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
