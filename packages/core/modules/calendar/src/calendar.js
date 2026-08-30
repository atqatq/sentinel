'use strict';
/* ============================================================================
 * Sentinel — per-tenant working calendar (H9).
 *
 * Build spec §15.2 P1 (A10): "H9 day-basis (calendar-day input + per-tenant
 * working calendar; `WD` becomes calendar-derived, with a flat-calendar
 * tenant byte-identical to today)". Audit finding H9 [S]: WD = 22 is a
 * module constant while "deliveries per day" is entered as actuals — if Ops
 * enters calendar-day counts and the engine treats them as working-day
 * counts feeding a 22-day month, demand is mis-stated by roughly the
 * working/calendar ratio (~18–25% around Ramadan). Audit L-09: WD/WK are
 * constants; the spec calls them configurable without saying per-tenant —
 * resolved by THIS calendar module.
 *
 * The normative day basis (recorded in DECISIONS D-021):
 *   - deliveries are entered as CALENDAR-DAY ACTUALS (what really arrived);
 *   - WD becomes a PER-TENANT, PER-PERIOD, CALENDAR-DERIVED value: the count
 *     of working days (tenant week pattern minus closures) in the period;
 *   - the engine consumes it via computeRef/normalizeDeliveries
 *     `opts.workingDays` — the IDENTICAL basis on both sides (§14.4b), so
 *     the conversion cancels exactly for monthly input, exactly as the
 *     constant 22 does today;
 *   - a FLAT calendar tenant (kind:'flat') pins wd = 22 — the workbook's
 *     convention — and is byte-identical to today's output (named proof
 *     calendar/flat-tenant-identical).
 *
 * Coarse granularities: the divisor is built from the SAME per-month wd as
 * the magnification (weekly wd/4 · monthly wd · quarterly wd×3 · ytd wd×m),
 * preserving the identical-basis cancellation. On a real calendar a quarter
 * whose months differ should be entered monthly for exactness — coarse
 * input already carries low confidence (§14.4b); this module discloses wd
 * so the approximation is visible, never silent.
 *
 * Pure: no-db, no-react, no-framework, no-io, no-clock. Deterministic.
 * ==========================================================================*/

const D = require('./dates');

const FLAT_WORKING_DAYS_PER_MONTH = 22;   // the DDS convention (Master Data H2 = G2/22)
const WK = 4;                              // weeks per month — the workbook's own convention

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ---- Calendar parse (fail-closed: a wrong calendar wrongs every plan) ----- */

/** Validate a tenant calendar spec.
 *  {kind:'flat'} — the workbook convention: every month has exactly
 *                  FLAT_WORKING_DAYS_PER_MONTH working days. No closures
 *                  (a flat calendar is a count convention, not dates).
 *  {kind:'weekly', workingDays:[0..6], closures?:[{start,end}]}
 *                  — 0 = Sunday; at least one working day; closures are
 *                  inclusive date intervals, merged when overlapping.
 *  Unknown fields are REFUSED (a typo'd `closers` must not be silently
 *  ignored into a silently wrong calendar).
 *  Returns {ok, calendar} or {ok:false, reason, detail, index?} with
 *  reasons: MISSING_CALENDAR · INVALID_CALENDAR · UNKNOWN_CALENDAR_KIND ·
 *  UNKNOWN_CALENDAR_FIELD · INVALID_WORKING_DAYS · INVALID_CLOSURE ·
 *  CLOSURE_END_BEFORE_START. */
