'use strict';
/* ============================================================================
 * perf/mrp-scale — the §14.22 scale-profile gate (DoD #8).
 *
 * "MRP board p95 < 500 ms at 4,000+ refs" measured at the runPlan boundary —
 * the board's server cost IS the engine-live run (sort → assembleRef → the
 * computeRef ladder per ref → portfolio KPIs → KPI envelope → payload hash).
 * Nothing narrower is timed: a microbenchmark proves a number nobody asked for.
 *
 * The profile is frozen as data (loosening a target is a spec amendment,
 * never a code edit):
 *   SCALE_REFS    4200   — ≥ 4,000 refs with margin
 *   SCALE_RUNS    25     — measured runs after warmup
 *   P95_BUDGET_MS 500    — the DoD #8 budget; a breach fails loud
 *
 * Determinism is part of the proof: the synthetic portfolio comes from a
 * seeded mulberry32 PRNG (fixed seed) — the same machine-independent dataset
 * on every run, so a p95 regression is the code, never the data. Every
 * measured run must return SEALED with exactly SCALE_REFS refs; a fast
 * wrong answer is not a pass. All SKUs are PERF-S* synthetic — no production
 * data ever rides this harness.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const { runPlan } = require(path.join(__dirname, '..'));

/* ---- the frozen §14.22 profile ------------------------------------------- */
const SCALE_REFS = 4200;
const SCALE_RUNS = 25;
const P95_BUDGET_MS = 500;
const SEED = 0x53E4D1A5;

/* ---- mulberry32 — seeded, machine-independent PRNG ------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- the synthetic portfolio — §6.3 M1 window shapes, at scale ------------
 * 1–3 recipe members per ref (avg 2), two stock rows per SKU, one open-PO
 * line per three SKUs, the 3-month consumption history per SKU (Dec–Feb),
 * and the 90-day daily deliveries history that covers it (H8).            */
