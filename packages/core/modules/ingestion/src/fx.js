'use strict';
/* ============================================================================
 * ingestion/fx — the M10 fail-safe resolution order, as a PURE decision.
 *
 * Contract sources (read, not remembered):
 *   - build spec §14.17 (normative) + ADR-0003: the fx_rate_pin table is the
 *     SOURCE OF RECORD for every USD→local conversion; a conversion for day
 *     D resolves IN ORDER: (1) the exact pin for D — fresh; (2) no pin for D
 *     but an earlier pin exists — CONTINUE on the last pinned rate ≤ D with
 *     the derived money STALE-VISIBLE (stale:true + rateStale{pinnedFor,
 *     staleDays}, additive; a pin dated AFTER D is never a candidate);
 *     (3) no pin ≤ D at all — RATE_NOT_PINNED stands (D-015 verbatim; the
 *     blanket refusal NARROWS to never-pinned, the amendment explicit).
 *   - The audit's M10 [S] fix: "continue on last pinned rate, mark all
 *     derived money stale-visible, alarm; source of record named."
 *   - D-015: the rate direction is named (usdToLocalByDay), never implied;
 *     the money layer is fail-closed; the rate table is validated on every
 *     call (a malformed table must never be ingested against).
 *   - H4 (the canonical day discipline): day math is UTC-anchored arithmetic
 *     over 'YYYY-MM-DD' strings — no Date parsing of tenant data, no
 *     timezone drift. staleDays is a day COUNT, never a local subtraction.
 *
 * Purity: no-db, no-react, no-framework, no-io, no clock. Identical inputs
 * always produce identical outputs. The caller (normalizeMoney) composes
 * this decision; the worker's loader decides WHICH pins the table carries
 * (the exact day plus the latest ≤ the run day) — this layer never guesses
 * at what the loader meant to provide.
 * ==========================================================================*/

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC-anchored day count from day a to day b (b − a) over canonical
 * 'YYYY-MM-DD' strings. The H4 discipline: parse ONLY the canonical shape,
 * compute in UTC, never construct a local-time date. */
function dayDiff(fromDay, toDay) {
  const [fy, fm, fd] = fromDay.split('-').map(Number);
  const [ty, tm, td] = toDay.split('-').map(Number);
  const UTC_MS_PER_DAY = 86400000;
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / UTC_MS_PER_DAY);
}

/** Fail-closed rate-table validation — the SAME rules normalizeMoney has
 * always enforced (validateRateTable): every key a canonical day, every
 * rate a positive finite number. Kept here so the resolution decision is
 * self-contained and the money layer and this layer can never disagree
 * about what a well-formed table is. */
function validatePinTable(rateTable) {
  if (!rateTable || typeof rateTable !== 'object' || Array.isArray(rateTable)) {
    throw new TypeError('resolveRatePin: rateTable must be an object');
  }
  const byDay = rateTable.usdToLocalByDay;
  if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) {
    throw new TypeError('resolveRatePin: usdToLocalByDay must be an object');
  }
  for (const [day, rate] of Object.entries(byDay)) {
    if (!DAY_KEY_RE.test(day)) {
      throw new TypeError(`resolveRatePin: day key '${day}' is not YYYY-MM-DD`);
    }
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) {
      throw new TypeError(`resolveRatePin: rate for ${day} must be a positive finite number`);
    }
  }
  return true;
}

/**
 * resolveRatePin(rateTable, asOfDay) — the §14.17 resolution order.
 *
 *   rateTable — { usdToLocalByDay: { 'YYYY-MM-DD': <positive finite> } }
 *               (validated on every call; the loader's window: the exact
 *               day's pin plus the latest pin ≤ the run day).
 *   asOfDay   — the canonical 'YYYY-MM-DD' day the rows belong to. A
 *               malformed day is a WIRING error (the run's asOfDay is
 *               worker-scoped; parse/upstream guarantees the shape) — a
 *               TypeError, never a silent miss.
 *
 * Returns (deterministic):
 *   - exact pin for asOfDay      → { ok: true, rate, pinnedFor: asOfDay,
 *                                    staleDays: 0, stale: false }
 *   - last pin ≤ asOfDay         → { ok: true, rate, pinnedFor, staleDays,
 *                                    stale: true }
 *   - no pin ≤ asOfDay           → { ok: false, reason: 'RATE_NOT_PINNED' }
 *
 * A key dated AFTER asOfDay is never a candidate (tomorrow's rate must not
 * convert today's rows). Ties are impossible (UNIQUE per tenant-day at the
 * door); if a caller hands two keys for one day, the table is malformed at
 * the door — here the strict '>' scan keeps the LAST such key, which is the
 * deterministic choice, and the loader's shape (1–2 keys) makes the case
 * unreachable in practice.
 */
function resolveRatePin(rateTable, asOfDay) {
  validatePinTable(rateTable);
  if (typeof asOfDay !== 'string' || !DAY_KEY_RE.test(asOfDay)) {
    throw new TypeError(`resolveRatePin: asOfDay must be a YYYY-MM-DD string, got '${String(asOfDay)}'`);
  }
  const byDay = rateTable.usdToLocalByDay;

  /* Fresh path first: an exact pin is exact, whatever else the window carries. */
  if (Object.prototype.hasOwnProperty.call(byDay, asOfDay)) {
    return { ok: true, rate: Number(byDay[asOfDay]), pinnedFor: asOfDay, staleDays: 0, stale: false };
  }

  /* Fail-safe path: the latest pin STRICTLY BEFORE asOfDay (the window may
   * not even carry future keys, but the policy does not trust the loader —
   * a pin dated after the day is never a candidate, §14.17 rule 2). */
  let bestDay = null;
  for (const day of Object.keys(byDay)) {
    if (day < asOfDay && (bestDay === null || day > bestDay)) bestDay = day;
  }
  if (bestDay === null) {
    return { ok: false, reason: 'RATE_NOT_PINNED' };
  }
  return {
    ok: true,
    rate: Number(byDay[bestDay]),
    pinnedFor: bestDay,
    staleDays: dayDiff(bestDay, asOfDay),
    stale: true,
  };
}

module.exports = {
  DAY_KEY_RE,
  dayDiff,
  validatePinTable,
  resolveRatePin,
};
