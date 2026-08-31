'use strict';
/* ============================================================================
 * ingest-service — deliveries day-expansion (the D-026 named unit).
 *
 * INGESTION_FILE_SPEC §1 accepts deliveries at daily / weekly / monthly /
 * quarterly / YTD granularity. The ENGINE reads daily actuals: plan-service
 * seeds the rate from delivery_day rows with granularity = 'daily' (the H8
 * window total), and §4 calls deliveries "calendar-day actuals". A weekly
 * dashboard row therefore cannot be stored as-is — and §14.4b's divisor
 * normalization (weekly 5.5, monthly 22…) belongs to the DRIVER (one
 * current-period value), not to history seeding.
 *
 * This unit is the named "day-expansion" D-026 deferred to the worker: a
 * bounded-period row (weekly / monthly / quarterly) spreads its quantity
 * over the period's calendar days as an EXACT-SUM daily distribution —
 * integer micros, the last day absorbing the rounding remainder, so the
 * period total (what the H8 seed sums) is preserved exactly. The smoothing
 * is DISCLOSED, never silent: §14.4b itself says coarse input "smooths away
 * day-to-day signal" and carries lower confidence; the plan/report carries
 * the disclosure per expanded row.
 *
 * YTD refuses by name: a YTD dashboard value is CUMULATIVE (the §14.4b
 * divisor WD×monthsElapsed divides the running total). Spreading a running
 * total across its whole period would double-count every earlier drop's
 * days — the honest outcome is a named refusal (YTD_CUMULATIVE_NOT_EXPANDABLE)
 * with a data-health task, and the tenant drops monthly instead.
 *
 * Purity: no-db, no-io, no-clock. Deterministic: identical rows expand to
 * deep-equal daily rows.
 * ==========================================================================*/

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MICRO = 1000000;

const EXPANDABLE = Object.freeze(['weekly', 'monthly', 'quarterly']);

function parseDay(raw, where) {
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
    return { ok: false, reason: 'INVALID_DATE', detail: `${where} must be a YYYY-MM-DD string, got '${String(raw)}'` };
  }
  const ms = Date.UTC(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10)));
  const back = new Date(ms).toISOString().slice(0, 10);
  if (back !== raw) return { ok: false, reason: 'INVALID_DATE', detail: `${where} is not a real calendar date: '${raw}'` };
  return { ok: true, value: raw, ms };
}

/**
 * Expand one validated deliveries row into the daily rows the engine reads.
 *
 * daily      → passes through unchanged (the executor re-checks start === end).
 * weekly /   → EXPANDABLE: `days` daily rows, exact-sum micro distribution,
 * monthly /    the last day absorbing the remainder; `monthsElapsed` and
 * quarterly    `businessUnit` ride every expanded day (the executor's columns).
 * ytd        → refuses YTD_CUMULATIVE_NOT_EXPANDABLE with task + banner.
 *
 * @returns {ok:true, rows:Array<{periodStart,periodEnd,granularity:'daily',qty:number,monthsElapsed:number|null,businessUnit:string|null}>, disclosure:string}
 *   | {ok:false, reason:'YTD_CUMULATIVE_NOT_EXPANDABLE'|'INVALID_PERIOD', detail?, task?, banner?}
 */
function expandDeliveriesRow(row) {
  if (!row || typeof row !== 'object') {
    return { ok: false, reason: 'INVALID_PERIOD', detail: 'expandDeliveriesRow expects a row object' };
  }
  const g = row.granularity;
  if (g === 'daily') {
    return {
      ok: true,
      rows: [{ periodStart: row.periodStart, periodEnd: row.periodEnd, granularity: 'daily', qty: row.qty, monthsElapsed: row.monthsElapsed ?? null, businessUnit: row.businessUnit ?? null }],
      disclosure: null,
    };
  }
  if (g === 'ytd') {
    return {
      ok: false,
      reason: 'YTD_CUMULATIVE_NOT_EXPANDABLE',
      detail: `ytd row ${row.periodStart}..${row.periodEnd} (qty ${row.qty}) is a cumulative running total — spreading it across its period would double-count every earlier drop's days. Drop monthly instead.`,
      task: {
        type: 'DATA_HEALTH', field: 'deliveries', fileKind: 'deliveries',
        detail: `A YTD deliveries row was not applied — YTD is cumulative and cannot be day-expanded. Drop monthly (or daily) for history the engine can seed.`,
      },
      banner: { text: 'A YTD deliveries row was skipped — cumulative totals cannot be expanded to days. Named in the data-health task.' },
    };
  }
  if (!EXPANDABLE.includes(g)) {
    return { ok: false, reason: 'INVALID_PERIOD', detail: `granularity '${String(g)}' is not a delivery_granularity the pipeline accepts` };
  }
  const s = parseDay(row.periodStart, 'periodStart');
  if (!s.ok) return { ok: false, reason: s.reason, detail: s.detail };
  const e = parseDay(row.periodEnd, 'periodEnd');
  if (!e.ok) return { ok: false, reason: e.reason, detail: e.detail };
  if (e.ms < s.ms) return { ok: false, reason: 'INVALID_PERIOD', detail: `periodStart ${row.periodStart} is after periodEnd ${row.periodEnd}` };
  if (typeof row.qty !== 'number' || !Number.isFinite(row.qty) || row.qty < 0) {
    return { ok: false, reason: 'INVALID_PERIOD', detail: `qty must be a non-negative finite number, got ${String(row.qty)}` };
  }
  const days = Math.round((e.ms - s.ms) / DAY_MS) + 1;
  const totalMicros = Math.round(row.qty * MICRO);
  const base = Math.floor(totalMicros / days);
  const remainder = totalMicros - base * days;
  const out = [];
  for (let i = 0; i < days; i++) {
    const micros = i === days - 1 ? base + remainder : base;
    out.push({
      periodStart: new Date(s.ms + i * DAY_MS).toISOString().slice(0, 10),
      periodEnd: new Date(s.ms + i * DAY_MS).toISOString().slice(0, 10),
      granularity: 'daily',
      qty: micros / MICRO,
      monthsElapsed: row.monthsElapsed ?? null,
      businessUnit: row.businessUnit ?? null,
    });
  }
  const last = out[out.length - 1];
  const disclosure = `${g} row ${row.periodStart}..${row.periodEnd} (qty ${row.qty}) expanded to ${days} daily rows — exact-sum distribution, the last day (${last.periodStart}) carries the rounding remainder; day-to-day signal is smoothed (§14.4b: coarse input, lower confidence)`;
  return { ok: true, rows: out, disclosure };
}

module.exports = { expandDeliveriesRow, EXPANDABLE };
