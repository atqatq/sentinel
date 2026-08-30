'use strict';
/* ============================================================================
 * kpi-catalog tests — the fail-closed KPI layer (A1/A2 named proofs).
 *
 * Golden thread: a withheld KPI with a reason is an operational event; a
 * wrong KPI is a wrong steering decision on a $50M portfolio. The three
 * named proofs — kpi/tenant-currency-mandatory, kpi/mixed-currency-withholds-
 * value, kpi/service-level-null-when-unplannable — close A1/A2 (gates 4 and
 * 15) at the KPI layer, on top of the engine's verified canon.
 * ==========================================================================*/
const assert = require('assert');
const K = require('../src/catalog');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

const HOUR = 3600000;
const SEALED = 1700000000000;
const ASOF = SEALED + 5 * HOUR;         // 5h old — fresh for daily KPIs
const ASOF_STALE = SEALED + 27 * HOUR;  // 27h old — stale past the 26h threshold

/* Engine portfolioKPIs output shapes (the engine suite proves the engine side;
 * these fixtures carry that exact shape into the catalog layer). */
function cleanPortfolio() {
  return {
    actualInvValue: 12500, targetInvValueBottomUp: 11000, maxInvValue: 15000,
    actualDIO: 21.4, targetInvValueTopDown: 12000, targetInvValueNoStaging: 9480,
    dailyCOGS: 584, targetDIO: 20, shortages: 3, active: 40, serviceLevel: 0.925,
    counts: { 'Zero Stock': 2, 'Below Safety': 4, 'Below Reorder': 6, 'Order': 15, 'Over Stock': 5, 'OK': 8 },
    unplanned: 4, unplannedShare: 0.1,
    currency: 'BHD', kpiWithheld: false, withheldReason: null, currencyMixed: false, mixedCurrencies: [],
    valuesTrustworthy: true,
  };
}
function mixedPortfolio() {
  const p = cleanPortfolio();
  for (const m of K.MONEY_METRICS) p[m] = null;
  Object.assign(p, {
    kpiWithheld: true, withheldReason: 'rows not normalized to tenant currency',
    currencyMixed: true, mixedCurrencies: ['AED'], valuesTrustworthy: false,
  });
  return p;
}
function unplannablePortfolio() {
  const p = cleanPortfolio();
  Object.assign(p, { active: 0, shortages: 0, serviceLevel: null });
  return p;
}
const byMetric = (out, m) => out.results.find((r) => r.metric === m);

/* ---- catalog integrity ------------------------------------------------------ */
console.log('\nCatalog as data (§16 — defined once)');

test('the catalog ships all 28 §16 entries with unique ids', () => {
  const c = K.getCatalog();
  assert.strictEqual(c.length, 28);
  assert.strictEqual(new Set(c.map((k) => k.id)).size, 28);
});
test('groups: SRC 7, INV 8, DAT 6, TM 5, PM 2', () => {
  const n = (g) => K.getCatalog().filter((k) => k.group === g).length;
  assert.deepStrictEqual([n('SRC'), n('INV'), n('DAT'), n('TM'), n('PM')], [7, 8, 6, 5, 2]);
});
test('every entry carries name, definition, formula, source, owner, cadence and target', () => {
  for (const k of K.getCatalog()) {
    for (const f of ['id', 'group', 'name', 'definition', 'formula', 'source', 'owner', 'cadence', 'target']) {
      assert.ok(typeof k[f] === 'string' && k[f].length > 0, `${k.id} missing ${f}`);
    }
    assert.ok(k.staleAfterHours === null || typeof k.staleAfterHours === 'number', `${k.id} staleAfterHours`);
  }
});
test('time-based cadences carry explicit thresholds; event-based carry null', () => {
  assert.strictEqual(K.kpiById('INV-02').staleAfterHours, 26);   // daily
  assert.strictEqual(K.kpiById('SRC-03').staleAfterHours, 182);  // weekly
  assert.strictEqual(K.kpiById('SRC-06').staleAfterHours, 744);  // monthly
  assert.strictEqual(K.kpiById('DAT-01').staleAfterHours, 2);    // hourly
  assert.strictEqual(K.kpiById('INV-03').staleAfterHours, null); // every recompute
  assert.strictEqual(K.kpiById('INV-01').staleAfterHours, null); // weekly per session
});

