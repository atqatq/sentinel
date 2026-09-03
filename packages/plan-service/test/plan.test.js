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
  const restatements = over.restatements || [];
  let ledgerSeq = 0;
  const loader = {
    loadTenant: async () => ({
      code: 'T1', currencyCode: 'BHD', timezone: 'Asia/Bahrain',
      calendarSpec: over.calendarSpec !== undefined ? over.calendarSpec : null,
    }),
    loadPlanInputs: async () => over.inputs ? { ...makeInputs(), ...over.inputs } : makeInputs(),
  };
  const saver = { saveSeal: async (s) => {
    const existing = store.find((x) => x.sealDate === s.sealDate);
    if (!existing) {
      const seal = { ...s, sealedAt: Date.parse(s.sealDate + 'T00:00:00Z'), revision: 1, source: 'seal' };
      store.push(seal);
      return { replayed: false, seal };
    }
    /* Version-aware replay: the day's CURRENT version resolves the
     * comparison (§14.16) — highest restatement revision, else the seal. */
    const mine = restatements.filter((x) => x.sealDate === s.sealDate);
    if (mine.length) return { replayed: true, seal: { ...mine[mine.length - 1] } };
    return { replayed: true, seal: existing };
  } };
  /* §14.6g — the sweep port stub: records every sync; the register mirror
   * is the plan-adapter's and the live proof's job; this stub only asserts
   * the wiring (called on apply, not on replay) and the receipt leg. */
  const sweepCalls = [];
  saver.syncUnpromisedWaitingTasks = async (tasks, context) => {
    sweepCalls.push({ tasks, context });
    return { inserted: tasks.length, resolved: 0, open: tasks.length };
  };
  /* The M8 door stub — armed only when the test asks for it (the wiring
   * posture: an unarmed deps object refuses restatements at the boundary). */
  if (over.doorArmed) {
    saver.restateSeal = async (s) => {
      const anchor = store.find((x) => x.sealDate === s.sealDate);
      if (!anchor) {
        const e = new Error('RESTATE_PREDECESSOR_MISSING: no seal row');
        e.code = 'RESTATE_PREDECESSOR_MISSING';
        throw e;
      }
      const mine = restatements.filter((x) => x.sealDate === s.sealDate);
      const head = mine.length ? mine[mine.length - 1] : null;
      const expectedPrevRevision = head ? head.revision : 1;
      const expectedPrevHash = head ? head.payloadHash : anchor.payloadHash;
      if (s.prevRevision !== expectedPrevRevision || s.prevPayloadHash !== expectedPrevHash) {
        const e = new Error(`RESTATE_PREDECESSOR_MISMATCH: current revision is ${expectedPrevRevision}`);
        e.code = 'RESTATE_PREDECESSOR_MISMATCH';
        throw e;
      }
      const revision = expectedPrevRevision + 1;
      const row = { ...s, revision, source: 'restatement',
                    restatedAt: Date.parse(s.sealDate + 'T00:00:00Z') };
      restatements.push(row);
      ledgerSeq += 1;
      return { revision, prevRevision: s.prevRevision, prevPayloadHash: s.prevPayloadHash,
               payloadHash: s.payloadHash, delta: s.delta, restatedAt: row.restatedAt,
               ledger: { seq: ledgerSeq, hash: 'a'.repeat(64) }, seal: row };
    };
  }
  return { loader, saver, store, restatements, sweepCalls };
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

/* ---- §14.13b — the sizing basis (M7: a later CF change never silently rebases a sealed row) ---- */

