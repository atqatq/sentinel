'use strict';
/* ============================================================================
 * ops/fx — the M10 FX-staleness alarm channel (§14.17, ADR-0003).
 *
 * Contract sources (read, not remembered):
 *   - The audit's M10 [S] fix: "continue on last pinned rate, mark all
 *     derived money stale-visible, alarm; source of record named. Acceptance
 *     test: ops/fx-stale.spec" — THIS file is the alarm half of that fix.
 *   - DAT-06 (§16.2, verbatim): "FX pin coverage % | Lines normalized with
 *     the pinned tenant-day rate | pinned lines ÷ total lines × 100 |
 *     currency normalization | DTA | daily | 100%" — the target is 100%
 *     DAILY coverage, so the alarm is BINARY: any conversion that rode a
 *     fallback is a breach of a daily SLO. Staleness is alarmed, not graded
 *     into bands — a stale rate is not a little bit acceptable; the AGE is
 *     disclosed, never excused.
 *   - ADR-0003 §4: the latest pin older than the evaluated day → FX_STALE;
 *     no pin at all → FX_NEVER_PINNED, naming the refusing consequence
 *     (the money layer quarantines USD rows — RATE_NOT_PINNED). A pin dated
 *     AFTER the evaluated day is never a candidate (tomorrow's rate must
 *     not excuse today's gap) — but it is not an error either (the job may
 *     legitimately pin ahead); it is simply not consulted here.
 *   - freshness.js conventions mirrored verbatim: stable named reason codes,
 *     DATA_HEALTH task + UI banner on every alarm; the clock is injected
 *     (asOf is a parameter); refuse, don't guess; identical inputs →
 *     identical outputs.
 *
 * Purity: no-db, no-react, no-framework, no-io, no clock. Day math rides
 * the canonical day-string discipline (H4) via ingestion's fx.dayDiff —
 * UTC-anchored day counts between 'YYYY-MM-DD' strings, never a local-time
 * subtraction.
 * ==========================================================================*/

const { dayDiff, validatePinTable } = require('../../ingestion/src/fx.js');

const FX_OWNER = 'DTA';
const FX_ID = 'DAT-06';

const STATES = Object.freeze({
  CURRENT: 'CURRENT',
  STALE: 'STALE',
  NEVER_PINNED: 'NEVER_PINNED',
});

const ALARM_CODES = Object.freeze({
  FX_STALE: 'FX_STALE',
  FX_NEVER_PINNED: 'FX_NEVER_PINNED',
});

/** evaluateFxStaleness({ asOfDay, pins })
 *
 *   asOfDay — the canonical 'YYYY-MM-DD' day the money conversions belong
 *             to (the run's day). Malformed → TypeError (wiring error).
 *   pins    — the tenant's pin window from the source of record:
 *             { usdToLocalByDay: { 'YYYY-MM-DD': <positive finite> } } —
 *             the SAME shape the money layer validates (one validation, one
 *             canon; the loader may provide any window, this layer never
 *             guesses at what the loader meant).
 *
 * Returns (deterministic, plain objects only):
 *   { asOfDay,
 *     dat06:    { id, value, state, owner }
 *               — value = staleDays when STALE (0 when CURRENT), null when
 *                 NEVER_PINNED (no silent number — an uncovered day has no
 *                 honest coverage value), state, owner },
 *     state:    CURRENT | STALE | NEVER_PINNED,
 *     latestPin: { day, staleDays } | null,
 *     alarm:    null | { code, staleDays|null, owner, task, banner } }
 *
 * Throws (fail-closed, named): INVALID_ASODAY / INVALID_PINS (+ the table
 * validation's own TypeErrors).
 */
function evaluateFxStaleness(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('INVALID_ASODAY: evaluateFxStaleness expects { asOfDay, pins }');
  }
  const { asOfDay, pins } = input;
  if (typeof asOfDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDay)) {
    throw new TypeError(`INVALID_ASODAY: asOfDay must be a YYYY-MM-DD string, got '${String(asOfDay)}'`);
  }
  validatePinTable(pins);

  /* The candidate: the latest pin ≤ asOfDay. Future pins exist, are legal,
   * and are NOT consulted — tomorrow's rate must not excuse today's gap. */
  const byDay = pins.usdToLocalByDay;
  let bestDay = null;
  for (const day of Object.keys(byDay)) {
    if (day <= asOfDay && (bestDay === null || day > bestDay)) bestDay = day;
  }

  if (bestDay === null) {
    return {
      asOfDay,
      dat06: { id: FX_ID, value: null, state: STATES.NEVER_PINNED, owner: FX_OWNER },
      state: STATES.NEVER_PINNED,
      latestPin: null,
      alarm: {
        code: ALARM_CODES.FX_NEVER_PINNED,
        staleDays: null,
        owner: FX_OWNER,
        task: {
          type: 'DATA_HEALTH',
          field: 'fx.pinCoverage',
          detail: `No USD→local rate is pinned on or before ${asOfDay} — every USD document row quarantines (RATE_NOT_PINNED) until the tenant's FX source lands a pin through the pin door (ADR-0003).`,
        },
        banner: {
          text: 'FX alarm: no pinned rate exists for the conversion day. USD documents refuse to ingest until a rate is pinned.',
        },
      },
    };
  }

  const staleDays = dayDiff(bestDay, asOfDay);
  if (staleDays === 0) {
    return {
      asOfDay,
      dat06: { id: FX_ID, value: 0, state: STATES.CURRENT, owner: FX_OWNER },
      state: STATES.CURRENT,
      latestPin: { day: bestDay, staleDays: 0 },
      alarm: null,
    };
  }

  return {
    asOfDay,
    dat06: { id: FX_ID, value: staleDays, state: STATES.STALE, owner: FX_OWNER },
    state: STATES.STALE,
    latestPin: { day: bestDay, staleDays },
    alarm: {
      code: ALARM_CODES.FX_STALE,
      staleDays,
      owner: FX_OWNER,
      task: {
        type: 'DATA_HEALTH',
        field: 'fx.pinCoverage',
        detail: `The newest USD→local pin is ${staleDays} day(s) old (pinned for ${bestDay}, converting ${asOfDay}) — derived money rides the LAST PINNED rate, stale-visible (M10). DAT-06 target is 100% daily coverage; the pin job has failed for ${staleDays} day(s).`,
      },
      banner: {
        text: `FX alarm: conversions for ${asOfDay} ride the rate pinned for ${bestDay} (${staleDays} day(s) stale) — derived money is stale-visible until the pin job succeeds.`,
      },
    },
  };
}

module.exports = {
  FX_ID,
  FX_OWNER,
  STATES,
  ALARM_CODES,
  evaluateFxStaleness,
};
