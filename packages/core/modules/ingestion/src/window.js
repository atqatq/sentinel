'use strict';
/* ============================================================================
 * Ingestion boundary v1 — window alignment guard (H8).
 *
 * Build spec §15.2 H8: "Make it a normative ingestion invariant that the
 * deliveries history covers the consumption window; refuse to seed otherwise."
 *
 * Why this is load-bearing: the consumption rate is RATE = T / histTotal-
 * Deliveries (engine.js [V3], frozen canon). T is consumption over the
 * consumption window; the denominator MUST be deliveries over the SAME
 * window. If deliveries history starts late, ends early, or has holes, the
 * denominator describes a different span than the numerator and the rate is
 * silently wrong — which silently wrongs every plan derived from it. The
 * guard refuses: a missing seed is an operational event; a wrong rate is a
 * wrong steering decision.
 *
 * Conventions (mirroring parse.js deliveriesGuard):
 *   - stable named reason codes,
 *   - data-health task + UI banner text on refusal,
 *   - refuse, don't guess: no proration, no interpolation, no clipping.
 *
 * Semantics:
 *   - dates are strict UTC calendar dates ('YYYY-MM-DD'), inclusive both ends;
 *   - touching intervals merge (no gap between Jan 31 and Feb 1);
 *   - coverage is checked INSIDE the consumption window (holes outside it are
 *     irrelevant; history may extend beyond the window on either side);
 *   - entries crossing a window edge are included in the total at full value
 *     and DISCLOSED in partialEdge (workbook-compatible counting, not hidden);
 *   - the formula itself stays in the engine: this module returns the guarded
 *     window total for engine.seedConsPerDelivery — no duplication, no drift.
 *
 * Pure: no-db, no-react, no-framework, no-io, no-clock. Deterministic.
 * ==========================================================================*/

const { parseStrictNumber } = require('./parse');

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict UTC calendar-date parse. Returns {ok, value, ms} or
 *  {ok:false, reason: MISSING_DATE | INVALID_DATE, detail}. */
function parseIsoDate(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'MISSING_DATE' };
  }
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
    return { ok: false, reason: 'INVALID_DATE', detail: `not a YYYY-MM-DD string: ${String(raw)}` };
  }
  const ms = Date.UTC(
    Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10)),
  );
  // round-trip rejects 2026-02-30, 2026-13-01, etc. — the calendar is truth
  const d = new Date(ms);
  const back = d.toISOString().slice(0, 10);
  if (back !== raw) {
    return { ok: false, reason: 'INVALID_DATE', detail: `not a real calendar date: ${raw}` };
  }
  return { ok: true, value: raw, ms };
}

/** Validate an inclusive {start, end} interval. Returns
 *  {ok, start, end, startMs, endMs} or {ok:false, reason, detail}. */
function validateInterval(obj, where) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, reason: 'INVALID_DATE', detail: `${where}: not an object` };
  }
  const s = parseIsoDate(obj.start);
  if (!s.ok) return { ok: false, reason: s.reason, detail: `${where}.start: ${s.detail || ''}`.trim() };
  const e = parseIsoDate(obj.end);
  if (!e.ok) return { ok: false, reason: e.reason, detail: `${where}.end: ${e.detail || ''}`.trim() };
  if (e.ms < s.ms) {
    return { ok: false, reason: 'END_BEFORE_START', detail: `${where}: ${obj.start} > ${obj.end}` };
  }
  return { ok: true, start: s.value, end: e.value, startMs: s.ms, endMs: e.ms };
}

/** Merge inclusive date intervals; touching intervals coalesce. */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.startMs <= last.endMs + DAY_MS) {
      if (iv.endMs > last.endMs) last.endMs = iv.endMs;
    } else {
      merged.push({ startMs: iv.startMs, endMs: iv.endMs });
    }
  }
  return merged;
}

const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);

/** H8 invariant check: does the deliveries history COVER the consumption
 *  window? Returns {ok:true, extent, coverage:'FULL'} or
 *  {ok:false, reason, gaps|invalid|detail, task, banner}.
 *  Reasons: INVALID_CONSUMPTION_WINDOW · INVALID_DELIVERIES_ENTRY ·
 *           NO_DELIVERIES_HISTORY · WINDOW_NOT_COVERED. */
