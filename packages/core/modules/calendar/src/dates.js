'use strict';
/* ============================================================================
 * Sentinel — canonical temporal boundary (H4).
 *
 * Build spec §15.2 P1 (A10): "H4 date canonicalization (UTC date-only at the
 * boundary, tenant timezone explicit)". Audit finding H4 [E-confirmed]:
 * `new Date(string)` parses date-only strings as UTC midnight but datetime
 * strings in the RUNTIME's local zone — the same data on a UTC server and a
 * UTC+3 server yields different lead times, and a receipt timestamped late
 * in a UTC+3 business day can cross the midnight boundary in one parse but
 * not the other, flipping `lateByDays > 0` and with it OTIF, LATE flags and
 * every realizedLeadDays observation feeding lead-time learning.
 *
 * The contract this module owns:
 *   1. ONE canonical temporal form: date-only, UTC, 'YYYY-MM-DD'.
 *   2. Datetimes are converted at the boundary — the tenant timezone is an
 *      EXPLICIT tenant setting (offsetMinutes or IANA), never the server's
 *      local zone. A naive datetime (no zone) is runtime-ambiguous, so it is
 *      refused as a direct instant; the boundary accepts it as tenant-local
 *      wall time via toCanonicalDate — a deliberate, recorded conversion.
 *   3. Date math is done in DAY UNITS (integer day numbers), not
 *      milliseconds — L-14's half-day rounding cannot occur by construction.
 *
 * Consumers: ingestion converts at the boundary, then everything downstream
 * (feedback, engine day math, calendars) works on canonical date strings.
 * The working calendar (calendar.js) builds on these primitives.
 *
 * Pure: no-db, no-react, no-framework, no-io, no-clock. Deterministic —
 * identical inputs give identical outputs regardless of server timezone.
 * ==========================================================================*/

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/* ISO 8601 datetime WITH a mandatory zone designator (Z or ±HH(:)MM).
 * A datetime without a zone is NAIVE — refused here (NAIVE_DATETIME),
 * because `new Date('2026-08-23T02:00:00')` is runtime-TZ dependent (H4). */
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/;
/* Same shape WITHOUT the zone — recognized only to give the naive refusal a
 * precise name instead of a generic invalid. */
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/* ---- Day numbers: the units date math is done in (H4, closes L-14) ------- */

/** UTC day number for a UTC-midnight millisecond value. Day 0 = 1970-01-01. */
function dayFromUTCms(ms) { return Math.floor(ms / DAY_MS); }

/** Inverse of a day number → 'YYYY-MM-DD'. Throws on non-integers (a
 * fractional day is a wiring error, never a rounding opportunity). */
function dayToDate(day) {
  if (!Number.isInteger(day)) throw new TypeError('day must be an integer day number');
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/* ---- Strict canonical date-only parse ------------------------------------- */

/** Parse 'YYYY-MM-DD' strictly. Returns {ok, value, day} or
 *  {ok:false, reason: MISSING_DATE | INVALID_DATE | NOT_A_REAL_DATE, detail}.
 *  Round-trip validation rejects 2026-02-30, 2026-13-01 — the calendar is
 *  truth (same discipline as the ingestion window guard). */
function parseDateOnly(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'MISSING_DATE' };
  }
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
    return { ok: false, reason: 'INVALID_DATE', detail: `not a YYYY-MM-DD string: ${String(raw)}` };
  }
  const ms = Date.UTC(
    Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10)),
  );
  const back = new Date(ms).toISOString().slice(0, 10);
  if (back !== raw) {
    return { ok: false, reason: 'NOT_A_REAL_DATE', detail: `not a real calendar date: ${raw}` };
  }
  return { ok: true, value: raw, day: dayFromUTCms(ms) };
}

/* ---- Strict instant parse (datetime WITH zone) ---------------------------- */

function parseOffsetMinutes(zone) {
  if (zone === 'Z') return 0;
  const sign = zone[0] === '-' ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const hh = Number(digits.slice(0, 2)), mm = Number(digits.slice(2, 4));
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return null;
  return sign * (hh * 60 + mm);
}

