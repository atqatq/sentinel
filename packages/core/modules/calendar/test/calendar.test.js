'use strict';
/* ============================================================================
 * calendar tests — the per-tenant working calendar (H9).
 *
 * Named proof (delivery spec §9 A10): calendar/flat-tenant-identical — a
 * flat-calendar tenant (the workbook's own 22-day convention) produces
 * byte-identical output to today's engine. THE audit acceptance is also
 * proven: a tenant calendar with a 10-day Ramadan-style closure produces
 * the documented demand adjustment — the per-period working-month basis
 * drops, the per-working-day rate rises by the working-day ratio, and
 * monthly delivery counts still magnify to exactly rate × count (the
 * §14.4b identical-basis cancellation, per period).
 *
 * Cross-module note: the flat-identity proof requires the planning engine —
 * in a TEST, to bridge the two sides of the identity; the calendar module
 * itself has zero runtime dependencies (plugin boundary, §14.15).
 * ==========================================================================*/
const assert = require('assert');
const C = require('../src/calendar');
const D = require('../src/dates');
const E = require('../../planning-engine/src/engine');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

const SUN_THU = { kind: 'weekly', workingDays: [0, 1, 2, 3, 4] };   // GCC week
const MON_FRI = { kind: 'weekly', workingDays: [1, 2, 3, 4, 5] };
const cal = (spec) => C.parseCalendar(spec).calendar;
const RAMADAN_JUNE = cal({ ...SUN_THU, closures: [{ start: '2026-06-10', end: '2026-06-19' }] });

/* ---- parseCalendar: fail-closed on a wrong calendar ----------------------- */
test('parse: flat calendar accepts and pins the workbook convention', () => {
  const p = C.parseCalendar({ kind: 'flat' });
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.calendar, { kind: 'flat' });
});
test('parse: flat cannot carry dates or a week pattern (it is a count convention)', () => {
  assert.strictEqual(C.parseCalendar({ kind: 'flat', closures: [] }).reason, 'INVALID_CALENDAR');
  assert.strictEqual(C.parseCalendar({ kind: 'flat', workingDays: [1] }).reason, 'INVALID_CALENDAR');
});
test('parse: missing / unknown / absent kind refuse', () => {
  assert.strictEqual(C.parseCalendar(null).reason, 'MISSING_CALENDAR');
  assert.strictEqual(C.parseCalendar('weekly').reason, 'INVALID_CALENDAR');
  assert.strictEqual(C.parseCalendar({}).reason, 'UNKNOWN_CALENDAR_KIND');
  assert.strictEqual(C.parseCalendar({ kind: 'lunar' }).reason, 'UNKNOWN_CALENDAR_KIND');
});
test('parse: a typo in a field name refuses (a silently ignored field is a silently wrong calendar)', () => {
  assert.strictEqual(C.parseCalendar({ kind: 'weekly', workingDays: [1], closers: [] }).reason, 'UNKNOWN_CALENDAR_FIELD');
});
test('parse: weekly accepts a week pattern and normalizes it', () => {
  const p = C.parseCalendar(SUN_THU);
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.calendar.workingDays, [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(p.calendar.closures, []);
});
test('parse: workingDays entries must be distinct integers 0..6 (0 = Sunday)', () => {
  assert.strictEqual(C.parseCalendar({ kind: 'weekly', workingDays: [] }).reason, 'INVALID_WORKING_DAYS');
  assert.strictEqual(C.parseCalendar({ kind: 'weekly', workingDays: [7] }).reason, 'INVALID_WORKING_DAYS');
  assert.strictEqual(C.parseCalendar({ kind: 'weekly', workingDays: [-1] }).reason, 'INVALID_WORKING_DAYS');
  assert.strictEqual(C.parseCalendar({ kind: 'weekly', workingDays: [2.5] }).reason, 'INVALID_WORKING_DAYS');
  assert.strictEqual(C.parseCalendar({ kind: 'weekly', workingDays: [3, 3] }).reason, 'INVALID_WORKING_DAYS');
  assert.strictEqual(C.parseCalendar({ kind: 'weekly', workingDays: 'Mon-Fri' }).reason, 'INVALID_WORKING_DAYS');
});
test('parse: closures must be real inclusive date intervals', () => {
  assert.strictEqual(
    C.parseCalendar({ kind: 'weekly', workingDays: [1], closures: { start: '2026-01-01' } }).reason, 'INVALID_CLOSURE');
  assert.strictEqual(
    C.parseCalendar({ kind: 'weekly', workingDays: [1], closures: [{ start: '2026-02-30', end: '2026-03-01' }] }).reason, 'INVALID_CLOSURE');
  assert.strictEqual(
    C.parseCalendar({ kind: 'weekly', workingDays: [1], closures: [{ start: '2026-03-05', end: '2026-03-01' }] }).reason, 'CLOSURE_END_BEFORE_START');
});
test('parse: overlapping and touching closures merge (no double-count)', () => {
  const p = C.parseCalendar({
    kind: 'weekly', workingDays: [1],
    closures: [{ start: '2026-03-05', end: '2026-03-10' }, { start: '2026-03-08', end: '2026-03-12' }, { start: '2026-03-13', end: '2026-03-14' }],
  });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.calendar.closures.length, 1);
  assert.strictEqual(p.calendar.closures[0].start, '2026-03-05');
  assert.strictEqual(p.calendar.closures[0].end, '2026-03-14');
});

