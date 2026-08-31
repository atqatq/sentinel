'use strict';
/* ============================================================================
 * M10 FX fail-safe — the resolution order, named proof `ingestion/fx-fail-safe`.
 *
 * Contract: build spec §14.17 + ADR-0003 (the audit's M10 [S] fix, verbatim:
 * "continue on last pinned rate, mark all derived money stale-visible, alarm;
 * source of record named"). Under test, in order:
 *
 *  1. The resolution order (fx.resolveRatePin, the PURE decision):
 *     exact pin → fresh; last pin ≤ the day → STALE-VISIBLE fallback
 *     (pinnedFor + staleDays named, day-diff on the H4 canonical discipline);
 *     no pin ≤ the day → RATE_NOT_PINNED (D-015 verbatim — the blanket
 *     refusal NARROWED to never-pinned, the amendment explicit).
 *  2. Future pins are never candidates — tomorrow's rate must not convert
 *     today's rows.
 *  3. The money layer composes it ADDITIVELY (normalizeMoney): every field
 *     an existing consumer saw is unchanged; stale rows carry stale:true +
 *     rateStale{pinnedFor, staleDays} and nothing else new; fresh rows carry
 *     nothing new at all.
 *  4. Determinism: identical inputs → deep-equal outputs, JSON round-trip
 *     stable; month/year boundaries ride UTC-anchored day counts, never
 *     local-time subtraction.
 *  5. Refusals: a malformed table throws (the fail-closed table validation);
 *     a malformed asOfDay is a WIRING error and throws; an absent asOfDay
 *     keeps the historical RATE_NOT_PINNED refusal shape.
 * ==========================================================================*/
const assert = require('assert');
const ingestion = require('../index');
const { resolveRatePin, dayDiff, validatePinTable } = ingestion.fx;
const { normalizeMoney } = ingestion.normalize;

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }
const near = (a,b,eps=1e-9)=>Math.abs(a-b)<=eps;

console.log('\nM10 — the FX fail-safe resolution order (§14.17, ADR-0003)');

/* ---- resolveRatePin: the pure decision ------------------------------------- */

const WINDOW = { usdToLocalByDay: { '2026-08-28': 0.374, '2026-08-30': 0.376 } };

test('an exact pin is fresh: rate, staleDays 0, stale false', () => {
  const r = resolveRatePin(WINDOW, '2026-08-30');
  assert.ok(r.ok);
  assert.ok(near(r.rate, 0.376));
  assert.strictEqual(r.pinnedFor, '2026-08-30');
  assert.strictEqual(r.staleDays, 0);
  assert.strictEqual(r.stale, false);
});
test('no pin for the day but an earlier pin exists: CONTINUE on the last pinned rate, stale-visible', () => {
  const r = resolveRatePin(WINDOW, '2026-08-31');
  assert.ok(r.ok);
  assert.ok(near(r.rate, 0.376));          // the LAST pinned rate ≤ the day (0.376, not 0.374)
  assert.strictEqual(r.pinnedFor, '2026-08-30');
  assert.strictEqual(r.staleDays, 1);
  assert.strictEqual(r.stale, true);
});
test('the fallback picks the LATEST pin ≤ the day, never an older one', () => {
  const r = resolveRatePin(WINDOW, '2026-09-02');
  assert.ok(r.ok);
  assert.ok(near(r.rate, 0.376));
  assert.strictEqual(r.pinnedFor, '2026-08-30');
  assert.strictEqual(r.staleDays, 3);
});
test('no pin ≤ the day at all: RATE_NOT_PINNED stands (D-015 verbatim)', () => {
  const r = resolveRatePin(WINDOW, '2026-08-27');
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, 'RATE_NOT_PINNED');
});
test('an empty window (the never-pinned tenant) refuses RATE_NOT_PINNED', () => {
  const r = resolveRatePin({ usdToLocalByDay: {} }, '2026-08-30');
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, 'RATE_NOT_PINNED');
});
test('a pin dated AFTER the day is never a candidate — tomorrow does not convert today', () => {
  const FUTURE = { usdToLocalByDay: { '2026-08-31': 0.4, '2026-09-01': 0.41 } };
  const r = resolveRatePin(FUTURE, '2026-08-30');
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, 'RATE_NOT_PINNED');
});
test('staleDays rides the H4 canonical discipline: month and year boundaries are UTC day counts', () => {
  assert.strictEqual(dayDiff('2026-08-31', '2026-09-01'), 1);
  assert.strictEqual(dayDiff('2026-02-28', '2026-03-01'), 1);  // 2026 is not a leap year
  assert.strictEqual(dayDiff('2025-12-31', '2026-01-01'), 1);
  const SPAN = { usdToLocalByDay: { '2025-12-31': 0.37 } };
  const r = resolveRatePin(SPAN, '2026-01-02');
  assert.strictEqual(r.staleDays, 2);
});

/* ---- the money layer composes it additively -------------------------------- */

