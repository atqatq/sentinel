'use strict';
/* ============================================================================
 * plan-service unit suite — engine live wiring + sealed snapshots.
 *
 * Zero dependencies, ports faked in-memory. Every test is named after the
 * requirement it pins (delivery spec §5.1 — the name is the traceability
 * link). The LIVE proof (real PostgreSQL, RLS, replay against the actual
 * plan_seal unique) is packages/db/test/plan-seal-live.js.
 * ==========================================================================*/
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const SVC = require(path.join(__dirname, '..'));
const { runPlan, handlePlanRun, canonicalJson } = SVC;
const E = require(path.join(__dirname, '..', '..', 'core', 'modules', 'planning-engine'));
const CAL = require(path.join(__dirname, '..', '..', 'core', 'modules', 'calendar'));
const { SCHEMA_VERSION } = require(path.join(__dirname, '..', '..', 'db'));

let passed = 0, failed = 0;
const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }
async function run(tests) {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name); }
    catch (e) { failed++; console.log('  ✗ ' + t.name + '\n      ' + e.message); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

/* ---- fixtures -------------------------------------------------------------- */

function makeInputs(over = {}) {
  return {
    paramsByRef: {
      'REF-A': { lead: { manual: 5 }, safetyDays: { manual: 3 }, orderFreq: { manual: 7 }, moq: { manual: 50 } },
    },
    items: [
      { sku: 'S1', recipeRef: 'REF-A', conversionFactor: 12, convertedUnit: 'piece', price: 6.5, shelfLifeDays: null, preferredForRecipeRef: true },
    ],
    stock: [
      { sku: 'S1', quantity: 10, tenantValue: 72, currency: 'BHD' },
      { sku: 'S1', quantity: 2, tenantValue: 14.4, currency: 'BHD' },
    ],
    openPo: [{ sku: 'S1', poNumber: 'PO-1', waitingQtyConverted: 240 }],
    consumption: [
      { sku: 'S1', start: '2026-01-01', end: '2026-01-31', startBalance: 100, goodsIn: 500, goodsOut: 50, endBalance: 200 },
      { sku: 'S1', start: '2026-02-01', end: '2026-02-28', startBalance: 200, goodsIn: 300, goodsOut: 60, endBalance: 60 },
    ],
    deliveries: Array.from({ length: 59 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      return { start: day, end: day, deliveries: 100 };
    }),
    latestSeal: null,
    ...over,
  };
}

function makeDeps(over = {}) {
  const store = over.store || [];
  const loader = {
    loadTenant: async () => ({
      code: 'T1', currencyCode: 'BHD', timezone: 'Asia/Bahrain',
      calendarSpec: over.calendarSpec !== undefined ? over.calendarSpec : null,
    }),
    loadPlanInputs: async () => over.inputs ? { ...makeInputs(), ...over.inputs } : makeInputs(),
  };
  const saver = { saveSeal: async (s) => {
    const existing = store.find((x) => x.sealDate === s.sealDate);
    if (existing) return { replayed: true, seal: existing };
    const seal = { ...s, sealedAt: Date.parse(s.sealDate + 'T00:00:00Z') };
    store.push(seal);
    return { replayed: false, seal };
  } };
  return { loader, saver, store };
}

const REQ = { tenantId: 't1', asOf: '2026-03-01', driver: { value: 880, granularity: 'monthly' } };

/* ---- canonicalJson ---------------------------------------------------------- */

test('canonicalJson: nested key order never changes the hash input', () => {
  assert.strictEqual(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  const a = canonicalJson({ z: { y: 1, x: [2, { c: 3, b: 4 }] } });
  const b = canonicalJson({ z: { x: [2, { b: 4, c: 3 }], y: 1 } });
  assert.strictEqual(a, b);
});
test('canonicalJson: arrays keep order; undefined values are dropped', () => {
  assert.strictEqual(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.strictEqual(canonicalJson({ a: 1, ghost: undefined }), '{"a":1}');
});
test('canonicalJson: rejects non-JSON values loudly', () => {
  assert.throws(() => canonicalJson(() => 1), TypeError);
});

/* ---- the sealed run ---------------------------------------------------------- */

test('a planned tenant-day SEALS: full receipt with stamps and seal', async () => {
  const d = makeDeps();
  const r = await runPlan(REQ, d);
  assert.strictEqual(r.verdict, 'SEALED');
  assert.strictEqual(r.replayed, false);
  assert.strictEqual(r.sealDate, '2026-03-01');
  assert.ok(/^[0-9a-f]{64}$/.test(r.payloadHash));
  assert.strictEqual(r.engineVersion, E.ENGINE_VERSION);
  assert.strictEqual(r.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(r.seal.payloadHash, r.payloadHash);
});
test('L-07: the seal payload carries ENGINE_VERSION and SCHEMA_VERSION', async () => {
  const r = await runPlan(REQ, makeDeps());
  assert.strictEqual(r.seal.payload.engineVersion, E.ENGINE_VERSION);
  assert.strictEqual(r.seal.payload.schemaVersion, SCHEMA_VERSION);
});
test('identical inputs produce an identical payload hash — row order is irrelevant', async () => {
  const shuffled = makeInputs({
    items: [makeInputs().items[0]],
    stock: [makeInputs().stock[1], makeInputs().stock[0]],
    deliveries: [...makeInputs().deliveries].reverse(),
  });
  const r1 = await runPlan(REQ, makeDeps());
  const r2 = await runPlan(REQ, makeDeps({ inputs: shuffled }));
  assert.strictEqual(r1.payloadHash, r2.payloadHash);
});
test('different inputs produce a different hash (the seal is a real fingerprint)', async () => {
  const r1 = await runPlan(REQ, makeDeps());
  const r2 = await runPlan({ ...REQ, driver: { value: 900, granularity: 'monthly' } }, makeDeps());
  assert.notStrictEqual(r1.payloadHash, r2.payloadHash);
});

/* ---- the driver (deliveries dashboard convention) ----------------------------- */

test('driver is the dashboard entry: monthly 880 → dpd 40 on the flat basis', async () => {
  const r = await runPlan(REQ, makeDeps());
  assert.ok(Math.abs(r.seal.payload.driverNormalized.deliveriesPerDay - 40) < 1e-12);
  assert.strictEqual(r.seal.payload.driverNormalized.confidence, 'low');
});
test('a negative driver is REFUSED with a data-health task (INVALID_DRIVER)', async () => {
  const r = await runPlan({ ...REQ, driver: { value: -5, granularity: 'monthly' } }, makeDeps());
  assert.strictEqual(r.verdict, 'REFUSED');
  assert.strictEqual(r.reason, 'INVALID_DRIVER');
  assert.ok(r.task && r.task.type === 'DATA_HEALTH');
});
test('ytd without monthsElapsed is an invalid request (400-class)', async () => {
  const r = await runPlan({ ...REQ, driver: { value: 880, granularity: 'ytd' } }, makeDeps());
  assert.strictEqual(r.reason, 'INVALID_REQUEST');
  assert.ok(!r.task);
});

/* ---- request shape ------------------------------------------------------------ */

test('a malformed request is refused INVALID_REQUEST (missing driver)', async () => {
  const r = await runPlan({ tenantId: 't1', asOf: '2026-03-01' }, makeDeps());
  assert.strictEqual(r.reason, 'INVALID_REQUEST');
});
test('an impossible asOf is refused (round-trip date check)', async () => {
  const r = await runPlan({ ...REQ, asOf: '2026-02-30' }, makeDeps());
  assert.strictEqual(r.reason, 'INVALID_REQUEST');
});
test('an unknown granularity is refused INVALID_REQUEST', async () => {
  const r = await runPlan({ ...REQ, driver: { value: 5, granularity: 'decadally' } }, makeDeps());
  assert.strictEqual(r.reason, 'INVALID_REQUEST');
});

/* ---- tenant guard rails (R1) --------------------------------------------------- */

test('missing tenant refuses MISSING_TENANT', async () => {
  const d = makeDeps();
  d.loader.loadTenant = async () => null;
  const r = await runPlan(REQ, d);
  assert.strictEqual(r.reason, 'MISSING_TENANT');
});
test('tenant without currency refuses MISSING_TENANT_CURRENCY with a task (R1 fail-closed)', async () => {
  const d = makeDeps();
  d.loader.loadTenant = async () => ({ code: 'T1', currencyCode: '', timezone: 'Asia/Bahrain', calendarSpec: null });
  const r = await runPlan(REQ, d);
  assert.strictEqual(r.verdict, 'REFUSED');
  assert.strictEqual(r.reason, 'MISSING_TENANT_CURRENCY');
  assert.ok(r.task && r.task.type === 'DATA_HEALTH');
  assert.ok(r.banner);
});
test('a corrupt tenant calendar refuses the run (fail-closed, never defaulted)', async () => {
  const r = await runPlan(REQ, makeDeps({ calendarSpec: { kind: 'weekly', workingDays: [9] } }));
  assert.strictEqual(r.verdict, 'REFUSED');
  assert.strictEqual(r.reason, 'INVALID_CALENDAR');
});

/* ---- §14.4b identical basis with a real calendar -------------------------------- */

test('a real calendar feeds the SAME wd to the driver divisor and the magnification', async () => {
  const cal = { kind: 'weekly', workingDays: [0, 1, 2, 3, 4] }; // GCC week, Jan 2026
  const r = await runPlan(REQ, makeDeps({ calendarSpec: cal }));
  const wd = CAL.workingDaysInMonth(CAL.parseCalendar(cal).calendar, 2026, 3).count;
  assert.strictEqual(r.seal.payload.refs[0].workingDays, wd);        // magnification basis
  assert.strictEqual(r.seal.payload.workingDays, wd);
  const wdJan = CAL.workingDaysInMonth(CAL.parseCalendar(cal).calendar, 2026, 1).count;
  assert.ok(wd > 0 && wdJan > 0); // sanity: the basis is calendar-derived, not the 22 constant
});
test('a flat tenant calendar computes byte-identically to the workbook default', async () => {
  const flat = await runPlan(REQ, makeDeps({ calendarSpec: { kind: 'flat' } }));
  const none = await runPlan(REQ, makeDeps());
  assert.deepStrictEqual(flat.seal.payload.driverNormalized, none.seal.payload.driverNormalized);
  const fr = flat.seal.payload.refs[0]; const nr = none.seal.payload.refs[0];
  assert.strictEqual(fr.workingDays, nr.workingDays);
  assert.strictEqual(fr.monthlyMagnified, nr.monthlyMagnified);
  assert.strictEqual(fr.consPerDelivery, nr.consPerDelivery);
  assert.strictEqual(flat.seal.payload.portfolio.actualInvValue, none.seal.payload.portfolio.actualInvValue);
});

/* ---- rate seeding (H8 + canon) --------------------------------------------------- */

test('consPerDelivery = converted window consumption / guarded window deliveries (canon echo)', async () => {
  const r = await runPlan(REQ, makeDeps());
  const ref = r.seal.payload.refs[0];
  // S(Jan) = 100+500-200-50 = 350 ; S(Feb) = 200+300-60-60 = 380 ; T = (350+380)*12 = 8760
  assert.strictEqual(ref.rateInputs.consumptionConverted, 8760);
  assert.strictEqual(ref.rateInputs.histTotalDeliveries, 5900);
  assert.ok(Math.abs(ref.consPerDelivery - 8760 / 5900) < 1e-12);
  assert.ok(Math.abs(ref.histMonthly - 8760 / 2) < 1e-12); // histMonths = window month span = 2
  assert.strictEqual(ref.rateInputs.partialEdge.length, 0);
});
test('an uncovered consumption window refuses the RUN (WINDOW_NOT_COVERED rides through)', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { deliveries: makeInputs().deliveries.slice(0, 20) } }));
  assert.strictEqual(r.verdict, 'REFUSED');
  assert.strictEqual(r.reason, 'WINDOW_NOT_COVERED');
  assert.ok(Array.isArray(r.gaps) && r.gaps.length > 0);
  assert.ok(r.task && r.task.type === 'DATA_HEALTH');
  assert.ok(r.banner);
});
test('no deliveries history refuses the seed (NO_DELIVERIES_HISTORY)', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { deliveries: [] } }));
  assert.strictEqual(r.reason, 'NO_DELIVERIES_HISTORY');
  assert.ok(r.task);
});
test('a negative deliveries row refuses the seed with its index (INVALID_DELIVERIES_VALUE)', async () => {
  const deliveries = makeInputs().deliveries;
  deliveries[10] = { ...deliveries[10], deliveries: -3 };
  const r = await runPlan(REQ, makeDeps({ inputs: { deliveries } }));
  assert.strictEqual(r.reason, 'INVALID_DELIVERIES_VALUE');
  assert.strictEqual(r.index, 10);
});

