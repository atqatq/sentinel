'use strict';
/* ============================================================================
 * Ingestion boundary v1 core — strict numerics + quarantine.
 *
 * Golden thread: the audit's flagship defect was nz('1,200') === 0 — a
 * thousands-separated string silently coerced to zero, polluting every
 * downstream rate. Every test below holds that line: corrupt is quarantined,
 * never coerced, never averaged with clean data.
 * ==========================================================================*/
const assert = require('assert');
const P = require('../src/parse');

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }
const near = (a,b,eps=1e-9)=>Math.abs(a-b)<=eps;

/* ---- parseStrictNumber ----------------------------------------------------- */
console.log('\nStrict scalar parsing');

test('accepts a finite number as-is', () => {
  const r = P.parseStrictNumber(1200);
  assert.ok(r.ok); assert.strictEqual(r.value, 1200);
});
test('accepts a canonical digit string', () => {
  const r = P.parseStrictNumber('1200');
  assert.ok(r.ok); assert.strictEqual(r.value, 1200);
});
test('accepts canonical decimals and negatives', () => {
  assert.strictEqual(P.parseStrictNumber('12.5').value, 12.5);
  assert.strictEqual(P.parseStrictNumber('-3.5').value, -3.5);
  assert.strictEqual(P.parseStrictNumber(0).value, 0);
});
test('trims outer whitespace before the canonical check', () => {
  const r = P.parseStrictNumber('  42  ');
  assert.ok(r.ok); assert.strictEqual(r.value, 42);
});
test("REJECTS '1,200' — the flagship nz() defect, now a named quarantine reason", () => {
  const r = P.parseStrictNumber('1,200');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'THOUSANDS_SEPARATOR');
});
test("REJECTS '1.200,5' as THOUSANDS_SEPARATOR (grouping named before decimal comma)", () => {
  assert.strictEqual(P.parseStrictNumber('1.200,5').reason, 'THOUSANDS_SEPARATOR');
});
test("REJECTS '1 200' space grouping", () => {
  assert.strictEqual(P.parseStrictNumber('1 200').reason, 'THOUSANDS_SEPARATOR');
});
test("REJECTS '12,5' as DECIMAL_COMMA", () => {
  assert.strictEqual(P.parseStrictNumber('12,5').reason, 'DECIMAL_COMMA');
});
test("REJECTS '$1,200' and 'SAR 100' as CURRENCY_SYMBOL", () => {
  assert.strictEqual(P.parseStrictNumber('$1,200').reason, 'CURRENCY_SYMBOL');
  assert.strictEqual(P.parseStrictNumber('SAR 100').reason, 'CURRENCY_SYMBOL');
});
test("REJECTS '1e3' as SCIENTIFIC — exports never ship exponents", () => {
  assert.strictEqual(P.parseStrictNumber('1e3').reason, 'SCIENTIFIC');
});
test('REJECTS booleans, objects and NaN/Infinity with distinct reason codes', () => {
  assert.strictEqual(P.parseStrictNumber(true).reason, 'NOT_A_NUMBER');
  assert.strictEqual(P.parseStrictNumber({ qty: 1 }).reason, 'NOT_A_NUMBER');
  assert.strictEqual(P.parseStrictNumber(NaN).reason, 'NON_FINITE');
  assert.strictEqual(P.parseStrictNumber(Infinity).reason, 'NON_FINITE');
});
test('REJECTS null/undefined as MISSING and empty strings as EMPTY', () => {
  assert.strictEqual(P.parseStrictNumber(null).reason, 'MISSING');
  assert.strictEqual(P.parseStrictNumber(undefined).reason, 'MISSING');
  assert.strictEqual(P.parseStrictNumber('').reason, 'EMPTY');
  assert.strictEqual(P.parseStrictNumber('   ').reason, 'EMPTY');
});
test('REJECTS partial literals: trailing dot, leading dot, bare plus sign', () => {
  assert.strictEqual(P.parseStrictNumber('12.').reason, 'FORMAT');
  assert.strictEqual(P.parseStrictNumber('.5').reason, 'FORMAT');
  assert.strictEqual(P.parseStrictNumber('+5').reason, 'FORMAT');
});

