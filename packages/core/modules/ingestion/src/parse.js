'use strict';
/* ============================================================================
 * Sentinel — ingestion boundary v1 core: strict numerics + quarantine.
 *
 * Contract source: SENTINEL_V3_BUILD_SPEC §15.2 C4, delivery spec §9 A5.
 *
 * The defining failure of the spreadsheet era this platform replaces was
 * silent coercion: `nz('1,200') === 0` turned a corrupt value into a zero
 * and every downstream rate, cover and proposal with it. This module is the
 * root fix: values crossing the ingestion boundary are parsed strictly or
 * quarantined — they are never coerced. An nz()-style fallback is legal in
 * exactly one place: a field explicitly declared optional that is genuinely
 * missing. Present-but-corrupt is never optional.
 *
 * Purity: no-db, no-react, no-framework, no-io, no clock. Every timestamp
 * enters as a parameter (asOf), so identical inputs always produce
 * identical outputs.
 * ==========================================================================*/

/* ---- strict scalar parsing ------------------------------------------------ */

// Canonical numeric literal: optional sign, digits, optional fractional part.
// Nothing else crosses the boundary — no groupings, no symbols, no exponents.
const CANONICAL_NUMBER = /^-?\d+(\.\d+)?$/;

const CURRENCY_CHARS = /[$€£¥₹﷼]/;
const CURRENCY_WORDS = /\b(sar|aed|usd|eur|gbp|qar|bhd|kwd|omr|jod|egp)\b/i;

/**
 * Parse one scalar value strictly.
 *
 * @returns {{ok:true, value:number}|{ok:false, reason:string, detail?:string}}
 *   ok        — parsed cleanly, `value` is a finite JS number
 *   !ok       — `reason` is a stable machine code for the quarantine record
 *
 * Reason codes (never rename; quarantine UIs and ledgers depend on them):
 *   MISSING              null / undefined
 *   EMPTY                '' or whitespace-only string
 *   NOT_A_NUMBER         wrong type (boolean, object, array, function)
 *   NON_FINITE           NaN / ±Infinity
 *   THOUSANDS_SEPARATOR  digit grouping: '1,200', '1 200', '1.200,5'
 *   DECIMAL_COMMA        European decimal form: '12,5'
 *   CURRENCY_SYMBOL      '$100', 'SAR 100'
 *   SCIENTIFIC           '1e3' — ERP exports do not ship exponents; a
 *                        value that arrives as one is already corrupt
 *   FORMAT               any other non-canonical literal: '12.', '.5', '+5'
 */
function parseStrictNumber(value) {
  if (value === null || value === undefined) return { ok: false, reason: 'MISSING' };
  if (typeof value === 'boolean') return { ok: false, reason: 'NOT_A_NUMBER' };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { ok: false, reason: 'NON_FINITE', detail: 'NaN' };
    if (!Number.isFinite(value)) return { ok: false, reason: 'NON_FINITE', detail: String(value) };
    return { ok: true, value };
  }
  if (typeof value !== 'string') return { ok: false, reason: 'NOT_A_NUMBER', detail: typeof value };

  const s = value.trim();
  if (s === '') return { ok: false, reason: 'EMPTY' };
  if (CURRENCY_CHARS.test(s)) return { ok: false, reason: 'CURRENCY_SYMBOL', detail: s };
  if (CURRENCY_WORDS.test(s)) return { ok: false, reason: 'CURRENCY_SYMBOL', detail: s };

  // Grouping forms must be named before the decimal-comma form:
  // '1.200,5' is a grouped number in European locale, not a decimal point.
  if (/\d,\d{3}(\D|$)/.test(s)) return { ok: false, reason: 'THOUSANDS_SEPARATOR', detail: s };
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return { ok: false, reason: 'THOUSANDS_SEPARATOR', detail: s };
  if (/\d \d{3}/.test(s)) return { ok: false, reason: 'THOUSANDS_SEPARATOR', detail: s };
  if (/^\d+,\d+$/.test(s)) return { ok: false, reason: 'DECIMAL_COMMA', detail: s };

  if (/[eE]/.test(s)) return { ok: false, reason: 'SCIENTIFIC', detail: s };
  if (!CANONICAL_NUMBER.test(s)) return { ok: false, reason: 'FORMAT', detail: s };

  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, reason: 'NON_FINITE', detail: s };
  return { ok: true, value: n };
}

/* ---- bounds ---------------------------------------------------------------- */

/**
 * Plausibility bounds on any quantity-bearing value. Inclusive edges.
 * @returns {null | 'BELOW_MIN' | 'ABOVE_MAX'}
 */
function checkBounds(value, bounds) {
  if (!bounds) return null;
  const { min, max } = bounds;
  if (min !== undefined && min !== null && value < min) return 'BELOW_MIN';
  if (max !== undefined && max !== null && value > max) return 'ABOVE_MAX';
  return null;
}

/* ---- quarantine records ---------------------------------------------------- */

const RAW_TRUNCATE = 120;

/**
 * Build one quarantine record. Shape is contract: ingestion UIs (validation /
 * quarantine state), the data-health task queue and the ledger all consume it.
 * `asOf` is injected by the caller — this module owns no clock.
 */