/* ---- working-day counting (hand-verified months) --------------------------- */
test('count: June 2026 has 22 Sun–Thu working days (hand-verified)', () => {
  assert.strictEqual(C.workingDaysInMonth(cal(SUN_THU), 2026, 6).count, 22);
});
test('count: January 2026 distinguishes week patterns (Sun–Thu 21 vs Mon–Fri 22)', () => {
  /* Jan 2026 opens on a Thursday: Sun–Thu loses Fri/Sat but keeps Thu Jan 1
   * (21); Mon–Fri gains Thu 1 + Fri 2 (22). Hand-verified against the
   * calendar; the distinct values prove the pattern is honored, not luck. */
  assert.strictEqual(C.workingDaysInMonth(cal(SUN_THU), 2026, 1).count, 21);
  assert.strictEqual(C.workingDaysInMonth(cal(MON_FRI), 2026, 1).count, 22);
});
test('count: a 10-day closure removes only its WORKING days (Jun 10–19 covers 7 Sun–Thu days)', () => {
  const r = C.workingDaysInMonth(RAMADAN_JUNE, 2026, 6);
  assert.strictEqual(r.count, 15);                 // 22 − 7 (Fri 12, Sat 13, Fri 19 were off anyway)
});
test('count: closures outside the counted range are inert', () => {
  const r = C.workingDaysInRange(RAMADAN_JUNE, '2026-07-01', '2026-07-31');
  assert.strictEqual(r.count, 22);
});
test('count: flat calendar counts 22 for any month (the convention, not dates)', () => {
  assert.strictEqual(C.workingDaysInMonth(cal({ kind: 'flat' }), 2026, 2).count, 22);
  assert.strictEqual(C.workingDaysInMonth(cal({ kind: 'flat' }), 2027, 8).count, 22);
});
test('count: a flat calendar has no date-range semantics and refuses a range count', () => {
  assert.strictEqual(C.workingDaysInRange(cal({ kind: 'flat' }), '2026-06-01', '2026-06-30').reason, 'FLAT_CALENDAR_HAS_NO_DATES');
});
test('count: invalid ranges and months refuse', () => {
  assert.strictEqual(C.workingDaysInRange(cal(SUN_THU), '2026-06-30', '2026-06-01').reason, 'RANGE_END_BEFORE_START');
  assert.strictEqual(C.workingDaysInMonth(cal(SUN_THU), 2026, 13).reason, 'INVALID_MONTH');
  assert.strictEqual(C.workingDaysInMonth(cal(SUN_THU), 'this year', 1).reason, 'INVALID_MONTH');
});
test('count: multi-month period sums the months (Q2 2026 with the June closure = 22+21+15)', () => {
  assert.strictEqual(C.workingDaysInPeriod(RAMADAN_JUNE, 2026, 4, 3).count, 58);
});