/* ---- checkBounds ----------------------------------------------------------- */
console.log('\nPlausibility bounds');

test('bounds are inclusive at both edges', () => {
  const b = { min: 0, max: 100 };
  assert.strictEqual(P.checkBounds(0, b), null);
  assert.strictEqual(P.checkBounds(100, b), null);
  assert.strictEqual(P.checkBounds(-0.001, b), 'BELOW_MIN');
  assert.strictEqual(P.checkBounds(100.001, b), 'ABOVE_MAX');
});
test('open-ended bounds: missing edge is unbounded', () => {
  assert.strictEqual(P.checkBounds(1e12, { min: 0 }), null);   // no max → never ABOVE_MAX
  assert.strictEqual(P.checkBounds(-5, { max: 100 }), null);    // no min → negatives pass
  assert.strictEqual(P.checkBounds(-5, { min: 0 }), 'BELOW_MIN');
  assert.strictEqual(P.checkBounds(1e12, { max: 100 }), 'ABOVE_MAX');
  assert.strictEqual(P.checkBounds(1, null), null);
});

/* ---- parseQuantity + optional semantics (A5) -------------------------------- */
console.log('\nQuantity parse — the only legal fallback site');

const spec = (over) => Object.assign(
  { field: 'qty', fileKind: 'deliveries', rowIndex: 7, asOf: '2026-08-30', bounds: { min: 0, max: 1e6 } }, over);