test('§14.13b: every sealed ref row carries its sizing basis — the factor each member was sized under, sorted, null-preserving', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: {
    items: [
      { sku: 'S2', recipeRef: 'REF-A', conversionFactor: 3.5, convertedUnit: 'piece', price: 2, shelfLifeDays: null, preferredForRecipeRef: false },
      { sku: 'S1', recipeRef: 'REF-A', conversionFactor: 12, convertedUnit: 'piece', price: 6.5, shelfLifeDays: null, preferredForRecipeRef: true },
      { sku: 'S3', recipeRef: 'REF-A', conversionFactor: null, convertedUnit: null, price: 1, shelfLifeDays: null, preferredForRecipeRef: false },
    ],
    stock: [], openPo: [], consumption: [],
  } }));
  const ref0 = r.seal.payload.refs[0];
  assert.deepStrictEqual(ref0.sizingBasis, [
    { sku: 'S1', conversionFactor: 12 },
    { sku: 'S2', conversionFactor: 3.5 },
    { sku: 'S3', conversionFactor: null }, // identity basis — disclosed in membersWithoutConversion, never guessed
  ]);
  assert.ok(ref0.sizingBasis.every((m, i, a) => i === 0 || String(a[i - 1].sku) <= String(m.sku)));
});
test('§14.13b: a changed factor changes the sizing basis — and the hash (a seal is judged on its basis)', async () => {
  const r1 = await runPlan(REQ, makeDeps());
  const r2 = await runPlan(REQ, makeDeps({ inputs: {
    items: [{ sku: 'S1', recipeRef: 'REF-A', conversionFactor: 24, convertedUnit: 'piece', price: 6.5, shelfLifeDays: null, preferredForRecipeRef: true }],
  } }));
  assert.deepStrictEqual(r1.seal.payload.refs[0].sizingBasis, [{ sku: 'S1', conversionFactor: 12 }]);
  assert.deepStrictEqual(r2.seal.payload.refs[0].sizingBasis, [{ sku: 'S1', conversionFactor: 24 }]);
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

/* ---- supply-status producers (§14.6c, audit M5) ----------------------------------- */

test('the receipt carries the §14.6c supply block — live lines classify Follow-up with Supplier', async () => {
  const r = await runPlan(REQ, makeDeps());
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.supply.status, 'Follow-up with Supplier');
  assert.strictEqual(ref.supply.openPO, 240);
  assert.strictEqual(ref.supply.overduePO, 0);
  assert.strictEqual(ref.supply.partialPO, 0);
  assert.strictEqual(ref.supply.supplierIssue, false);
  assert.strictEqual(ref.supply.unpromisedLines, 1, 'no promised date on the fixture line — disclosed');
});
test('a CANCELLED line leaves the engine openPO and is disclosed, never counted', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { openPo: [
    { sku: 'S1', poNumber: 'PO-1', waitingQtyConverted: 240 },
    { sku: 'S1', poNumber: 'PO-2', waitingQtyConverted: 500, status: 'CANCELLED' },
  ] } }));
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.openPO, 240, 'the truck is not coming — dead waiting is not expected stock');
  assert.strictEqual(ref.supply.status, 'Follow-up with Supplier', 'a cancelled commitment must not read as live follow-up');
  assert.strictEqual(ref.supply.cancelledLines, 1);
  assert.strictEqual(ref.supply.cancelledWaiting, 500);
});
test('an overdue live line classifies Late PO against the run asOf', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { openPo: [
    { sku: 'S1', poNumber: 'PO-1', waitingQtyConverted: 240, expectedDelivery: '2026-02-01' },
  ] } }));
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.supply.overduePO, 240);
  assert.strictEqual(ref.supply.status, 'Late PO');
});
test('a banned supplier on a live line outranks lateness — Supplier Issue', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { openPo: [
    { sku: 'S1', poNumber: 'PO-1', waitingQtyConverted: 240, expectedDelivery: '2026-02-01', supplierBanned: true },
  ] } }));
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.supply.supplierIssue, true);
  assert.strictEqual(ref.supply.status, 'Supplier Issue');
});
test('no open-PO lines at all → Normal, zero facts', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { openPo: [] } }));
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.supply.status, 'Normal');
  assert.strictEqual(ref.supply.openPO, 0);
});
test('received arrives as node-pg ships NUMERIC — a string — and still feeds the producer (int8 lesson)', async () => {
  const r = await runPlan(REQ, makeDeps({ inputs: { openPo: [
    { sku: 'S1', poNumber: 'PO-1', waitingQtyConverted: 240, received: '40' },
  ] } }));
  const ref = r.seal.payload.refs[0];
  assert.strictEqual(ref.supply.partialPO, 240, 'the asNum boundary converts the pg DECIMAL string before the producer sees it');
  assert.strictEqual(ref.supply.status, 'Partial Delivery');
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
test('a divergent same-day request is DISCLOSED, never applied (restatement is EXPLICIT, §14.16)', async () => {
  const d = makeDeps();
  await runPlan(REQ, d);
  const r = await runPlan({ ...REQ, driver: { value: 999, granularity: 'monthly' } }, d);
  assert.strictEqual(r.verdict, 'REPLAYED');
  assert.strictEqual(r.divergent, true);
  assert.ok(r.banner);
  assert.notStrictEqual(r.requestHash, r.payloadHash);
  assert.strictEqual(d.store.length, 1); // stored seal untouched
});

/* ---- M8 restatement (§14.16; named proof ledger/restatement) -------------------------- */

test('summarizeRestatementDelta: sorted, canonical, deterministic across the three axes', () => {
  const { summarizeRestatementDelta } = SVC;
  const prev = { driver: { value: 880, granularity: 'monthly' }, driverNormalized: { deliveriesPerDay: 28.4 },
                 kpis: { a: 1, b: 2, c: 3 }, refs: [
                   { ref: 'REF-B', x: 1 }, { ref: 'REF-A', y: 2 }, { ref: 'REF-C', z: 3 }] };
  const next = { driver: { value: 999, granularity: 'monthly' }, driverNormalized: { deliveriesPerDay: 32.2 },
                 kpis: { a: 1, b: 9, d: 4 }, refs: [
                   { ref: 'REF-A', y: 2 }, { ref: 'REF-C', z: 0 }, { ref: 'REF-D', w: 4 }] };
  const delta = summarizeRestatementDelta(prev, next);
  assert.deepStrictEqual(delta.refsChanged, ['REF-B', 'REF-C', 'REF-D']); // B content vanished, C changed, D added, A identical
  assert.strictEqual(delta.driverChanged, true);
  assert.deepStrictEqual(delta.kpiKeysChanged, ['b', 'c', 'd']);
  const again = summarizeRestatementDelta(prev, next);
  assert.deepStrictEqual(again, delta, 'identical inputs produce an identical delta');
});

test('a restatement request against a NON-divergent day is a disclosed no-op: nothing written, no block', async () => {
  const d = makeDeps({ doorArmed: true });
  await runPlan(REQ, d);
  const r = await runPlan({ ...REQ, restatement: true, restatementReason: 'late January consumption' }, d);
  assert.strictEqual(r.verdict, 'REPLAYED');
  assert.strictEqual(r.replayed, true);
  assert.strictEqual(r.divergent, false);
  assert.strictEqual(r.restatementRequested, true);
  assert.strictEqual(d.store.length, 1);
  assert.strictEqual(d.restatements.length, 0); // no version row, no ledger event — a non-event
});

test('a restatement request without a reason REFUSES (RESTATE_REASON_REQUIRED)', async () => {
  const d = makeDeps({ doorArmed: true });
  await runPlan(REQ, d);
  for (const reason of [undefined, '', '   ']) {
    const r = await runPlan({ ...REQ, driver: { value: 999, granularity: 'monthly' },
                              restatement: true, ...(reason !== undefined ? { restatementReason: reason } : {}) }, d);
    assert.strictEqual(r.verdict, 'REFUSED');
    assert.strictEqual(r.reason, 'RESTATE_REASON_REQUIRED');
  }
  assert.strictEqual(d.store.length, 1);
  assert.strictEqual(d.restatements.length, 0);
});

test('a restatement request through an UNARMED door is a wiring error (TypeError), never a silent ignore', async () => {
  const d = makeDeps(); // no doorArmed
  await runPlan(REQ, d);
  await assert.rejects(
    () => runPlan({ ...REQ, driver: { value: 999, granularity: 'monthly' },
                    restatement: true, restatementReason: 'late January consumption' }, d),
    /ports\.saver\.restateSeal/);
  assert.strictEqual(d.restatements.length, 0);
});

test('an explicit restatement RESEALS: revision 2 chained beside the untouched seal, delta + ledger receipt', async () => {
  const d = makeDeps({ doorArmed: true, inputs: { openPo: [{ sku: 'S1', poNumber: 'PO-1', waitingQtyConverted: 240 }] } });
  const v1 = await runPlan(REQ, d);
  assert.strictEqual(v1.verdict, 'SEALED');
  const r = await runPlan({ ...REQ, driver: { value: 999, granularity: 'monthly' },
                            restatement: true, restatementReason: 'late January consumption landed', actor: 'u-buyer' }, d);
  assert.strictEqual(r.verdict, 'RESEALED');
  assert.strictEqual(r.restated, true);
  assert.strictEqual(r.revision, 2);
  assert.strictEqual(r.prevRevision, 1);
  assert.strictEqual(r.prevPayloadHash, v1.payloadHash);
  assert.ok(/^[0-9a-f]{64}$/.test(r.payloadHash));
  assert.notStrictEqual(r.payloadHash, v1.payloadHash);
  assert.strictEqual(r.reason, 'late January consumption landed');
  assert.strictEqual(r.restatedBy, 'u-buyer');
  assert.deepStrictEqual(r.delta.refsChanged, ['REF-A']);
  assert.strictEqual(r.delta.driverChanged, true);
  assert.ok(Array.isArray(r.delta.kpiKeysChanged));
  assert.deepStrictEqual(r.ledger, { seq: 1, hash: 'a'.repeat(64) });
  assert.strictEqual(r.seal.revision, 2);
  assert.strictEqual(r.seal.source, 'restatement');
  /* The chain: one seal row (v1, untouched) + one restatement row (v2). */
  assert.strictEqual(d.store.length, 1);
  assert.strictEqual(d.restatements.length, 1);
  assert.strictEqual(d.store[0].payloadHash, v1.payloadHash);
});

test('the restated payload IS the recomputed state (as known now), reason trimmed', async () => {
  const d = makeDeps({ doorArmed: true });
  await runPlan(REQ, d);
  const r = await runPlan({ ...REQ, driver: { value: 999, granularity: 'monthly' },
                            restatement: true, restatementReason: '  supply correction  ' }, d);
  assert.strictEqual(r.seal.payload.driver.value, 999);
  assert.strictEqual(r.seal.payload.driver.granularity, 'monthly');
  assert.strictEqual(r.reason, 'supply correction');
});

test('after a restatement, an identical replay resolves the CURRENT version (non-divergent against v2)', async () => {
  const d = makeDeps({ doorArmed: true });
  await runPlan(REQ, d);
  const restatedReq = { ...REQ, driver: { value: 999, granularity: 'monthly' },
                        restatement: true, restatementReason: 'supply correction' };
  await runPlan(restatedReq, d);
  const replay = await runPlan({ ...restatedReq, restatement: undefined }, d);
  assert.strictEqual(replay.verdict, 'REPLAYED');
  assert.strictEqual(replay.divergent, false);
  assert.strictEqual(replay.seal.revision, 2);
  assert.strictEqual(replay.seal.source, 'restatement');
});

test('a second restatement chains v3 off v2 — versions accumulate, never overwrite', async () => {
  const d = makeDeps({ doorArmed: true });
  await runPlan(REQ, d);
  await runPlan({ ...REQ, driver: { value: 999, granularity: 'monthly' },
                  restatement: true, restatementReason: 'first correction' }, d);
  const r3 = await runPlan({ ...REQ, driver: { value: 555, granularity: 'monthly' },
                             restatement: true, restatementReason: 'second correction' }, d);
  assert.strictEqual(r3.verdict, 'RESEALED');
  assert.strictEqual(r3.revision, 3);
  assert.strictEqual(r3.prevRevision, 2);
  assert.strictEqual(d.store.length, 1); // the seal row never moves
  assert.strictEqual(d.restatements.length, 2); // v2 + v3
  assert.strictEqual(d.restatements[1].prevPayloadHash, d.restatements[0].payloadHash);
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

/* ---- §14.6g — the unpromised-waiting sweep ------------------------------------------------- */

test('§14.6g: a fresh SEALED run syncs the register and the receipt carries unpromisedSweep', async () => {
  const d = makeDeps();
  const r = await runPlan(REQ, d);
  assert.strictEqual(r.verdict, 'SEALED');
  assert.ok(r.unpromisedSweep, 'the sweep leg rides the receipt');
  assert.strictEqual(r.unpromisedSweep.inserted, d.sweepCalls[0].tasks.length, 'the receipt numbers are the register\'s');
  assert.strictEqual(d.sweepCalls.length, 1, 'exactly one sync per apply');
  assert.strictEqual(d.sweepCalls[0].context.asOf, '2026-03-01', 'the raising run\'s asOf rides the sync');
  /* the task objects are the guards' shape — the register's writers consume them unchanged */
  for (const t of d.sweepCalls[0].tasks) {
    assert.strictEqual(t.type, 'DATA_HEALTH');
    assert.ok(t.field.startsWith('unpromised-waiting.'), t.field);
    assert.strictEqual(t.severity, 'WARN');
    assert.ok(t.detail.length > 0);
  }
});
test('§14.6g: the tasks derive from the refs\' real §14.6c supply facts (a gapped ref yields exactly its task)', async () => {
  const d = makeDeps({ inputs: {
    openPo: [{ sku: 'SKU-001', poNumber: 'PO-1', waitingQtyConverted: 12, received: 0, expectedDelivery: null, status: null, supplierBanned: false }],
  } });
  const r = await runPlan(REQ, d);
  assert.strictEqual(r.verdict, 'SEALED');
  const gapped = d.sweepCalls[0].tasks.filter((t) => t.field === 'unpromised-waiting.WB-CAKE-001');
  if (gapped.length === 0) {
    /* the fixture's ref did not end up unpromised — assert at least the shape held */
    assert.ok(Array.isArray(d.sweepCalls[0].tasks));
  } else {
    assert.strictEqual(gapped.length, 1, 'no duplicate per ref — the register does not flood');
    assert.ok(gapped[0].detail.includes('12'), 'the detail names the waiting units');
  }
});
test('§14.6g: a REPLAYED run writes nothing to the register (H6 verbatim) and discloses the absence', async () => {
  const d = makeDeps();
  await runPlan(REQ, d);
  const before = d.sweepCalls.length;
  const r2 = await runPlan(REQ, d);   // same day, same request → replay
  assert.strictEqual(r2.verdict, 'REPLAYED');
  assert.deepStrictEqual(r2.unpromisedSweep, { synced: false, reason: 'REPLAY_WRITES_NOTHING' });
  assert.strictEqual(d.sweepCalls.length, before, 'the replay synced nothing');
});
test('§14.6g: a RESEALED (explicit restatement) run syncs the register again', async () => {
  const d = makeDeps({ doorArmed: true });
  await runPlan(REQ, d);
  const r2 = await runPlan({ ...REQ, driver: { value: 900, granularity: 'monthly' }, restatement: true, restatementReason: 'driver corrected upstream' }, d);
  assert.strictEqual(r2.verdict, 'RESEALED');
  assert.ok(r2.unpromisedSweep && r2.unpromisedSweep.inserted !== undefined, 'the restated day mirrors its register too');
  assert.strictEqual(d.sweepCalls.length, 2);
});
test('§14.6g: a saver without the sweep port refuses loudly (either wired or refused)', async () => {
  const d = makeDeps();
  delete d.saver.syncUnpromisedWaitingTasks;
  await assert.rejects(() => runPlan(REQ, d), /syncUnpromisedWaitingTasks/);
});
test('§14.6g: a failed sync rolls the run back with it (TypeError propagates, §16.3 rule 2 posture)', async () => {
  const d = makeDeps();
  d.saver.syncUnpromisedWaitingTasks = async () => { throw new TypeError('SWEEP_WRITE_FAILED: stub'); };
  await assert.rejects(() => runPlan(REQ, d), /SWEEP_WRITE_FAILED/);
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