/* ---- calendar/flat-tenant-identical (named proof, A10) --------------------- */
test('calendar/flat-tenant-identical: deliveryBasis(flat) equals the engine DELIVERY_BASIS constants', () => {
  const flat = cal({ kind: 'flat' });
  assert.strictEqual(C.deliveryBasis(flat, 'daily', {}).basis, E.DELIVERY_BASIS.daily);         // 1
  assert.strictEqual(C.deliveryBasis(flat, 'weekly', {}).basis, E.DELIVERY_BASIS.weekly);       // 5.5
  assert.strictEqual(C.deliveryBasis(flat, 'monthly', {}).basis, E.DELIVERY_BASIS.monthly);     // 22
  assert.strictEqual(C.deliveryBasis(flat, 'quarterly', {}).basis, E.DELIVERY_BASIS.quarterly); // 66
  assert.strictEqual(C.deliveryBasis(flat, 'ytd', { monthsElapsed: 8 }).basis, 22 * 8);
});
test('calendar/flat-tenant-identical: computeRef with workingDays 22 is byte-identical to the default', () => {
  const ref = { onHand: 400, openPO: 500, invValue: 2000, histMonthly: 2200, consPerDelivery: 0.01, shelfLifeDays: 30 };
  const params = { lead: 7, safetyDays: 3, orderFreq: 7, moq: 500 };
  const a = E.computeRef(ref, params, 800);
  const b = E.computeRef(ref, params, 800, { workingDays: 22 });
  assert.deepStrictEqual(b, a);
  assert.strictEqual(a.workingDays, 22);           // the basis is disclosed on the result
});
test('calendar/flat-tenant-identical: normalizeDeliveries with workingDays 22 is byte-identical to the default', () => {
  for (const g of ['weekly', 'monthly', 'quarterly']) {
    const a = E.normalizeDeliveries(12000, g);
    const b = E.normalizeDeliveries(12000, g, { workingDays: 22 });
    assert.deepStrictEqual(b, a, g);
  }
});

/* ---- the Ramadan demand adjustment (the audit's acceptance) ---------------- */
test('Ramadan: monthly delivery counts still magnify to exactly rate × count on a closed month', () => {
  const rate = 0.01, M = 12000;
  const wdFlat = C.deliveryBasis(cal({ kind: 'flat' }), 'monthly', { year: 2026, month: 6 });
  const wdClosed = C.deliveryBasis(RAMADAN_JUNE, 'monthly', { year: 2026, month: 6 });
  assert.strictEqual(wdClosed.wd, 15);
  const dpdFlat = E.normalizeDeliveries(M, 'monthly', { workingDays: wdFlat.wd }).deliveriesPerDay;
  const dpdClosed = E.normalizeDeliveries(M, 'monthly', { workingDays: wdClosed.wd }).deliveriesPerDay;
  const ref = { onHand: 400, openPO: 0, invValue: 2000, histMonthly: 2200, consPerDelivery: rate };
  const params = { lead: 7, safetyDays: 3, orderFreq: 7, moq: 500 };
  const flat = E.computeRef(ref, params, dpdFlat, { workingDays: wdFlat.wd });
  const closed = E.computeRef(ref, params, dpdClosed, { workingDays: wdClosed.wd });
  assert.ok(near(flat.monthlyMagnified, rate * M));    // 120 — the cancellation, flat
  assert.ok(near(closed.monthlyMagnified, rate * M));  // 120 — EXACT on the closed month too
});
test('Ramadan: the per-working-day rate and run-out adjust by the working-day ratio (22 → 15)', () => {
  const rate = 0.01, M = 12000, histMonthly = 2200, available = 402;
  const wd = 15;
  const dpd = E.normalizeDeliveries(M, 'monthly', { workingDays: wd }).deliveriesPerDay;   // 12000/15 = 800
  const r = E.computeRef(
    { onHand: available, openPO: 0, invValue: 2000, histMonthly, consPerDelivery: rate },
    { lead: 7, safetyDays: 3, orderFreq: 7, moq: 500 }, dpd, { workingDays: wd });
  assert.strictEqual(r.dailyConsumption, rate * M / wd);            // 8 vs 5.4545… flat — ×22/15
  assert.ok(near(r.histDaily, histMonthly / wd));                   // 146.67 vs 100 flat
  assert.ok(near(r.runOut, available * wd / histMonthly));          // 2.7409… vs 4.02 flat — ×15/22
  assert.ok(r.runOut < available * 22 / histMonthly);               // planning is more conservative
});

