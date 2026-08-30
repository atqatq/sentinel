'use strict';
/* ============================================================================
 * calendar/dates tests — the H4 canonical temporal boundary.
 *
 * Named proof (delivery spec §9 A10): dates/canonical-boundary — a datetime
 * is converted to the canonical date-only form by the EXPLICIT tenant
 * timezone, never the server's local zone; the boundary receipt fixture
 * (audit H4, E-confirmed) flips only when the tenant setting flips, and the
 * result is identical on every server.
 *
 * Also proves: day-unit math (L-14's half-day rounding cannot occur), the
 * strict refusal class (naive datetimes, non-real dates, junk), and the
 * H4 fix at the learning layer (execution-feedback days()).
 * ==========================================================================*/
const assert = require('assert');
const D = require('../src/dates');
const F = require('../../execution-feedback/src/feedback');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

const RIYADH = { iana: 'Asia/Riyadh' };          // UTC+3 fixed, no DST
const RIYADH_OFFSET = { offsetMinutes: 180 };    // identical setting, explicit

/* ---- parseDateOnly: the canonical form ----------------------------------- */
test('parse: canonical date-only parses to an integer day number', () => {
  const p = D.parseDateOnly('2026-08-23');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.value, '2026-08-23');
  assert.strictEqual(p.day, 20688);              // 2026-08-23 = day 20688 (hand-verified)
  assert.strictEqual(Number.isInteger(p.day), true);
});
test('parse: day 0 is 1970-01-01 and dayToDate round-trips', () => {
  assert.strictEqual(D.dayToDate(0), '1970-01-01');
  assert.strictEqual(D.dayToDate(D.parseDateOnly('2026-08-23').day), '2026-08-23');
  assert.strictEqual(D.dayToDate(D.parseDateOnly('2000-02-29').day), '2000-02-29'); // leap day
});
test('parse: missing values refuse with MISSING_DATE', () => {
  for (const v of [null, undefined, '']) {
    assert.strictEqual(D.parseDateOnly(v).reason, 'MISSING_DATE');
  }
});
test('parse: format junk refuses with INVALID_DATE (never new Date())', () => {
  for (const v of ['2026/08/23', '2026-8-23', '23-08-2026', 20688, {}, '2026-08-23T00:00:00Z']) {
    const p = D.parseDateOnly(v);
    assert.strictEqual(p.ok, false, String(v));
    assert.strictEqual(p.reason, 'INVALID_DATE', String(v));
  }
});
test('parse: non-real calendar dates refuse (the calendar is truth)', () => {
  for (const v of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-08-00']) {
    const p = D.parseDateOnly(v);
    assert.strictEqual(p.reason, 'NOT_A_REAL_DATE', String(v));
  }
});
test('parse: dayToDate refuses fractional days with a TypeError (L-14)', () => {
  assert.throws(() => D.dayToDate(20688.5), TypeError);
  assert.throws(() => D.dayToDate(NaN), TypeError);
});

/* ---- parseInstant: zone is mandatory -------------------------------------- */
test('instant: Z-stamped instant parses; day = the UTC calendar date it falls on', () => {
  const p = D.parseInstant('2026-08-23T21:30:00Z');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.day, 20688);
});
test('instant: explicit offset converts deterministically (+03:00 before UTC midnight)', () => {
  // 2026-08-24T01:30:00+03:00 === 2026-08-23T22:30:00Z — falls on Aug 23 UTC
  const p = D.parseInstant('2026-08-24T01:30:00+03:00');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.instantMs, Date.UTC(2026, 7, 23, 22, 30));
  assert.strictEqual(p.day, 20688);
});
test('instant: date-only input refuses with NOT_AN_INSTANT', () => {
  const p = D.parseInstant('2026-08-23');
  assert.strictEqual(p.reason, 'NOT_AN_INSTANT');
});
test('instant: naive datetime refuses with NAIVE_DATETIME (the H4 hazard named)', () => {
  const p = D.parseInstant('2026-08-23T02:00:00');
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'NAIVE_DATETIME');
  assert.ok(/H4/.test(p.detail));
});
test('instant: out-of-range time and non-real dates refuse', () => {
  assert.strictEqual(D.parseInstant('2026-08-23T25:00:00Z').reason, 'NOT_A_REAL_INSTANT');
  assert.strictEqual(D.parseInstant('2026-08-23T23:59:60Z').reason, 'NOT_A_REAL_INSTANT');
  assert.strictEqual(D.parseInstant('2026-02-30T00:00:00Z').reason, 'NOT_A_REAL_INSTANT');
  assert.strictEqual(D.parseInstant('2026-08-23T10:99:00Z').reason, 'NOT_A_REAL_INSTANT');
});
test('instant: malformed zone refuses', () => {
  assert.strictEqual(D.parseInstant('2026-08-23T10:00:00+99:00').reason, 'INVALID_DATE');
  assert.strictEqual(D.parseInstant('not-a-date').reason, 'INVALID_DATE');
});