/* ---- staleness ---------------------------------------------------------------- */
console.log('\nFreshness and staleness (§16 — never a silent number)');

test('a fresh seal is not stale; age is computed in hours', () => {
  const r = K.evaluateStaleness(SEALED, 26, ASOF);
  assert.strictEqual(r.stale, false);
  assert.ok(Math.abs(r.ageHours - 5) < 1e-9);
});
test('strictly past the threshold is stale', () => {
  assert.strictEqual(K.evaluateStaleness(SEALED, 26, ASOF_STALE).stale, true);
});
test('exactly at the threshold is still fresh', () => {
  assert.strictEqual(K.evaluateStaleness(SEALED, 5, SEALED + 5 * HOUR).stale, false);
});
test('event-based entries are never time-stale', () => {
  const r = K.evaluateStaleness(SEALED, null, ASOF_STALE);
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.staleAfterHours, null);
});
test('a seal in the future of asOf throws; non-numeric inputs throw', () => {
  assert.throws(() => K.evaluateStaleness(ASOF_STALE, 26, ASOF), TypeError);
  assert.throws(() => K.evaluateStaleness('yesterday', 26, ASOF), TypeError);
  assert.throws(() => K.evaluateStaleness(SEALED, 26, 'now'), TypeError);
});

/* ---- fromEnginePortfolio ------------------------------------------------------- */
console.log('\nThe dataState envelope (engine canon mapped, never re-implemented)');