/** Parse an ISO 8601 instant with a MANDATORY zone ('...Z' or '...±HH:MM').
 *  Returns {ok, value, instantMs, day} where `day` is the UTC calendar date
 *  the instant falls on (storage-canonical), or
 *  {ok:false, reason: MISSING_DATE | INVALID_DATE | NOT_A_REAL_INSTANT |
 *   NAIVE_DATETIME | NOT_AN_INSTANT, detail}.
 *  Hand-parsed, then round-trip validated — never `new Date(string)` (H4). */
function parseInstant(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'MISSING_DATE' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'INVALID_DATE', detail: `not a string: ${String(raw)}` };
  }
  if (DATE_RE.test(raw)) {
    return { ok: false, reason: 'NOT_AN_INSTANT', detail: `date-only string has no time part: ${raw}` };
  }
  const naive = raw.match(NAIVE_RE);
  if (naive) {
    return { ok: false, reason: 'NAIVE_DATETIME',
             detail: `${raw} carries no zone — its reading depends on the server's local timezone (H4); convert at the boundary with toCanonicalDate and the explicit tenant timezone` };
  }
  const m = raw.match(INSTANT_RE);
  if (!m) {
    return { ok: false, reason: 'INVALID_DATE', detail: `not an ISO 8601 instant with zone: ${raw}` };
  }
  const [, ys, mos, ds, Hs, Mis, Ss, Frac, zone] = m;
  const off = parseOffsetMinutes(zone);
  if (off === null) {
    return { ok: false, reason: 'INVALID_DATE', detail: `invalid zone designator: ${zone}` };
  }
  const H = Number(Hs), Mi = Number(Mis), S = Ss ? Number(Ss) : 0, Ms = Frac ? Number(Frac) : 0;
  if (H > 23 || Mi > 59 || S > 59) {
    return { ok: false, reason: 'NOT_A_REAL_INSTANT', detail: `time out of range: ${raw}` };
  }
  const instantMs = Date.UTC(Number(ys), Number(mos) - 1, Number(ds), H, Mi, S, Ms) - off * 60000;
  // round-trip: reconstruct every WALL-CLOCK field (instant + zone offset) and
  // compare to the input; any drift (02:99, 2026-02-30T…, 23:59:60) refuses —
  // the calendar is truth
  const wall = new Date(instantMs + off * 60000);
  const pad = (n, w) => String(n).padStart(w, '0');
  const rebuilt = `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1, 2)}-${pad(wall.getUTCDate(), 2)}T${pad(wall.getUTCHours(), 2)}:${pad(wall.getUTCMinutes(), 2)}:${pad(wall.getUTCSeconds(), 2)}`;
  const want = `${ys}-${mos}-${ds}T${Hs}:${Mis}:${Ss || '00'}`;
  if (rebuilt !== want) {
    return { ok: false, reason: 'NOT_A_REAL_INSTANT', detail: `not a real instant: ${raw}` };
  }
  return { ok: true, value: raw, instantMs, day: dayFromUTCms(instantMs) };
}

/* ---- Tenant timezone — an EXPLICIT setting, never the server's ------------ */

/** Local calendar date ('YYYY-MM-DD') of an instant under a tenant timezone.
 *  tz: {offsetMinutes: int} fixed offset, or {iana: 'Asia/Riyadh'} resolved
 *  via Intl (deterministic for fixed-rule zones — all GCC zones are UTC+3,
 *  no DST). Throws TypeError on a malformed tz; returns null on an IANA zone
 *  this runtime cannot resolve (caller refuses — fail-closed). */
function localDateOfInstant(instantMs, tz) {
  if (tz && typeof tz === 'object' && tz.offsetMinutes !== undefined) {
    if (!Number.isInteger(tz.offsetMinutes)) {
      throw new TypeError('tz.offsetMinutes must be an integer number of minutes');
    }
    return new Date(instantMs + tz.offsetMinutes * 60000).toISOString().slice(0, 10);
  }
  if (tz && typeof tz === 'object' && typeof tz.iana === 'string') {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz.iana, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(instantMs));
      const get = (t) => parts.find((p) => p.type === t) || { value: '' };
      return `${get('year').value}-${get('month').value}-${get('day').value}`;
    } catch (e) {
      return null;   // unknown zone on this runtime — caller refuses
    }
  }
  throw new TypeError('tz must be {offsetMinutes} or {iana}');
}