/* ---- toCanonicalDate: THE boundary (named proof) -------------------------- */
test('dates/canonical-boundary: the boundary receipt fixture flips ONLY when the tenant setting flips', () => {
  /* Audit H4 fixture: a receipt timestamped 01:30 in a UTC+3 business day.
   * The instant is 2026-08-23T22:30Z — Aug 23 on the UTC calendar, Aug 24 on
   * the Riyadh wall calendar. Which one is "the day of the receipt" is a
   * TENANT decision, explicit here; under the old ms-math it was decided by
   * whichever server happened to run the code. */
  const receipt = '2026-08-24T01:30:00+03:00';
  const riyadh = D.toCanonicalDate(receipt, RIYADH);
  const utc = D.toCanonicalDate(receipt, { offsetMinutes: 0 });
  assert.strictEqual(riyadh.ok, true);
  assert.strictEqual(riyadh.value, '2026-08-24');     // the business day it happened on
  assert.strictEqual(riyadh.via, 'instant');
  assert.strictEqual(utc.value, '2026-08-23');        // a UTC-tenant counts it on Aug 23
  assert.strictEqual(utc.value !== riyadh.value, true); // the flip is explicit, not environmental
});
test('dates/canonical-boundary: identical results on every server (no local-zone consultation)', () => {
  /* Fixed-offset and IANA readings of the SAME setting must agree exactly —
   * the conversion is a pure function of (instant, tz), so a UTC server and
   * a UTC+3 server running this code produce byte-identical output. */
  for (const instant of ['2026-08-23T21:30:00Z', '2026-08-24T01:30:00+03:00', '2026-06-10T12:00:00Z']) {
    const a = D.toCanonicalDate(instant, RIYADH);
    const b = D.toCanonicalDate(instant, RIYADH_OFFSET);
    assert.strictEqual(a.ok, true, instant);
    assert.deepStrictEqual(a, b, instant);
  }
});
test('boundary: date-only passes through untouched — no tz needed, already canonical', () => {
  const r = D.toCanonicalDate('2026-08-23');
  assert.deepStrictEqual(r, { ok: true, value: '2026-08-23', day: 20688, via: 'date-only' });
});
test('boundary: instant WITHOUT a tenant setting refuses (fail-closed, not defaulted)', () => {
  assert.strictEqual(D.toCanonicalDate('2026-08-23T21:30:00Z').reason, 'TENANT_TIMEZONE_REQUIRED');
  assert.strictEqual(D.toCanonicalDate('2026-08-23T23:30:00', undefined).reason, 'TENANT_TIMEZONE_REQUIRED');
});
test('boundary: naive datetime reads as tenant-local wall time (deliberate, recorded)', () => {
  const r = D.toCanonicalDate('2026-08-23T23:30:00', RIYADH);
  assert.strictEqual(r.via, 'naive-local');
  assert.strictEqual(r.value, '2026-08-23');          // 23:30 Riyadh is still Aug 23 in Riyadh
  const next = D.toCanonicalDate('2026-08-24T00:30:00', RIYADH);
  assert.strictEqual(next.value, '2026-08-24');       // 00:30 Riyadh is Aug 24 in Riyadh
  // a naive stamp is a WALL stamp: the offset never re-interprets it
  const utcWall = D.toCanonicalDate('2026-08-23T23:30:00', { offsetMinutes: 0 });
  assert.strictEqual(utcWall.value, '2026-08-23');
});
test('boundary: unusable tenant settings refuse with named reasons', () => {
  assert.strictEqual(D.toCanonicalDate('2026-08-23T21:30:00Z', { iana: 'Mars/Olympus' }).reason, 'UNKNOWN_TIMEZONE');
  assert.strictEqual(D.toCanonicalDate('2026-08-23T21:30:00Z', {}).reason, 'INVALID_TENANT_TIMEZONE');
  assert.strictEqual(D.toCanonicalDate('2026-08-23T21:30:00Z', 'UTC+3').reason, 'INVALID_TENANT_TIMEZONE');
  assert.strictEqual(D.toCanonicalDate('2026-08-23T21:30:00Z', { offsetMinutes: 'three' }).reason, 'INVALID_TENANT_TIMEZONE');
});
test('boundary: junk and missing inputs refuse', () => {
  assert.strictEqual(D.toCanonicalDate('yesterday', RIYADH).reason, 'INVALID_TEMPORAL');
  assert.strictEqual(D.toCanonicalDate(1755936000000, RIYADH).reason, 'INVALID_TEMPORAL');
  assert.strictEqual(D.toCanonicalDate(null, RIYADH).reason, 'MISSING_DATE');
});

