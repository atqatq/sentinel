'use strict';
/* ============================================================================
 * H8 — window alignment guard tests.
 *
 * Golden thread: RATE = T / histTotalDeliveries (engine [V3]). If deliveries
 * history does not cover the consumption window, the denominator describes a
 * different span than the numerator and the rate is silently wrong. The guard
 * refuses to seed — with named reasons, exact gap reporting, a data-health
 * task and a banner — never guesses, never prorates, never interpolates.
 * ==========================================================================*/
const assert = require('assert');
const W = require('../src/window');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

/* ---- parseIsoDate ---------------------------------------------------------- */
console.log('\nStrict UTC date parsing');

test('accepts a real calendar date', () => {
  const r = W.parseIsoDate('2026-08-30');
  assert.ok(r.ok); assert.strictEqual(r.value, '2026-08-30');
});
test('rejects impossible calendar dates (Feb 30, month 13)', () => {
  assert.strictEqual(W.parseIsoDate('2026-02-30').reason, 'INVALID_DATE');
  assert.strictEqual(W.parseIsoDate('2026-13-01').reason, 'INVALID_DATE');
});
test('rejects non-ISO shapes and non-strings', () => {
  assert.strictEqual(W.parseIsoDate('30/08/2026').reason, 'INVALID_DATE');
  assert.strictEqual(W.parseIsoDate('2026-8-1').reason, 'INVALID_DATE');
  assert.strictEqual(W.parseIsoDate(42).reason, 'INVALID_DATE');
});
test('null, undefined and empty are MISSING_DATE', () => {
  for (const v of [null, undefined, '']) assert.strictEqual(W.parseIsoDate(v).reason, 'MISSING_DATE');
});

/* ---- validateInterval -------------------------------------------------------- */
console.log('\nInterval validation');

test('accepts a sane inclusive interval', () => {
  const r = W.validateInterval({ start: '2026-06-01', end: '2026-08-31' }, 'w');
  assert.ok(r.ok); assert.strictEqual(r.start, '2026-06-01');
});
test('end before start refuses (END_BEFORE_START)', () => {
  const r = W.validateInterval({ start: '2026-08-31', end: '2026-06-01' }, 'w');
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'END_BEFORE_START');
});
test('bad endpoint dates carry where-context in detail', () => {
  const r = W.validateInterval({ start: 'x', end: '2026-06-01' }, 'entry[3]');
  assert.ok(!r.ok); assert.ok(r.detail.includes('entry[3]'));
});

/* ---- checkWindowCoverage -------------------------------------------------------- */
console.log('\nH8 invariant — coverage of the consumption window');

const CW = { start: '2026-06-01', end: '2026-08-31' }; // 3-month consumption window

test('full daily history covering the window passes', () => {
  const r = W.checkWindowCoverage(CW, [{ start: '2026-06-01', end: '2026-08-31' }]);
  assert.ok(r.ok); assert.strictEqual(r.coverage, 'FULL');
});
test('history extending beyond the window on both sides passes', () => {
  const r = W.checkWindowCoverage(CW, [{ start: '2026-05-01', end: '2026-09-30' }]);
  assert.ok(r.ok);
});
test('contiguous monthly rows with no holes pass (touching intervals merge)', () => {
  const r = W.checkWindowCoverage(CW, [
    { start: '2026-06-01', end: '2026-06-30' },
    { start: '2026-07-01', end: '2026-07-31' },
    { start: '2026-08-01', end: '2026-08-31' },
  ]);
  assert.ok(r.ok);
});
test('no deliveries history at all refuses (NO_DELIVERIES_HISTORY)', () => {
  for (const e of [undefined, [], null]) {
    const r = W.checkWindowCoverage(CW, e);
    assert.ok(!r.ok); assert.strictEqual(r.reason, 'NO_DELIVERIES_HISTORY');
  }
});
test('a hole inside the window refuses and names the exact gap', () => {
  const r = W.checkWindowCoverage(CW, [
    { start: '2026-06-01', end: '2026-06-30' },
    { start: '2026-07-15', end: '2026-08-31' },
  ]);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'WINDOW_NOT_COVERED');
  assert.deepStrictEqual(r.gaps, [{ start: '2026-07-01', end: '2026-07-14' }]);
});
test('history starting late refuses with a head gap', () => {
  const r = W.checkWindowCoverage(CW, [{ start: '2026-07-01', end: '2026-08-31' }]);
  assert.ok(!r.ok);
  assert.deepStrictEqual(r.gaps, [{ start: '2026-06-01', end: '2026-06-30' }]);
});
test('history ending early refuses with a tail gap', () => {
  const r = W.checkWindowCoverage(CW, [{ start: '2026-06-01', end: '2026-08-15' }]);
  assert.ok(!r.ok);
  assert.deepStrictEqual(r.gaps, [{ start: '2026-08-16', end: '2026-08-31' }]);
});
test('extent coverage with an interior hole still refuses (gap-walk, not extent)', () => {
  const r = W.checkWindowCoverage(CW, [
    { start: '2026-05-01', end: '2026-06-30' },
    { start: '2026-08-01', end: '2026-09-30' },
  ]);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'WINDOW_NOT_COVERED');
  assert.deepStrictEqual(r.gaps, [{ start: '2026-07-01', end: '2026-07-31' }]);
});
test('an entry with a corrupt interval refuses with its index (never clipped)', () => {
  const r = W.checkWindowCoverage(CW, [
    { start: '2026-06-01', end: '2026-08-31' },
    { start: '2026-09-31', end: '2026-10-01' }, // Sep 31 does not exist
  ]);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'INVALID_DELIVERIES_ENTRY');
  assert.strictEqual(r.invalid[0].index, 1);
  assert.strictEqual(r.invalid[0].reason, 'INVALID_DATE');
});
test('an inverted entry interval refuses (END_BEFORE_START)', () => {
  const r = W.checkWindowCoverage(CW, [{ start: '2026-08-31', end: '2026-06-01' }]);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'INVALID_DELIVERIES_ENTRY');
});
test('a corrupt consumption window refuses (INVALID_CONSUMPTION_WINDOW)', () => {
  const r = W.checkWindowCoverage({ start: '2026-13-01', end: '2026-08-31' }, [{ start: '2026-06-01', end: '2026-08-31' }]);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'INVALID_CONSUMPTION_WINDOW');
});
test('refusals carry a data-health task and banner naming the refusal', () => {
  const r = W.checkWindowCoverage(CW, [{ start: '2026-07-01', end: '2026-08-31' }]);
  assert.strictEqual(r.task.type, 'DATA_HEALTH');
  assert.ok(r.task.detail.includes('2026-06-01..2026-06-30'));
  assert.ok(r.banner.text.includes('Rate seeding refused'));
});