/* ---- deliveryBasis: per-period, calendar-derived, disclosed ---------------- */
test('basis: weekly-kind basis is the period month\u2019s working-day count, disclosed as wd', () => {
  const b = C.deliveryBasis(cal(SUN_THU), 'monthly', { year: 2026, month: 1 });
  assert.strictEqual(b.basis, 21);
  assert.strictEqual(b.wd, 21);
  assert.deepStrictEqual(b.period, { year: 2026, month: 1 });
  const w = C.deliveryBasis(cal(SUN_THU), 'weekly', { year: 2026, month: 1 });
  assert.strictEqual(w.basis, 21 / 4);
});
test('basis: quarterly uses the basis month\u2019s count ×3 — identical-basis discipline, disclosed', () => {
  /* Same construction as the constants (22×3): the divisor and the engine's
   * magnification must be the SAME wd for the cancellation to hold. A quarter
   * whose months differ should be entered monthly for exactness (§14.4b
   * already marks coarse input low-confidence). */
  const q = C.deliveryBasis(RAMADAN_JUNE, 'quarterly', { year: 2026, month: 4 });
  assert.strictEqual(q.basis, 22 * 3);             // April 2026 = 22 Sun–Thu days
  assert.strictEqual(q.wd, 22);
});
test('basis: ytd is January\u2019s count × monthsElapsed on a real calendar', () => {
  const y = C.deliveryBasis(RAMADAN_JUNE, 'ytd', { year: 2026, monthsElapsed: 6 });
  assert.strictEqual(y.basis, 21 * 6);             // Jan 2026 Sun–Thu = 21
  assert.strictEqual(y.wd, 21);
});
test('basis: missing period / monthsElapsed / granularity refuse', () => {
  assert.strictEqual(C.deliveryBasis(cal(SUN_THU), 'monthly', {}).reason, 'BASIS_PERIOD_REQUIRED');
  assert.strictEqual(C.deliveryBasis(cal(SUN_THU), 'ytd', { year: 2026 }).reason, 'BASIS_PERIOD_REQUIRED');
  assert.strictEqual(C.deliveryBasis(cal(SUN_THU), 'ytd', { monthsElapsed: 0 }).reason, 'BASIS_PERIOD_REQUIRED');
  assert.strictEqual(C.deliveryBasis(cal(SUN_THU), 'fortnightly', { year: 2026, month: 1 }).reason, 'UNKNOWN_GRANULARITY');
});

/* ---- engine integration: fail-closed on a bad basis ------------------------ */
test('engine: computeRef refuses a non-integer / non-positive workingDays (wiring error)', () => {
  const ref = { onHand: 400, histMonthly: 2200, consPerDelivery: 0.01 };
  const params = { lead: 7, safetyDays: 3, orderFreq: 7, moq: 500 };
  for (const bad of [0, -5, 22.5, NaN, 'twenty-two']) {
    assert.throws(() => E.computeRef(ref, params, 800, { workingDays: bad }), TypeError, String(bad));
  }
});
test('engine: normalizeDeliveries refuses a bad workingDays instead of defaulting (a wrong divisor mis-states demand)', () => {
  for (const bad of [0, -5, 22.5, NaN]) {
    const r = E.normalizeDeliveries(12000, 'monthly', { workingDays: bad });
    assert.strictEqual(r.valid, false, String(bad));
    assert.strictEqual(r.reason, 'invalid workingDays (must be a positive integer working-day count)');
    assert.strictEqual(r.basis, null);
  }
});
test('engine: normalizeDeliveries discloses the basis actually used', () => {
  const r = E.normalizeDeliveries(12000, 'monthly', { workingDays: 15 });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.deliveriesPerDay, 800);
  assert.strictEqual(r.workingDays, 15);
  assert.strictEqual(E.normalizeDeliveries(50, 'daily').workingDays, null);  // daily uses no month basis
});

/* ---- the boundary feeds the calendar (H4 → H9 chain) ----------------------- */
test('chain: canonical dates from the boundary flow into calendar counting', () => {
  const boundary = D.toCanonicalDate('2026-06-10T23:40:12', { iana: 'Asia/Riyadh' });  // naive wall stamp
  assert.strictEqual(boundary.value, '2026-06-10');
  const r = C.workingDaysInRange(RAMADAN_JUNE, boundary.value, '2026-06-30');
  assert.strictEqual(r.ok, true);
  assert.ok(r.count < 15);                         // part of the closure month already gone
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