function parseCalendar(spec) {
  if (spec === null || spec === undefined) {
    return { ok: false, reason: 'MISSING_CALENDAR' };
  }
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, reason: 'INVALID_CALENDAR', detail: 'calendar spec must be an object' };
  }
  const known = { kind: true, workingDays: true, closures: true };
  for (const k of Object.keys(spec)) {
    if (!known[k]) {
      return { ok: false, reason: 'UNKNOWN_CALENDAR_FIELD', detail: `unknown calendar field: ${k}` };
    }
  }
  if (spec.kind === undefined || spec.kind === null) {
    return { ok: false, reason: 'UNKNOWN_CALENDAR_KIND', detail: 'calendar kind is required (flat | weekly)' };
  }
  if (spec.kind === 'flat') {
    if (spec.workingDays !== undefined) {
      return { ok: false, reason: 'INVALID_CALENDAR',
               detail: 'a flat calendar pins the working-day count by convention; workingDays is not allowed' };
    }
    if (spec.closures !== undefined) {
      return { ok: false, reason: 'INVALID_CALENDAR',
               detail: 'a flat calendar is a count convention, not dates — it cannot carry closures' };
    }
    return { ok: true, calendar: { kind: 'flat' } };
  }
  if (spec.kind !== 'weekly') {
    return { ok: false, reason: 'UNKNOWN_CALENDAR_KIND', detail: `unknown calendar kind: ${String(spec.kind)} (flat | weekly)` };
  }
  // weekly — tenant week pattern
  const wd = spec.workingDays;
  if (!Array.isArray(wd) || wd.length === 0) {
    return { ok: false, reason: 'INVALID_WORKING_DAYS', detail: 'workingDays must be a non-empty array of weekday numbers (0 = Sunday .. 6 = Saturday)' };
  }
  const seen = new Set();
  for (const d of wd) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      return { ok: false, reason: 'INVALID_WORKING_DAYS', detail: `working day ${JSON.stringify(d)} is not an integer 0..6 (0 = Sunday)` };
    }
    if (seen.has(d)) {
      return { ok: false, reason: 'INVALID_WORKING_DAYS', detail: `working day ${d} (${WEEKDAY_NAMES[d]}) listed more than once` };
    }
    seen.add(d);
  }
  // closures — inclusive intervals of real calendar dates, merged
  const rawClosures = spec.closures === undefined ? [] : spec.closures;
  if (!Array.isArray(rawClosures)) {
    return { ok: false, reason: 'INVALID_CLOSURE', detail: 'closures must be an array of {start, end} intervals' };
  }
  const parsed = [];
  for (let i = 0; i < rawClosures.length; i++) {
    const c = rawClosures[i];
    if (!c || typeof c !== 'object') {
      return { ok: false, reason: 'INVALID_CLOSURE', index: i, detail: `closures[${i}] is not an object` };
    }
    const s = D.parseDateOnly(c.start);
    if (!s.ok) return { ok: false, reason: 'INVALID_CLOSURE', index: i, detail: `closures[${i}].start: ${s.detail || s.reason}` };
    const e = D.parseDateOnly(c.end);
    if (!e.ok) return { ok: false, reason: 'INVALID_CLOSURE', index: i, detail: `closures[${i}].end: ${e.detail || e.reason}` };
    if (e.day < s.day) {
      return { ok: false, reason: 'CLOSURE_END_BEFORE_START', index: i, detail: `closures[${i}]: ${c.start} > ${c.end}` };
    }
    parsed.push({ start: s.value, end: e.value, startDay: s.day, endDay: e.day });
  }
  parsed.sort((a, b) => a.startDay - b.startDay);
  const merged = [];
  for (const c of parsed) {
    const last = merged[merged.length - 1];
    if (last && c.startDay <= last.endDay + 1) {          // overlapping or touching
      if (c.endDay > last.endDay) { last.endDay = c.endDay; last.end = c.end; }
    } else {
      merged.push({ ...c });
    }
  }
  return { ok: true, calendar: { kind: 'weekly', workingDays: [...seen].sort((a, b) => a - b), closures: merged } };
}

/* ---- Working-day counting -------------------------------------------------- */

function checkCalendar(calendar) {
  const c = parseCalendar(calendar);
  if (!c.ok) return c;
  return { ok: true, calendar: c.calendar };
}

/** Count working days in the inclusive date range [start, end] under a
 *  weekly-kind calendar. A flat calendar has NO date semantics (it is a
 *  count convention) and refuses: FLAT_CALENDAR_HAS_NO_DATES. */
function workingDaysInRange(calendar, start, end) {
  const c = checkCalendar(calendar);
  if (!c.ok) return c;
  const cal = c.calendar;
  if (cal.kind === 'flat') {
    return { ok: false, reason: 'FLAT_CALENDAR_HAS_NO_DATES',
             detail: 'a flat calendar pins a per-month working-day count; it has no date range to count' };
  }
  const s = D.parseDateOnly(start);
  if (!s.ok) return { ok: false, reason: s.reason, detail: `start: ${s.detail || s.reason}` };
  const e = D.parseDateOnly(end);
  if (!e.ok) return { ok: false, reason: e.reason, detail: `end: ${e.detail || e.reason}` };
  if (e.day < s.day) {
    return { ok: false, reason: 'RANGE_END_BEFORE_START', detail: `${start} > ${end}` };
  }
  const closureDays = new Set();
  for (const cl of cal.closures) {
    for (let d = Math.max(cl.startDay, s.day); d <= Math.min(cl.endDay, e.day); d++) closureDays.add(d);
  }
  const working = new Set(cal.workingDays);
  let count = 0;
  for (let d = s.day; d <= e.day; d++) {
    if (!working.has((d + 4) % 7)) continue;   // day 0 = 1970-01-01 = Thursday
    if (closureDays.has(d)) continue;
    count++;
  }
  return { ok: true, count, start: s.value, end: e.value };
}

function validateMonth(year, month) {
  if (!Number.isInteger(year) || year < 1970 || year > 2100) {
    return { ok: false, reason: 'INVALID_MONTH', detail: `year ${JSON.stringify(year)} is not an integer in 1970..2100` };
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, reason: 'INVALID_MONTH', detail: `month ${JSON.stringify(month)} is not an integer 1..12` };
  }
  return { ok: true };
}

/** Working days in one calendar month (month 1..12). */
function workingDaysInMonth(calendar, year, month) {
  const m = validateMonth(year, month);
  if (!m.ok) return m;
  const c = checkCalendar(calendar);
  if (!c.ok) return c;
  if (c.calendar.kind === 'flat') {
    return { ok: true, count: FLAT_WORKING_DAYS_PER_MONTH, kind: 'flat' };
  }
  const start = D.dayToDate(D.dayFromUTCms(Date.UTC(year, month - 1, 1)));
  const end = D.dayToDate(D.dayFromUTCms(Date.UTC(year, month, 0)));
  const r = workingDaysInRange(c.calendar, start, end);
  if (!r.ok) return r;
  return { ok: true, count: r.count, kind: 'weekly', start, end };
}