/* ---- member aggregation (C1 discipline at planning time) -------------------------- */

test('stock converts to planning units and tenant value sums (H1 discipline)', async () => {
  const r = await runPlan(REQ, makeDeps());
  const ref = r.seal.payload.refs[0];
  assert.ok(Math.abs(ref.onHand - 144) < 1e-9);  // (10+2) × 12
  assert.ok(Math.abs(ref.invValue - 86.4) < 1e-9);
});
test('open PO sums the C1-converted waiting quantities', async () => {
  const r = await runPlan(REQ, makeDeps());
  assert.strictEqual(r.seal.payload.refs[0].openPO, 240);
});
test('unconverted open-PO rows are excluded AND disclosed, never guessed', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { openPo: [
    { sku: 'S1', poNumber: 'PO-1', waitingQtyConverted: 240 },
    { sku: 'S1', poNumber: 'PO-2', waitingQtyConverted: null },
  ] } }));
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.openPO, 240);
  assert.deepStrictEqual(r.seal.payload.disclosures.unconvertedOpenPo, [{ sku: 'S1', poNumber: 'PO-2' }]);
});
test('a member declaring a converted unit without a factor refuses the run (R3)', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { items: [
    { sku: 'S1', recipeRef: 'REF-A', conversionFactor: null, convertedUnit: 'piece', price: 6.5, shelfLifeDays: null, preferredForRecipeRef: true },
  ] } }));
  assert.strictEqual(r.verdict, 'REFUSED');
  assert.strictEqual(r.reason, 'UNCONVERTIBLE_MEMBER');
  assert.ok(r.task);
});
test('a member whose unit IS the planning unit converts by identity and is disclosed', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: {
    items: [{ sku: 'S1', recipeRef: 'REF-A', conversionFactor: null, convertedUnit: null, price: 6.5, shelfLifeDays: null, preferredForRecipeRef: true }],
    stock: [{ sku: 'S1', quantity: 12, tenantValue: 20, currency: 'BHD' }],
  } }));
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.onHand, 12);
  assert.deepStrictEqual(r.seal.payload.disclosures.membersWithoutConversion, ['S1']);
});
test('stock rows for unknown SKUs are excluded and disclosed', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { stock: [
    { sku: 'S1', quantity: 10, tenantValue: 72, currency: 'BHD' },
    { sku: 'GHOST', quantity: 99, tenantValue: 1, currency: 'BHD' },
  ] } }));
  assert.strictEqual(r.seal.payload.refs[0].onHand, 120); // 10 × 12 only
  assert.deepStrictEqual(r.seal.payload.disclosures.unknownSkuStock, ['GHOST']);
});
test('a non-numeric tenant stock value refuses with a data-health task', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { stock: [{ sku: 'S1', quantity: 10, tenantValue: 'N/A', currency: 'BHD' }] } }));
  assert.strictEqual(r.reason, 'INVALID_STOCK_VALUE');
  assert.ok(r.task);
});
test('a consumption row with impossible dates refuses with a data-health task', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { consumption: [
    { sku: 'S1', start: '2026-13-01', end: '2026-13-31', startBalance: 1, goodsIn: 1, goodsOut: 0, endBalance: 2 },
  ] } }));
  assert.strictEqual(r.reason, 'INVALID_CONSUMPTION_ENTRY');
  assert.ok(r.task);
});