function buildScaleInputs() {
  const next = mulberry32(SEED);
  const ri = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // inclusive int
  const rf = (lo, hi) => lo + next() * (hi - lo);

  const paramsByRef = {};
  const items = [];
  const stock = [];
  const openPo = [];
  const consumption = [];

  const DAYS = (() => {
    const days = [];
    for (let d = new Date(Date.UTC(2025, 11, 1)); d < new Date(Date.UTC(2026, 2, 1)); d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
    return days; // 2025-12-01 .. 2026-02-28 — 90 days
  })();

  const MONTHS = [
    { start: '2025-12-01', end: '2025-12-31' },
    { start: '2026-01-01', end: '2026-01-31' },
    { start: '2026-02-01', end: '2026-02-28' },
  ];

  let skuSeq = 0;
  for (let r = 0; r < SCALE_REFS; r++) {
    const ref = `PERF-R${String(r + 1).padStart(5, '0')}`;
    paramsByRef[ref] = {
      lead: { manual: ri(1, 14) },
      safetyDays: { manual: ri(0, 10) },
      orderFreq: { manual: ri(1, 14) },
      moq: { manual: ri(10, 500) },
    };
    const members = 1 + (r % 3); // 1–3, avg 2
    for (let m = 0; m < members; m++) {
      const sku = `PERF-S${String(++skuSeq).padStart(6, '0')}`;
      items.push({
        sku, recipeRef: ref,
        conversionFactor: rf(1, 48),
        convertedUnit: 'piece',
        price: Number(rf(0.5, 90).toFixed(2)),
        shelfLifeDays: null,
        preferredForRecipeRef: true,
      });
      stock.push({ sku, quantity: ri(20, 2000), tenantValue: Number(rf(40, 40000).toFixed(2)), currency: 'BHD' });
      stock.push({ sku, quantity: ri(5, 400), tenantValue: Number(rf(10, 8000).toFixed(2)), currency: 'BHD' });
      if (skuSeq % 3 === 0) {
        openPo.push({ sku, poNumber: `PO-${String(skuSeq).padStart(6, '0')}`, waitingQtyConverted: ri(50, 4000), received: 0, status: 'OPEN' });
      }
      for (const mo of MONTHS) {
        consumption.push({
          sku, start: mo.start, end: mo.end,
          startBalance: ri(100, 3000), goodsIn: ri(200, 5000),
          goodsOut: ri(0, 200), endBalance: ri(50, 2500),
        });
      }
    }
  }

  const deliveries = DAYS.map((day) => ({ start: day, end: day, deliveries: ri(24, 34) }));

  return { paramsByRef, items, stock, openPo, consumption, deliveries };
}

/* ---- in-memory ports — the same shape plan.test.js fakes, at scale -------- */
function makePorts(inputs) {
  return {
    loader: {
      loadTenant: async () => ({ code: 'PERF-T1', currencyCode: 'BHD', timezone: 'Asia/Bahrain', calendarSpec: null }),
      loadPlanInputs: async () => inputs,
    },
    saver: {
      saveSeal: async ({ payloadHash, payload }) => ({ replayed: false, seal: { payloadHash, payload } }),
      syncUnpromisedWaitingTasks: async () => ({ inserted: 0, resolved: 0, open: 0 }),
    },
  };
}

const REQ = { tenantId: 'perf-t1', asOf: '2026-03-01', driver: { value: 880, granularity: 'monthly' } };

/* ---- percentile (nearest-rank) -------------------------------------------- */
function pct(sorted, p) {
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/* ---- the proof ------------------------------------------------------------- */
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

test('the generator is deterministic — two builds, one portfolio (ref list byte-identical)', () => {
  const a = buildScaleInputs();
  const b = buildScaleInputs();
  const refsOf = (x) => Object.keys(x.paramsByRef).sort().join(',');
  assert.strictEqual(refsOf(a), refsOf(b));
  assert.strictEqual(a.items.length, b.items.length);
  assert.strictEqual(a.consumption.length, b.consumption.length);
  assert.deepStrictEqual(a.items, b.items);
  assert.deepStrictEqual(a.deliveries, b.deliveries);
});

test('the profile pins the §14.22 constants', () => {
  assert.ok(SCALE_REFS >= 4000, 'the profile is 4,000+ refs — the gate must measure at or above it');
  assert.ok(SCALE_RUNS >= 25);
  assert.strictEqual(P95_BUDGET_MS, 500, 'the DoD #8 budget — a spec amendment, not a code edit');
});

test('every measured run is SEALED at exactly SCALE_REFS refs — a fast wrong answer is not a pass', async () => {
  const inputs = buildScaleInputs();
  const ports = makePorts(inputs);
  const receipt = await runPlan(REQ, ports);
  assert.strictEqual(receipt.verdict, 'SEALED');
  assert.strictEqual(receipt.seal.payload.counts.refs, SCALE_REFS);
  assert.strictEqual(receipt.seal.payload.refs.length, SCALE_REFS);
  assert.ok(receipt.seal.payloadHash && /^[0-9a-f]{64}$/.test(receipt.seal.payloadHash), 'the payload hash rides the seal');
});

test('p95 of the full runPlan boundary < 500 ms at 4,200 refs — the DoD #8 gate', async () => {
  const inputs = buildScaleInputs();
  const ports = makePorts(inputs);

  /* warmup — JIT, not measurement */
  const warm = await runPlan(REQ, ports);
  assert.strictEqual(warm.verdict, 'SEALED');

  const times = [];
  let baselineHash = null;
  for (let i = 0; i < SCALE_RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const receipt = await runPlan(REQ, ports);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(receipt.verdict, 'SEALED', `run ${i + 1} must seal — a fast wrong answer is not a pass`);
    assert.strictEqual(receipt.seal.payload.refs.length, SCALE_REFS);
    if (baselineHash === null) baselineHash = receipt.seal.payloadHash;
    else assert.strictEqual(receipt.seal.payloadHash, baselineHash, 'the engine is deterministic — identical inputs, identical payload hash');
    times.push(ms);
  }

  const sorted = [...times].sort((a, b) => a - b);
  const p50 = pct(sorted, 0.50), p95 = pct(sorted, 0.95), max = sorted[sorted.length - 1];
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  console.log(`\n      perf/mrp-scale — ${SCALE_RUNS} runs at ${SCALE_REFS} refs (seed ${SEED})`);
  console.log(`      p50 ${p50.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms · max ${max.toFixed(1)} ms · avg ${avg.toFixed(1)} ms · budget p95 < ${P95_BUDGET_MS} ms`);

  assert.ok(p95 < P95_BUDGET_MS,
    `DoD #8 breached: p95 ${p95.toFixed(1)} ms >= ${P95_BUDGET_MS} ms budget at ${SCALE_REFS} refs — the gate fails loud`);
});

(async () => { await run(TESTS); })();