console.log('\nM10 — normalizeMoney: stale-visible money, additive shape');

test('a fresh USD row: exactly the fields C2 always returned — nothing new', () => {
  const r = normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-30' }, 'BHD', WINDOW);
  assert.ok(r.ok);
  assert.deepStrictEqual(Object.keys(r).sort(),
    ['asOfDay', 'documentCurrency', 'ok', 'rate', 'rateSource', 'tenantCurrency', 'tenantValue']);
  assert.ok(near(r.tenantValue, 3.76));
  assert.strictEqual(r.rateSource, 'PINNED_USD');
});
test('a fallback USD row: the same fields PLUS stale:true + rateStale{pinnedFor, staleDays} — and the money still converts', () => {
  const r = normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-31' }, 'BHD', WINDOW);
  assert.ok(r.ok);
  assert.ok(near(r.tenantValue, 3.76));    // the money KEEPS FLOWING (the M10 fix — not a refusal)
  assert.strictEqual(r.rateSource, 'PINNED_USD');
  assert.strictEqual(r.stale, true);
  assert.deepStrictEqual(r.rateStale, { pinnedFor: '2026-08-30', staleDays: 1 });
});
test('a never-pinned USD row still refuses RATE_NOT_PINNED (the narrowed refusal)', () => {
  const r = normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-27' }, 'BHD', WINDOW);
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, 'RATE_NOT_PINNED');
  assert.strictEqual(r.asOfDay, '2026-08-27');
});
test('a local-currency row is untouched by the fail-safe: rate 1, source LOCAL, no staleness fields', () => {
  const r = normalizeMoney({ amount: 250, documentCurrency: 'BHD', asOfDay: '2026-08-31' }, 'BHD', WINDOW);
  assert.ok(r.ok);
  assert.strictEqual(r.rate, 1);
  assert.strictEqual(r.rateSource, 'LOCAL');
  assert.strictEqual(r.stale, undefined);
  assert.strictEqual(r.rateStale, undefined);
});
test('an absent asOfDay keeps the historical RATE_NOT_PINNED refusal (data problem, not a throw)', () => {
  const r = normalizeMoney({ amount: 10, documentCurrency: 'USD' }, 'BHD', WINDOW);
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, 'RATE_NOT_PINNED');
});
test('a malformed asOfDay is a WIRING error and throws (the run day is canonical upstream)', () => {
  assert.throws(() => normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-8-30' }, 'BHD', WINDOW), TypeError);
  assert.throws(() => normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: 20260830 }, 'BHD', WINDOW), TypeError);
});

/* ---- the fail-closed table validation -------------------------------------- */

console.log('\nM10 — the pin window is validated on every resolution (fail-closed)');

test('a malformed table throws: non-object, bad map, typo day key, non-positive rate', () => {
  assert.throws(() => resolveRatePin(null, '2026-08-30'), TypeError);
  assert.throws(() => resolveRatePin({ usdToLocalByDay: 'x' }, '2026-08-30'), TypeError);
  assert.throws(() => resolveRatePin({ usdToLocalByDay: { '2026-8-30': 0.37 } }, '2026-08-30'), /not YYYY-MM-DD/);
  assert.throws(() => resolveRatePin({ usdToLocalByDay: { '2026-08-30': 0 } }, '2026-08-30'), /positive finite/);
  assert.throws(() => resolveRatePin({ usdToLocalByDay: { '2026-08-30': -1 } }, '2026-08-30'), TypeError);
});
/* A numeric-STRING rate passes the table validation — the C2 canon since
 * D-015 (Number-coerced; the loader Numbers every pin at the boundary and
 * the pin DOOR refuses a string where a rate belongs). The resolution
 * Number()s anyway, so the arithmetic is never string concatenation. */
test('a numeric-string rate resolves as a number — the arithmetic never concatenates', () => {
  const r = resolveRatePin({ usdToLocalByDay: { '2026-08-30': '0.37' } }, '2026-08-30');
  assert.ok(r.ok);
  assert.ok(near(r.rate * 10, 3.7)); // 0.37 × 10 = 3.7 — a string rate would have produced '0.370.37'-class poison
});
test('validatePinTable accepts a well-formed window and an empty one', () => {
  assert.strictEqual(validatePinTable(WINDOW), true);
  assert.strictEqual(validatePinTable({ usdToLocalByDay: {} }), true);
});

/* ---- determinism ------------------------------------------------------------ */

console.log('\nM10 — determinism');

test('identical inputs resolve identically (deep-equal), JSON round-trip stable', () => {
  const a = resolveRatePin(WINDOW, '2026-08-31');
  const b = resolveRatePin(WINDOW, '2026-08-31');
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
  const m1 = normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-31' }, 'BHD', WINDOW);
  const m2 = normalizeMoney({ amount: 10, documentCurrency: 'USD', asOfDay: '2026-08-31' }, 'BHD', WINDOW);
  assert.deepStrictEqual(m1, m2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