/* ---- day-one honesty (dataState through the catalog) ------------------------------- */

test('a ref without consumption is the honest day-one case: NO_USAGE, rate 0', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { consumption: [] } }));
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.dataState, 'NO_USAGE');
  assert.strictEqual(ref.consPerDelivery, 0);
  assert.strictEqual(r.seal.payload.kpis.results.length > 0, true);
});
test('a consuming ref without params is NOT PLANNED, never a fake Over Stock', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { paramsByRef: {} } }));
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.dataState, 'NO_PARAMS');
  assert.strictEqual(E.displayStatus(ref), 'Not Planned');
});
test('an empty portfolio still SEALS with an insufficient-data service level (R2)', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { paramsByRef: {}, items: [], stock: [], openPo: [], consumption: [] } }));
  assert.strictEqual(r.verdict, 'SEALED');
  assert.strictEqual(r.seal.payload.counts.refs, 0);
  const sl = r.seal.payload.kpis.results.find((k) => k.metric === 'serviceLevel');
  assert.strictEqual(sl.dataState, 'INSUFFICIENT_DATA');
});

/* ---- replay (H6 in spirit; M8 owns restatement) -------------------------------------- */

test('a same-day rerun REPLAYS the stored seal — no second row, no recompute', async () => {
  const d = makeDeps();
  const r1 = await runPlan(REQ, d);
  const r2 = await runPlan(REQ, d);
  assert.strictEqual(r2.verdict, 'REPLAYED');
  assert.strictEqual(r2.replayed, true);
  assert.strictEqual(r2.divergent, false);
  assert.strictEqual(r2.payloadHash, r1.payloadHash);
  assert.strictEqual(d.store.length, 1);
});
test('a divergent same-day request is DISCLOSED, never applied (restatement is M8)', async () => {
  const d = makeDeps();
  await runPlan(REQ, d);
  const r = await runPlan({ ...REQ, driver: { value: 999, granularity: 'monthly' } }, d);
  assert.strictEqual(r.verdict, 'REPLAYED');
  assert.strictEqual(r.divergent, true);
  assert.ok(r.banner);
  assert.notStrictEqual(r.requestHash, r.payloadHash);
  assert.strictEqual(d.store.length, 1); // stored seal untouched
});