/** Working days across `months` consecutive calendar months starting
 *  (year, month). Sum of the individual months. */
function workingDaysInPeriod(calendar, year, month, months) {
  if (!Number.isInteger(months) || months < 1 || months > 1200) {
    return { ok: false, reason: 'INVALID_MONTH', detail: `months ${JSON.stringify(months)} is not an integer 1..1200` };
  }
  const m = validateMonth(year, month);
  if (!m.ok) return m;
  let total = 0;
  let y = year, mo = month;
  for (let i = 0; i < months; i++) {
    const r = workingDaysInMonth(calendar, y, mo);
    if (!r.ok) return r;
    total += r.count;
    mo++; if (mo > 12) { mo = 1; y++; }
  }
  return { ok: true, count: total };
}

/* ---- The per-period delivery basis (§14.4b, calendar-derived) -------------- */

/** Delivery-input divisor for a granularity, derived from the tenant
 *  calendar for a specific period. Flat calendar → the workbook constants,
 *  byte-identical to the engine's DELIVERY_BASIS. Weekly-kind → the same
 *  construction with the period's calendar-derived wd substituted:
 *      daily 1 · weekly wd/4 · monthly wd · quarterly wd×3 · ytd wd×m
 *  `wd` is disclosed on the result — pass it to the engine's
 *  normalizeDeliveries/computeRef opts.workingDays so the input divisor and
 *  the magnification basis are identical BY CONSTRUCTION (§14.4b).
 *  opts: {year, month} for weekly/monthly/quarterly (month = period's basis
 *  month; for quarterly, the quarter's first month); {year, monthsElapsed}
 *  for ytd. Returns {ok, granularity, basis, wd, period} or
 *  {ok:false, reason, detail}. */
function deliveryBasis(calendar, granularity, opts) {
  const c = checkCalendar(calendar);
  if (!c.ok) return c;
  const cal = c.calendar;
  const g = String(granularity || '').toLowerCase();
  const o = opts || {};
  const flat = cal.kind === 'flat';
  const WDm = flat ? FLAT_WORKING_DAYS_PER_MONTH : null;

  if (g === 'daily') {
    return { ok: true, granularity: g, basis: 1, wd: null, period: null };
  }
  if (g === 'weekly') {
    if (flat) return { ok: true, granularity: g, basis: WDm / WK, wd: WDm, period: null };
    const p = monthOpts(o); if (!p.ok) return p;
    const r = workingDaysInMonth(cal, p.period.year, p.period.month); if (!r.ok) return r;
    return { ok: true, granularity: g, basis: r.count / WK, wd: r.count, period: p.period };
  }
  if (g === 'monthly') {
    if (flat) return { ok: true, granularity: g, basis: WDm, wd: WDm, period: null };
    const p = monthOpts(o); if (!p.ok) return p;
    const r = workingDaysInMonth(cal, p.period.year, p.period.month); if (!r.ok) return r;
    return { ok: true, granularity: g, basis: r.count, wd: r.count, period: p.period };
  }
  if (g === 'quarterly') {
    if (flat) return { ok: true, granularity: g, basis: WDm * 3, wd: WDm, period: null };
    const p = monthOpts(o); if (!p.ok) return p;
    const r = workingDaysInMonth(cal, p.period.year, p.period.month); if (!r.ok) return r;
    return { ok: true, granularity: g, basis: r.count * 3, wd: r.count, period: p.period };
  }
  if (g === 'ytd') {
    const m = Number(o.monthsElapsed);
    if (!Number.isInteger(m) || m < 1) {
      return { ok: false, reason: 'BASIS_PERIOD_REQUIRED', detail: 'ytd requires an integer monthsElapsed >= 1' };
    }
    if (flat) return { ok: true, granularity: g, basis: WDm * m, wd: WDm, period: { monthsElapsed: m } };
    const p = monthOpts({ year: o.year, month: 1 }); if (!p.ok) return p;
    const r = workingDaysInMonth(cal, p.period.year, 1); if (!r.ok) return r;
    return { ok: true, granularity: g, basis: r.count * m, wd: r.count, period: { year: p.period.year, monthsElapsed: m } };
  }
  return { ok: false, reason: 'UNKNOWN_GRANULARITY', detail: `unknown granularity: ${String(granularity)}` };
}

function monthOpts(o) {
  const y = Number(o.year), m = Number(o.month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    return { ok: false, reason: 'BASIS_PERIOD_REQUIRED', detail: 'an integer {year, month 1..12} period is required' };
  }
  return { ok: true, period: { year: y, month: m } };
}

module.exports = {
  FLAT_WORKING_DAYS_PER_MONTH, WK, WEEKDAY_NAMES,
  parseCalendar, workingDaysInRange, workingDaysInMonth, workingDaysInPeriod,
  deliveryBasis,
};