function quarantineRecord({ fileKind, rowIndex, field, raw, reason, detail, asOf }) {
  let rawStr = String(raw);
  if (rawStr.length > RAW_TRUNCATE) rawStr = rawStr.slice(0, RAW_TRUNCATE);
  const rec = {
    fileKind: String(fileKind),
    rowIndex: rowIndex === undefined || rowIndex === null ? null : Number(rowIndex),
    field: String(field),
    raw: rawStr,
    reason: String(reason),
    quarantinedAt: String(asOf),
  };
  if (detail !== undefined && detail !== null) rec.detail = String(detail).slice(0, RAW_TRUNCATE);
  return Object.freeze(rec);
}

/* ---- quantity parse with bounds + optional semantics ------------------------ */

/**
 * Parse one quantity-bearing field with plausibility bounds and the A5
 * optional rule.
 *
 * @param {object} spec
 *   field      — canonical field name (goes into the quarantine record)
 *   optional   — true only for genuinely optional fields (A5: the ONLY legal
 *                fallback site). Default false.
 *   fallback   — value used when optional && genuinely missing (default null)
 *   bounds     — {min, max} plausibility window for this kind + field
 *   fileKind / rowIndex / asOf — quarantine-record context
 *
 * @returns one of
 *   {ok:true,  value, optionalApplied?:true}   — clean parse
 *   {ok:false, quarantine}                      — quarantine-grade failure
 *
 * Ordering rule: a present-but-corrupt optional value still quarantines.
 * Optional relaxes only MISSING/EMPTY, never corruption.
 */
function parseQuantity(raw, spec) {
  const spec_ = spec || {};
  const parsed = parseStrictNumber(raw);

  if (parsed.ok) {
    const breach = checkBounds(parsed.value, spec_.bounds);
    if (breach) {
      return {
        ok: false,
        quarantine: quarantineRecord({
          fileKind: spec_.fileKind, rowIndex: spec_.rowIndex, field: spec_.field,
          raw, reason: breach, detail: `value=${parsed.value}`, asOf: spec_.asOf,
        }),
      };
    }
    return { ok: true, value: parsed.value };
  }

  const genuinelyMissing = parsed.reason === 'MISSING' || parsed.reason === 'EMPTY';
  if (spec_.optional && genuinelyMissing) {
    return { ok: true, value: spec_.fallback === undefined ? null : spec_.fallback, optionalApplied: true };
  }
  return {
    ok: false,
    quarantine: quarantineRecord({
      fileKind: spec_.fileKind, rowIndex: spec_.rowIndex, field: spec_.field,
      raw, reason: parsed.reason, detail: parsed.detail, asOf: spec_.asOf,
    }),
  };
}

/* ---- deliveries bounds-guard (A5 confirmation semantics) -------------------- */

/**
 * Decide what happens when a deliveries value breaches its plausibility
 * bounds. A5 semantics, all four clauses in one return value:
 *   1. quarantine the value,
 *   2. substitute the trailing-7-day mean of VALID history entries,
 *   3. raise a data-health task,
 *   4. name the substitution in a UI banner.
 *
 * @param {object} input
 *   value      — the raw breaching value
 *   field      — field name ('qty', 'cases', …)
 *   history    — [{date:'YYYY-MM-DD', qty:number}] confirmed deliveries,
 *                any order; entries are trusted (already passed the boundary)
 *   bounds     — the plausibility window that was breached
 *   fileKind / rowIndex / asOf — quarantine-record context
 *
 * Corrupt entries never pollute the baseline: history entries failing their
 * own bounds are excluded from the mean, and if nothing valid remains the
 * guard reports NO_VALID_BASELINE rather than inventing a number.
 */
function deliveriesGuard(input) {
  const { value, field, history, bounds, fileKind, rowIndex, asOf } = input;

  const parsed = parseStrictNumber(value);
  const breachReason = parsed.ok ? checkBounds(parsed.value, bounds) : parsed.reason;

  const window = (history || []).filter((h) => {
    const p = parseStrictNumber(h && h.qty);
    if (!p.ok) return false;
    return checkBounds(p.value, bounds) === null;
  });

  let substituteWith = null;
  let baseline = 'NO_VALID_BASELINE';
  if (window.length > 0) {
    // trailing 7-day window: the 7 most recent distinct dates
    const byDate = new Map();
    for (const h of window) if (!byDate.has(h.date)) byDate.set(h.date, h.qty);
    const last7 = Array.from(byDate.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 7)
      .map((e) => e[1]);
    substituteWith = last7.reduce((a, b) => a + b, 0) / last7.length;
    baseline = 'TRAILING_7D_MEAN';
  }

  return {
    action: 'SUBSTITUTE_7D_MEAN',
    baseline,
    substituteWith,
    quarantined: quarantineRecord({
      fileKind, rowIndex, field, raw: value,
      reason: breachReason || 'BOUNDS_BREACH',
      asOf,
    }),
    task: {
      type: 'DATA_HEALTH',
      field: String(field),
      fileKind: String(fileKind),
      detail: 'Deliveries value breached plausibility bounds; substituted pending confirmation.',
    },
    banner: {
      message:
        'A deliveries value failed its plausibility bounds and was quarantined. ' +
        (substituteWith === null
          ? 'No valid trailing 7-day baseline exists — value treated as missing until confirmed.'
          : 'Running on the trailing 7-day mean until confirmed. Substitution is named here and in the data-health task.'),
    },
  };
}

module.exports = {
  parseStrictNumber,
  checkBounds,
  quarantineRecord,
  parseQuantity,
  deliveriesGuard,
};