/* ---- seedRateInputs --------------------------------------------------------------- */
console.log('\nGuarded seed inputs — refuse to seed, else hand the engine clean inputs');

test('covered window returns the full window total for the engine', () => {
  const r = W.seedRateInputs(CW, [
    { start: '2026-06-01', end: '2026-06-30', deliveries: 40 },
    { start: '2026-07-01', end: '2026-07-31', deliveries: 44 },
    { start: '2026-08-01', end: '2026-08-31', deliveries: 48 },
  ]);
  assert.ok(r.ok);
  assert.strictEqual(r.histTotalDeliveries, 132);
  assert.strictEqual(r.includedCount, 3);
  assert.deepStrictEqual(r.partialEdge, []);
});
test('entries outside the window are excluded from the total', () => {
  const r = W.seedRateInputs(CW, [
    { start: '2026-05-01', end: '2026-05-31', deliveries: 999 },
    { start: '2026-06-01', end: '2026-08-31', deliveries: 120 },
    { start: '2026-09-01', end: '2026-09-30', deliveries: 999 },
  ]);
  assert.ok(r.ok);
  assert.strictEqual(r.histTotalDeliveries, 120);
});
test('edge-crossing entries count at full value and are DISCLOSED, not hidden', () => {
  const r = W.seedRateInputs(CW, [
    { start: '2026-05-25', end: '2026-06-03', deliveries: 10 },
    { start: '2026-06-04', end: '2026-08-28', deliveries: 100 },
    { start: '2026-08-29', end: '2026-09-05', deliveries: 8 },
  ]);
  assert.ok(r.ok);
  assert.strictEqual(r.histTotalDeliveries, 118);
  assert.strictEqual(r.partialEdge.length, 2);
  assert.strictEqual(r.partialEdge[0].index, 0);
  assert.strictEqual(r.partialEdge[1].index, 2);
});
test('uncovered window refuses to seed — the H8 refusal', () => {
  const r = W.seedRateInputs(CW, [{ start: '2026-07-01', end: '2026-08-31', deliveries: 60 }]);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'WINDOW_NOT_COVERED');
  assert.ok(r.task && r.banner);
});
test('a negative deliveries value refuses with its index — never summed', () => {
  const r = W.seedRateInputs(CW, [
    { start: '2026-06-01', end: '2026-07-31', deliveries: 80 },
    { start: '2026-08-01', end: '2026-08-31', deliveries: -5 },
  ]);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'INVALID_DELIVERIES_VALUE');
  assert.strictEqual(r.index, 1);
});
test('an unparsable deliveries value refuses (strict numerics apply here too)', () => {
  const r = W.seedRateInputs(CW, [{ start: '2026-06-01', end: '2026-08-31', deliveries: '1,200' }]);
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'INVALID_DELIVERIES_VALUE');
  assert.strictEqual(r.detail, 'THOUSANDS_SEPARATOR');
});
test('guard result composes with the engine: total feeds seedConsPerDelivery semantics', () => {
  // engine formula [V3]: rate = T / histTotalDeliveries (d > 0). The guard's
  // total is exactly what the engine expects as the denominator — same span,
  // same basis. (Division itself stays in the engine; asserted here as shape.)
  const r = W.seedRateInputs(CW, [
    { start: '2026-06-01', end: '2026-08-31', deliveries: 66 },
  ]);
  assert.ok(r.ok);
  const T = 990; // converted consumption over the same window
  const rate = r.histTotalDeliveries > 0 ? T / r.histTotalDeliveries : 0;
  assert.ok(Math.abs(rate - 15) < 1e-9);
});

/* ---- summary ------------------------------------------------------------------------ */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