function checkWindowCoverage(consumptionWindow, deliveriesEntries) {
  const cw = validateInterval(consumptionWindow, 'consumptionWindow');
  if (!cw.ok) {
    return { ok: false, reason: 'INVALID_CONSUMPTION_WINDOW', detail: cw.detail };
  }
  if (!Array.isArray(deliveriesEntries) || deliveriesEntries.length === 0) {
    return {
      ok: false, reason: 'NO_DELIVERIES_HISTORY',
      task: { type: 'DATA_HEALTH', field: 'deliveriesHistory', detail: 'No deliveries history rows; rate seeding refused (H8).' },
      banner: { text: 'Rate seeding refused: no deliveries history exists for the consumption window.' },
    };
  }
  const invalid = [];
  const valid = [];
  for (let i = 0; i < deliveriesEntries.length; i++) {
    const iv = validateInterval(deliveriesEntries[i], `deliveriesEntries[${i}]`);
    if (!iv.ok) invalid.push({ index: i, reason: iv.reason, detail: iv.detail });
    else valid.push(iv);
  }
  if (invalid.length > 0) {
    return { ok: false, reason: 'INVALID_DELIVERIES_ENTRY', invalid };
  }

  const merged = mergeIntervals(valid);
  // walk the window, subtract coverage, collect holes
  const gaps = [];
  let cursor = cw.startMs;
  for (const iv of merged) {
    if (iv.endMs < cursor) continue;              // entirely before the cursor
    if (iv.startMs > cursor) {
      gaps.push({ start: fmt(cursor), end: fmt(Math.min(iv.startMs - DAY_MS, cw.endMs)) });
    }
    if (iv.endMs >= cursor) cursor = iv.endMs + DAY_MS;
    if (cursor > cw.endMs) break;
  }
  if (cursor <= cw.endMs) {
    gaps.push({ start: fmt(cursor), end: fmt(cw.endMs) });
  }
  const extent = { start: fmt(merged[0].startMs), end: fmt(merged[merged.length - 1].endMs) };
  if (gaps.length > 0) {
    return {
      ok: false, reason: 'WINDOW_NOT_COVERED', gaps, extent,
      task: {
        type: 'DATA_HEALTH', field: 'deliveriesHistory',
        detail: `Deliveries history does not cover the consumption window (${cw.start}..${cw.end}); uncovered: ${gaps.map(g => `${g.start}..${g.end}`).join(', ')}.`,
      },
      banner: { text: 'Rate seeding refused: deliveries history leaves gaps in the consumption window. Named in the data-health task.' },
    };
  }
  return { ok: true, extent, coverage: 'FULL' };
}

/** Guarded seed inputs (the H8 gate in one call): coverage check, then the
 *  window total the engine needs as histTotalDeliveries for
 *  seedConsPerDelivery(T, histTotalDeliveries). The pipeline MUST pass this
 *  function's ok-result through to the engine — seeding is refused here,
 *  never half-applied. Entries crossing a window edge count at full value
 *  and are disclosed in partialEdge. Negative or unparsable delivery values
 *  refuse with their index (corrupt is quarantined upstream, never summed). */
function seedRateInputs(consumptionWindow, deliveriesEntries) {
  const coverage = checkWindowCoverage(consumptionWindow, deliveriesEntries);
  if (!coverage.ok) return coverage;

  const cw = validateInterval(consumptionWindow, 'consumptionWindow'); // validated by coverage
  let total = 0;
  let includedCount = 0;
  const partialEdge = [];
  for (let i = 0; i < deliveriesEntries.length; i++) {
    const e = deliveriesEntries[i];
    const parsed = parseStrictNumber(e.deliveries);
    if (!parsed.ok || parsed.value < 0) {
      return {
        ok: false, reason: 'INVALID_DELIVERIES_VALUE', index: i,
        detail: parsed.ok ? 'negative deliveries value' : parsed.reason,
        task: { type: 'DATA_HEALTH', field: 'deliveries', detail: `Deliveries row ${i} has an invalid value (${parsed.ok ? 'negative' : parsed.reason}); rate seeding refused.` },
        banner: { text: 'Rate seeding refused: a deliveries row carries an invalid value. Named in the data-health task.' },
      };
    }
    const s = Date.parse(e.start + 'T00:00:00Z');
    const en = Date.parse(e.end + 'T00:00:00Z');
    if (en < cw.startMs || s > cw.endMs) continue; // outside the window
    total += parsed.value;
    includedCount++;
    if (s < cw.startMs || en > cw.endMs) partialEdge.push({ index: i, start: e.start, end: e.end });
  }
  return {
    ok: true,
    window: { start: cw.start, end: cw.end },
    histTotalDeliveries: total,
    includedCount,
    partialEdge,
    coverage: coverage.coverage,
  };
}

module.exports = { parseIsoDate, validateInterval, mergeIntervals, checkWindowCoverage, seedRateInputs };