/* ---- wiring errors (TypeError per module convention) ----------------------------------- */

test('missing ports or wrong port shapes are wiring errors, not refusals', async () => {
  await assert.rejects(async () => runPlan(REQ, null), TypeError);
  await assert.rejects(async () => runPlan(REQ, {}), TypeError);
  await assert.rejects(async () => runPlan(REQ, { loader: {}, saver: {} }), TypeError);
});
test('a saver returning garbage is a wiring error', async () => {
  const d = makeDeps();
  d.saver.saveSeal = async () => ({ replayed: false });
  await assert.rejects(() => runPlan(REQ, d), TypeError);
});

/* ---- the API boundary --------------------------------------------------------------------- */

test('handler maps SEALED → 200 and the receipt IS the body', async () => {
  const res = await handlePlanRun(REQ, makeDeps());
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.verdict, 'SEALED');
});
test('handler maps request-shape refusals → 400 (no task)', async () => {
  const res = await handlePlanRun({ tenantId: 't1', asOf: 'nope', driver: { value: 1, granularity: 'daily' } }, makeDeps());
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.reason, 'INVALID_REQUEST');
});
test('handler maps data-health refusals → 422 with the task attached', async () => {
  const res = await handlePlanRun({ ...REQ, driver: { value: -5, granularity: 'monthly' } }, makeDeps());
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.json.reason, 'INVALID_DRIVER');
  assert.ok(res.json.task);
});
test('handler maps wiring failures → 500 with verdict ERROR', async () => {
  const res = await handlePlanRun(REQ, null);
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.json.verdict, 'ERROR');
});

(async () => { await run(TESTS); })();