/* ---- day-unit math (L-14 closed by construction) -------------------------- */
test('math: daysBetween is integer-exact in day units', () => {
  assert.strictEqual(D.daysBetween('2026-08-20', '2026-08-28'), 8);
  assert.strictEqual(D.daysBetween('2026-08-28', '2026-08-20'), -8);
  assert.strictEqual(D.daysBetween('2026-02-28', '2026-03-01'), 1);   // 2026 not a leap year
  assert.strictEqual(D.daysBetween('2028-02-28', '2028-03-01'), 2);   // 2028 is
});
test('math: mixing date-only and instants counts on the UTC calendar date', () => {
  assert.strictEqual(D.daysBetween('2026-08-20', '2026-08-28T14:33:00Z'), 8);
  assert.strictEqual(D.daysBetween('2026-08-20T00:00:00Z', '2026-08-20T12:00:00Z'), 0); // 12h = 0 days, no half-day rounding
});
test('math: non-canonical values return null — refused, never guessed', () => {
  assert.strictEqual(D.daysBetween('2026-08-23T02:00:00', '2026-08-28'), null);   // naive
  assert.strictEqual(D.daysBetween('2026-08-20', 'junk'), null);
  assert.strictEqual(D.daysBetween(null, '2026-08-20'), null);
});

/* ---- H4 closes at the learning layer (execution-feedback) ----------------- */
test('feedback: canon lead-time fixture unchanged under canonical day math', () => {
  /* The 31 feedback canon tests feed date-only strings; their results are
   * byte-identical. This fixture mirrors engine.test/feedback.test shapes. */
  const r = F.reconcileProposal(
    { refId: 'R1', sku: 'FI30001720', supplier: 'SupplierA', qty: 1000, expectedUnitPrice: 2.15, raisedAt: '2026-08-20' },
    { poNumber: 'PO1', sku: 'FI30001720', qty: 1000, unitPrice: 2.15, orderedAt: '2026-08-20', expectedDelivery: '2026-08-23' },
    [{ qty: 1000, receivedAt: '2026-08-23', unitPrice: 2.15 }],
  );
  assert.strictEqual(r.realizedLeadDays, 3);
  assert.strictEqual(r.promisedLeadDays, 3);
  assert.strictEqual(r.lateByDays, 0);
  assert.deepStrictEqual(r.flags, []);
});
test('feedback: a naive datetime receipt is refused (null), not runtime-guessed (H4)', () => {
  const r = F.reconcileProposal(
    { refId: 'R1', sku: 'S', qty: 1000, raisedAt: '2026-08-20' },
    { poNumber: 'PO1', sku: 'S', qty: 1000, orderedAt: '2026-08-20', expectedDelivery: '2026-08-23' },
    [{ qty: 1000, receivedAt: '2026-08-23T02:00:00', unitPrice: 2.15 }],   // naive — H4 hazard
  );
  assert.strictEqual(r.realizedLeadDays, null);       // refused upstream of the flag logic
  assert.strictEqual(r.flags.includes('LATE'), false); // no flip decided by server timezone
});
test('feedback: a zone-stamped receipt is deterministic regardless of server zone', () => {
  const run = () => F.reconcileProposal(
    { refId: 'R1', sku: 'S', qty: 1000, raisedAt: '2026-08-20' },
    { poNumber: 'PO1', sku: 'S', qty: 1000, orderedAt: '2026-08-20', expectedDelivery: '2026-08-23' },
    [{ qty: 1000, receivedAt: '2026-08-23T22:30:00Z', unitPrice: 2.15 }],
  );
  const r1 = run(), r2 = run();
  assert.strictEqual(r1.realizedLeadDays, 3);          // UTC calendar date of the instant
  assert.deepStrictEqual(r1, r2);                       // pure function of its inputs
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