test('clean value passes through with bounds checked', () => {
  const r = P.parseQuantity(250, spec());
  assert.ok(r.ok); assert.strictEqual(r.value, 250);
  assert.strictEqual(r.optionalApplied, undefined);
});
test('breach above max → quarantine ABOVE_MAX with the parsed value in detail', () => {
  const r = P.parseQuantity(2000000, spec());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.quarantine.reason, 'ABOVE_MAX');
  assert.strictEqual(r.quarantine.detail, 'value=2000000');
});
test('breach below min (negative qty) → quarantine BELOW_MIN', () => {
  assert.strictEqual(P.parseQuantity(-1, spec()).quarantine.reason, 'BELOW_MIN');
});
test('required field missing → quarantine, never a silent zero', () => {
  const r = P.parseQuantity(null, spec());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.quarantine.reason, 'MISSING');
});
test('optional missing → fallback applied, flagged optionalApplied (the legal nz site)', () => {
  const r = P.parseQuantity(null, spec({ optional: true, fallback: 0 }));
  assert.ok(r.ok);
  assert.strictEqual(r.value, 0);
  assert.strictEqual(r.optionalApplied, true);
});
test('optional defaults to null when no fallback given', () => {
  const r = P.parseQuantity(undefined, spec({ optional: true }));
  assert.ok(r.ok); assert.strictEqual(r.value, null);
});
test('present-but-corrupt optional value STILL quarantines — optional never hides corruption', () => {
  const r = P.parseQuantity('1,200', spec({ optional: true, fallback: 0 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.quarantine.reason, 'THOUSANDS_SEPARATOR');
});

/* ---- quarantineRecord -------------------------------------------------------- */
console.log('\nQuarantine record shape');

test('record carries fileKind, rowIndex, field, raw, reason, quarantinedAt(asOf)', () => {
  const q = P.quarantineRecord({ fileKind: 'deliveries', rowIndex: 12, field: 'qty',
    raw: '1,200', reason: 'THOUSANDS_SEPARATOR', asOf: '2026-08-30' });
  assert.deepStrictEqual(q, { fileKind: 'deliveries', rowIndex: 12, field: 'qty',
    raw: '1,200', reason: 'THOUSANDS_SEPARATOR', quarantinedAt: '2026-08-30' });
});
test('deterministic: no internal clock — same inputs, deep-equal records; asOf is injected', () => {
  const a = P.quarantineRecord({ fileKind: 'items', rowIndex: 1, field: 'cost', raw: 'x', reason: 'FORMAT', asOf: '2026-08-30' });
  const b = P.quarantineRecord({ fileKind: 'items', rowIndex: 1, field: 'cost', raw: 'x', reason: 'FORMAT', asOf: '2026-08-30' });
  assert.deepStrictEqual(a, b);
  const c = P.quarantineRecord({ fileKind: 'items', rowIndex: 1, field: 'cost', raw: 'x', reason: 'FORMAT', asOf: '2026-09-01' });
  assert.notDeepStrictEqual(a, c);
});
test('raw is stringified, truncated at 120 chars, and the record is frozen', () => {
  const long = 'x'.repeat(500);
  const q = P.quarantineRecord({ fileKind: 'k', rowIndex: null, field: 'f', raw: long, reason: 'FORMAT', asOf: '2026-08-30' });
  assert.strictEqual(q.raw.length, 120);
  assert.strictEqual(q.rowIndex, null);
  assert.strictEqual(Object.isFrozen(q), true);
});

/* ---- deliveriesGuard (A5 four-clause semantics) -------------------------------- */
console.log('\nDeliveries bounds-guard');

const hist = [
  { date: '2026-08-24', qty: 100 }, { date: '2026-08-25', qty: 110 },
  { date: '2026-08-26', qty: 90 },  { date: '2026-08-27', qty: 120 },
  { date: '2026-08-28', qty: 80 },
];
const gspec = { field: 'qty', bounds: { min: 0, max: 10000 }, fileKind: 'deliveries', rowIndex: 3, asOf: '2026-08-30' };

test('in-window value does not trigger the guard path (parseQuantity handles clean case)', () => {
  const r = P.parseQuantity(500, spec({ bounds: gspec.bounds }));
  assert.ok(r.ok);
});
test('breach → all four A5 clauses: quarantine + 7-day-mean substitute + task + banner', () => {
  const g = P.deliveriesGuard(Object.assign({ value: 999999, history: hist }, gspec));
  assert.strictEqual(g.action, 'SUBSTITUTE_7D_MEAN');
  assert.strictEqual(g.baseline, 'TRAILING_7D_MEAN');
  assert.ok(near(g.substituteWith, 100));               // (100+110+90+120+80)/5
  assert.strictEqual(g.quarantined.reason, 'ABOVE_MAX');
  assert.strictEqual(g.quarantined.raw, '999999');
  assert.strictEqual(g.task.type, 'DATA_HEALTH');
  assert.ok(g.banner.message.includes('7-day mean'));
});
test('history order does not matter; window is the 7 most recent distinct dates', () => {
  const shuffled = [hist[4], hist[0], hist[3], hist[1], hist[2]];
  const g = P.deliveriesGuard(Object.assign({ value: 999999, history: shuffled }, gspec));
  assert.ok(near(g.substituteWith, 100));
});
test('corrupt entries in history are EXCLUDED from the baseline — never averaged in', () => {
  const dirty = hist.concat([
    { date: '2026-08-29', qty: null },        // unparsable
    { date: '2026-08-29b', qty: 5e9 },        // out of bounds
  ]);
  const g = P.deliveriesGuard(Object.assign({ value: 999999, history: dirty }, gspec));
  assert.ok(near(g.substituteWith, 100));
});
test('duplicate dates collapse to the first occurrence, not a double count', () => {
  const dup = hist.concat([{ date: '2026-08-28', qty: 80 }]);
  const g = P.deliveriesGuard(Object.assign({ value: 999999, history: dup }, gspec));
  assert.ok(near(g.substituteWith, 100));
});
test('no valid baseline → substituteWith null + NO_VALID_BASELINE, task still raised, banner honest', () => {
  const g = P.deliveriesGuard(Object.assign({ value: 999999, history: [{ date: '2026-08-29', qty: 7e9 }] }, gspec));
  assert.strictEqual(g.substituteWith, null);
  assert.strictEqual(g.baseline, 'NO_VALID_BASELINE');
  assert.strictEqual(g.task.type, 'DATA_HEALTH');
  assert.ok(g.banner.message.includes('No valid trailing 7-day baseline'));
});
test('empty history → same honest NO_VALID_BASELINE path', () => {
  const g = P.deliveriesGuard(Object.assign({ value: -5, history: [] }, gspec));
  assert.strictEqual(g.baseline, 'NO_VALID_BASELINE');
  assert.strictEqual(g.quarantined.reason, 'BELOW_MIN');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