test('throws without lastSealedAt — the §16 freshness stamp is mandatory', () => {
  assert.throws(() => K.fromEnginePortfolio(cleanPortfolio(), { asOf: ASOF }), TypeError);
});
test('kpi/tenant-currency-mandatory: a portfolio without its currency context throws', () => {
  const p = cleanPortfolio(); delete p.currency;
  assert.throws(() => K.fromEnginePortfolio(p, { asOf: ASOF, lastSealedAt: SEALED }), /tenant currency/);
});
test('kpi/tenant-currency-mandatory: an empty-string currency throws the same way', () => {
  const p = cleanPortfolio(); p.currency = '';
  assert.throws(() => K.fromEnginePortfolio(p, { asOf: ASOF, lastSealedAt: SEALED }), /tenant currency/);
});
test('a clean portfolio renders the money strip OK with values', () => {
  const out = K.fromEnginePortfolio(cleanPortfolio(), { asOf: ASOF, lastSealedAt: SEALED });
  assert.strictEqual(out.stale, false);
  assert.strictEqual(out.currency, 'BHD');
  for (const m of K.MONEY_METRICS) {
    const r = byMetric(out, m);
    assert.strictEqual(r.dataState, 'OK', m);
    assert.strictEqual(r.value, cleanPortfolio()[m], m);
    assert.strictEqual(r.reason, null, m);
  }
});
test('INV-02 maps actualDIO; INV-04 renders ×100 with no rounding lies', () => {
  const out = K.fromEnginePortfolio(cleanPortfolio(), { asOf: ASOF, lastSealedAt: SEALED });
  const dio = byMetric(out, 'actualDIO');
  assert.strictEqual(dio.id, 'INV-02');
  const sl = byMetric(out, 'serviceLevel');
  assert.strictEqual(sl.id, 'INV-04');
  assert.strictEqual(sl.value, 92.5); // 0.925 × 100, exact
});
test('INV-03 sums the three at-or-below-reorder states and discloses the composition', () => {
  const out = K.fromEnginePortfolio(cleanPortfolio(), { asOf: ASOF, lastSealedAt: SEALED });
  const r = byMetric(out, 'reorderBreachCount');
  assert.strictEqual(r.id, 'INV-03');
  assert.strictEqual(r.value, 12);
  assert.deepStrictEqual(r.composition, { zeroStock: 2, belowSafety: 4, belowReorder: 6 });
});
test('kpi/mixed-currency-withholds-value: every money metric is WITHHELD, null, with the currencies named', () => {
  const out = K.fromEnginePortfolio(mixedPortfolio(), { asOf: ASOF, lastSealedAt: SEALED });
  for (const m of K.MONEY_METRICS) {
    const r = byMetric(out, m);
    assert.strictEqual(r.dataState, 'WITHHELD', m);
    assert.strictEqual(r.value, null, m);
    assert.ok(r.reason.includes('not normalized to tenant currency'), m);
    assert.ok(r.reason.includes('AED'), m);
  }
});
test('withholding is surgical — INV-04 and INV-03 still render from a mixed run', () => {
  const out = K.fromEnginePortfolio(mixedPortfolio(), { asOf: ASOF, lastSealedAt: SEALED });
  assert.strictEqual(byMetric(out, 'serviceLevel').dataState, 'OK');
  assert.strictEqual(byMetric(out, 'serviceLevel').value, 92.5);
  assert.strictEqual(byMetric(out, 'reorderBreachCount').value, 12);
});
test('an inconsistent portfolio — kpiWithheld but a money value present — throws', () => {
  const p = mixedPortfolio(); p.actualInvValue = 12500;
  assert.throws(() => K.fromEnginePortfolio(p, { asOf: ASOF, lastSealedAt: SEALED }), TypeError);
});
test('kpi/service-level-null-when-unplannable: null serviceLevel renders INSUFFICIENT_DATA — never 100, never 0', () => {
  const out = K.fromEnginePortfolio(unplannablePortfolio(), { asOf: ASOF, lastSealedAt: SEALED });
  const r = byMetric(out, 'serviceLevel');
  assert.strictEqual(r.dataState, 'INSUFFICIENT_DATA');
  assert.strictEqual(r.value, null);
  assert.strictEqual(r.reason, 'insufficient plannable data');
  assert.notStrictEqual(r.value, 100);
  assert.notStrictEqual(r.value, 0);
});
test('serviceLevel outside [0,1] throws — the engine canon is a fraction', () => {
  const p = cleanPortfolio(); p.serviceLevel = 92.5;
  assert.throws(() => K.fromEnginePortfolio(p, { asOf: ASOF, lastSealedAt: SEALED }), TypeError);
});
test('a stale seal marks STALE but keeps the values — explicit, never silent', () => {
  const out = K.fromEnginePortfolio(cleanPortfolio(), { asOf: ASOF_STALE, lastSealedAt: SEALED });
  assert.strictEqual(out.stale, true);
  const dio = byMetric(out, 'actualDIO');
  assert.strictEqual(dio.dataState, 'STALE');
  assert.strictEqual(dio.value, 21.4);
  assert.ok(dio.reason.includes('cadence'));
  const sl = byMetric(out, 'serviceLevel');
  assert.strictEqual(sl.dataState, 'STALE');
  assert.strictEqual(sl.value, 92.5);
});
test('state precedence: WITHHELD beats stale; INSUFFICIENT_DATA beats stale', () => {
  const w = K.fromEnginePortfolio(mixedPortfolio(), { asOf: ASOF_STALE, lastSealedAt: SEALED });
  assert.strictEqual(byMetric(w, 'actualInvValue').dataState, 'WITHHELD');
  const u = K.fromEnginePortfolio(unplannablePortfolio(), { asOf: ASOF_STALE, lastSealedAt: SEALED });
  assert.strictEqual(byMetric(u, 'serviceLevel').dataState, 'INSUFFICIENT_DATA');
});
test('the INV-04 grain difference is disclosed on the result, never silently reconciled', () => {
  const out = K.fromEnginePortfolio(cleanPortfolio(), { asOf: ASOF, lastSealedAt: SEALED });
  const r = byMetric(out, 'serviceLevel');
  assert.ok(r.grainNote.includes('plannable refs'));
  assert.ok(out.grainNotes.length === 1);
});
test('results are deterministic for identical inputs', () => {
  const a = K.fromEnginePortfolio(cleanPortfolio(), { asOf: ASOF, lastSealedAt: SEALED });
  const b = K.fromEnginePortfolio(cleanPortfolio(), { asOf: ASOF, lastSealedAt: SEALED });
  assert.deepStrictEqual(a, b);
});

/* ---- summary --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