/* ---- THE boundary conversion (H4's one canonical temporal form) ----------- */

/** Convert any accepted temporal input to the canonical date-only form.
 *  raw:  'YYYY-MM-DD'  → passes through (already canonical; tz not consulted)
 *        instant with zone → the local calendar date under the tenant timezone
 *        naive datetime    → the tenant-local wall-time date (deliberate,
 *                            recorded interpretation; requires tz as proof
 *                            the tenant setting was consulted)
 *  tz (required for non-canonical inputs): {offsetMinutes} | {iana}.
 *  Returns {ok, value, day, via: 'date-only'|'instant'|'naive-local'} or
 *  {ok:false, reason: MISSING_DATE | INVALID_DATE | NOT_A_REAL_DATE |
 *   NOT_AN_INSTANT | NOT_A_REAL_INSTANT | NAIVE_DATETIME |
 *   INVALID_TEMPORAL | INVALID_TENANT_TIMEZONE | TENANT_TIMEZONE_REQUIRED |
 *   UNKNOWN_TIMEZONE, detail}.
 */
function toCanonicalDate(raw, tz) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'MISSING_DATE' };
  }
  if (typeof raw === 'string' && DATE_RE.test(raw)) {
    const p = parseDateOnly(raw);
    if (!p.ok) return p;
    return { ok: true, value: p.value, day: p.day, via: 'date-only' };
  }
  if (typeof raw !== 'string' || !(NAIVE_RE.test(raw) || INSTANT_RE.test(raw))) {
    return { ok: false, reason: 'INVALID_TEMPORAL', detail: `not a date, instant or naive datetime: ${String(raw)}` };
  }
  // Non-canonical input: the explicit tenant setting is mandatory (H4).
  if (tz === null || tz === undefined) {
    return { ok: false, reason: 'TENANT_TIMEZONE_REQUIRED',
             detail: 'converting a datetime requires the explicit tenant timezone (H4) — a date-only string needs none' };
  }
  let probe;
  try { probe = localDateOfInstant(0, tz); } catch (e) { probe = undefined; }
  if (probe === undefined) {
    return { ok: false, reason: 'INVALID_TENANT_TIMEZONE', detail: 'tz must be {offsetMinutes} or {iana}' };
  }
  if (probe === null) {
    return { ok: false, reason: 'UNKNOWN_TIMEZONE', detail: `tenant timezone not resolvable on this runtime: ${JSON.stringify(tz)}` };
  }
  const naive = raw.match(NAIVE_RE);
  if (naive) {
    // A naive stamp read as tenant-local wall time: its date is its own.
    const p = parseDateOnly(`${naive[1]}-${naive[2]}-${naive[3]}`);
    if (!p.ok) return p;
    return { ok: true, value: p.value, day: p.day, via: 'naive-local' };
  }
  const inst = parseInstant(raw);
  if (!inst.ok) return inst;
  const p = parseDateOnly(localDateOfInstant(inst.instantMs, tz));
  if (!p.ok) return p;
  return { ok: true, value: p.value, day: p.day, via: 'instant' };
}

/* ---- Day-unit math (integer, exact — no milliseconds, no rounding) -------- */

/** Canonical day number of a date-only string or zone-carrying instant (an
 *  instant counts on the UTC calendar date it falls on — the storage-
 *  canonical day). null when the value is not canonical: a naive datetime
 *  or junk refuses, it never guesses (callers convert at the boundary; a
 *  non-canonical value here is a contract violation upstream, not something
 *  to silently reinterpret). */
function canonicalDay(raw) {
  if (typeof raw === 'string' && DATE_RE.test(raw)) {
    const p = parseDateOnly(raw);
    return p.ok ? p.day : null;
  }
  const inst = parseInstant(raw);
  return inst.ok ? inst.day : null;
}

/** Days from a to b (b − a) in day units; integer, exact, server-TZ
 *  independent. null when either side is not canonical. */
function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = canonicalDay(a), db = canonicalDay(b);
  if (da === null || db === null) return null;
  return db - da;
}

module.exports = {
  DAY_MS, DATE_RE,
  dayFromUTCms, dayToDate,
  parseDateOnly, parseInstant,
  localDateOfInstant, toCanonicalDate,
  canonicalDay, daysBetween,
};
