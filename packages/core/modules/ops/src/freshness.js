'use strict';
/* ============================================================================
 * ops/freshness — the M9 freshness SLO + missing-deliveries alarm (A11).
 *
 * Contract sources (read, not remembered):
 *   - build spec §15.2 P2 M9: "freshness SLO and missing-deliveries alarm";
 *     delivery spec §9 A11 named spec `ops/freshness-alarm`; gate 17; lands
 *     in M2 per the milestone map (§6.3 M2 row ends with "freshness alarm").
 *   - DAT-01 (§16.3, verbatim in kpi-catalog): "Hours since last successful
 *     per-tenant seal, worst across file types · now − last sealed ingest ·
 *     owner DTA · hourly · target ≤ 26h; > 36h red + alarm".
 *   - ingestion spec: Deliveries is the demand primitive, "Daily preferred;
 *     weekly / monthly / quarterly / YTD accepted", Blocking: Yes — and
 *     §4: "no deliveries → the whole engine goes flat". That is why the
 *     deliveries dataset gets its OWN alarm channel beside DAT-01's bands:
 *     the engine's H8 gate refuses rate seeding when deliveries history is
 *     missing, so DTA must hear about a silent deliveries feed BEFORE the
 *     morning run refuses — not from the run's refusal after the fact.
 *   - build spec §16: "a KPI computed on stale data renders an explicit
 *     stale state, never a silent number" — the same rule for the pipeline
 *     itself: a file type with NO seal ever is ALARM with a null age, never
 *     "fresh by silence". kpi-catalog renders STALE from these facts (the
 *     D-023 banner consumes them too — the clock lives here, injected).
 *   - window.js conventions mirrored verbatim: stable named reason codes,
 *     DATA_HEALTH task + UI banner on every alarm; refuse, don't guess.
 *   - §16 target governance: "Targets are tenant-scoped and amendable per
 *     tenant without code change" — the deliveries channel's threshold is
 *     therefore a parameter (the tenant's accepted deliveries cadence in
 *     hours; default = the daily-preferred SLO). DAT-01's own 26/36 bands
 *     are the PIPELINE's SLO (hourly cadence, worst across file types) and
 *     do not shift per tenant.
 *
 * Purity: no-db, no-react, no-framework, no-io, no clock. Every timestamp
 * enters as a parameter (asOf, sealedAt); identical inputs always produce
 * identical output; alarms are ordered deterministically.
 *
 * Binding (tested, not commented): the 26/36 bands are extracted from the
 * kpi-catalog DAT-01 target text — spec drift fails CI before it ships.
 * ==========================================================================*/

const HOUR = 3600000;

/* DAT-01 target: "≤ 26h; > 36h red + alarm" — inclusive edges, exactly like
 * the C4 plausibility bounds: 26h is still FRESH, 36h is still DEGRADED. */
const DAT01_SLO_HOURS = 26;
const DAT01_ALARM_HOURS = 36;
const DAT01_OWNER = 'DTA';
const DAT01_ID = 'DAT-01';

const STATES = Object.freeze({
  FRESH: 'FRESH',
  DEGRADED: 'DEGRADED',
  ALARM: 'ALARM',
});

const ALARM_CODES = Object.freeze({
  FRESHNESS: 'FRESHNESS_ALARM',
  MISSING_DELIVERIES: 'MISSING_DELIVERIES',
});

const BREACH_REASONS = Object.freeze({
  NO_SEAL_EVER: 'NO_SEAL_EVER',
  SLO_BREACH_ALARM_36H: 'SLO_BREACH_ALARM_36H',
});

/* The 8 dataset kinds come from the ingestion module's public surface
 * (ADR-0001: cross-module access never reaches into src/ internals). The
 * parity test in the suite proves the surface and the ingestion manifest
 * agree 1:1 — an added file type without ops coverage fails CI here. */
const { DATASET_KINDS } = require('../../ingestion');

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function stateForAge(ageHours) {
  if (ageHours <= DAT01_SLO_HOURS) return STATES.FRESH;
  if (ageHours <= DAT01_ALARM_HOURS) return STATES.DEGRADED;
  return STATES.ALARM;
}

function bannerText(kind, ageHours, reason) {
  if (reason === BREACH_REASONS.NO_SEAL_EVER) {
    return `Freshness alarm: no successful ingest has ever sealed '${kind}'. Data-health holds the dataset at ALARM until a first seal exists.`;
  }
  return `Freshness alarm: no successful seal for '${kind}' for ${ageHours}h (DAT-01 red > ${DAT01_ALARM_HOURS}h).`;
}

function taskFor(kind, ageHours, reason) {
  const detail = reason === BREACH_REASONS.NO_SEAL_EVER
    ? `Dataset '${kind}' has never sealed — no successful ingest on record.`
    : `Dataset '${kind}' last sealed ${ageHours}h ago — past the DAT-01 alarm threshold (${DAT01_ALARM_HOURS}h).`;
  return { type: 'DATA_HEALTH', field: `freshness.${kind}`, detail };
}

/* Worst across file types: an unsealed kind outranks every aged value (a
 * null cannot be averaged into honesty), then the largest age wins. */
function worse(a, b) {
  if (a.ageHours === null) return a;
  if (b.ageHours === null) return b;
  return a.ageHours >= b.ageHours ? a : b;
}

/**
 * evaluateFreshness({ asOf, seals, missingDeliveriesCadenceHours? })
 *
 *   asOf        — epoch-ms "now" (injected; no clock).
 *   seals       — per-tenant seal stamps: [{ kind, sealedAt }] where kind is
 *                 one of the ingestion DATASET_KINDS and sealedAt is epoch-ms
 *                 or null/absent (never sealed). Multiple entries per kind
 *                 are legal: the LAST successful seal (max) is the DAT-01
 *                 formula's "last sealed ingest".
 *   missingDeliveriesCadenceHours
 *               — optional; the tenant's accepted deliveries cadence in
 *                 hours (default: DAT01_SLO_HOURS, the daily-preferred
 *                 convention). A tenant on a weekly deliveries cadence
 *                 passes 182 (the catalog's weekly threshold convention).
 *                 Must be a finite positive number when provided.
 *
 * Returns (deterministic, deep-frozen by construction — plain objects only):
 *   { asOf,
 *     perDataset: [ { kind, lastSealedAt, ageHours, state, reason|null } ]
 *                 — in canonical DATASET_KINDS order,
 *     worst:      { kind, lastSealedAt, ageHours, state, reason|null },
 *     dat01:      { id, value, state, owner }
 *                 — value = worst ageHours (null when ANY kind is unsealed:
 *                   no silent number), state = worst state,
 *     alarms:     [ FRESHNESS_ALARM per ALARM-state kind, dataset asc ]
 *                 — each { code, dataset, ageHours, reason, owner, task, banner },
 *     missingDeliveries: { raised, code?, ageHours?, state?, owner?, task?, banner? } }
 *
 * Throws (fail-closed, named):
 *   INVALID_ASOF / INVALID_SEALS / INVALID_SEAL_ENTRY /
 *   UNKNOWN_DATASET_KIND / FUTURE_SEAL / INVALID_DELIVERIES_CADENCE.
 */
function evaluateFreshness(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('INVALID_ASOF: evaluateFreshness expects { asOf, seals }');
  }
  const { asOf, seals } = input;
  if (!isFiniteNumber(asOf)) {
    throw new TypeError('INVALID_ASOF: asOf must be a finite epoch-ms number');
  }
  if (!Array.isArray(seals)) {
    throw new TypeError('INVALID_SEALS: seals must be an array of { kind, sealedAt }');
  }
  if (input.missingDeliveriesCadenceHours !== undefined
      && (!isFiniteNumber(input.missingDeliveriesCadenceHours)
          || input.missingDeliveriesCadenceHours <= 0)) {
    throw new TypeError('INVALID_DELIVERIES_CADENCE: missingDeliveriesCadenceHours must be a finite positive number of hours');
  }
  const deliveriesCadenceHours = input.missingDeliveriesCadenceHours === undefined
    ? DAT01_SLO_HOURS
    : input.missingDeliveriesCadenceHours;

  /* Validate + fold to the last successful stamp per kind. */
  const lastByKind = new Map(DATASET_KINDS.map((k) => [k, null]));
  for (let i = 0; i < seals.length; i++) {
    const s = seals[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new TypeError(`INVALID_SEAL_ENTRY: seals[${i}] must be an object`);
    }
    if (!DATASET_KINDS.includes(s.kind)) {
      throw new TypeError(`UNKNOWN_DATASET_KIND: seals[${i}].kind '${String(s.kind)}' is not an ingestion dataset kind`);
    }
    if (s.sealedAt !== null && s.sealedAt !== undefined) {
      if (!isFiniteNumber(s.sealedAt)) {
        throw new TypeError(`INVALID_SEAL_ENTRY: seals[${i}].sealedAt must be a finite epoch-ms number or null`);
      }
      if (s.sealedAt > asOf) {
        throw new TypeError(`FUTURE_SEAL: seals[${i}].sealedAt is in the future of asOf — a seal cannot be newer than now`);
      }
      const prev = lastByKind.get(s.kind);
      if (prev === null || s.sealedAt > prev) lastByKind.set(s.kind, s.sealedAt);
    }
  }

  /* Per-kind envelope (canonical order), then worst across file types. */
  const perDataset = DATASET_KINDS.map((kind) => {
    const lastSealedAt = lastByKind.get(kind);
    if (lastSealedAt === null) {
      return { kind, lastSealedAt: null, ageHours: null, state: STATES.ALARM, reason: BREACH_REASONS.NO_SEAL_EVER };
    }
    const ageHours = (asOf - lastSealedAt) / HOUR;
    const state = stateForAge(ageHours);
    return { kind, lastSealedAt, ageHours, state, reason: state === STATES.ALARM ? BREACH_REASONS.SLO_BREACH_ALARM_36H : null };
  });

  const worst = perDataset.reduce((w, e) => worse(w, e), perDataset[0]);

  /* DAT-01: value = worst age across file types; ANY unsealed kind holds the
   * whole number at null (a pipeline with a silent file type has no honest
   * freshness number — it has an alarm). */
  const anyUnsealed = perDataset.some((e) => e.ageHours === null);
  const dat01 = {
    id: DAT01_ID,
    value: anyUnsealed ? null : worst.ageHours,
    state: worst.state,
    owner: DAT01_OWNER,
  };

  const alarms = perDataset
    .filter((e) => e.state === STATES.ALARM)
    .map((e) => ({
      code: ALARM_CODES.FRESHNESS,
      dataset: e.kind,
      ageHours: e.ageHours,
      reason: e.reason,
      owner: DAT01_OWNER,
      task: taskFor(e.kind, e.ageHours, e.reason),
      banner: { text: bannerText(e.kind, e.ageHours, e.reason) },
    }))
    .sort((a, b) => (a.dataset < b.dataset ? -1 : a.dataset > b.dataset ? 1 : 0));

  /* The missing-deliveries channel: the demand primitive went quiet. Fires
   * when deliveries is anything but FRESH — past the tenant's accepted
   * cadence (daily preferred) or never sealed. The banner names the engine
   * consequence (H8 refuses rate seeding) so DTA hears it before the run. */
  const deliveries = perDataset.find((e) => e.kind === 'deliveries');
  let missingDeliveries = { raised: false };
  if (deliveries.state !== STATES.FRESH) {
    const cadenceBreached = deliveries.ageHours === null
      ? true
      : deliveries.ageHours > deliveriesCadenceHours;
    if (cadenceBreached) {
      missingDeliveries = {
        raised: true,
        code: ALARM_CODES.MISSING_DELIVERIES,
        dataset: 'deliveries',
        ageHours: deliveries.ageHours,
        state: deliveries.state,
        owner: DAT01_OWNER,
        task: {
          type: 'DATA_HEALTH',
          field: 'deliveriesHistory',
          detail: deliveries.ageHours === null
            ? 'Deliveries (the demand primitive) have never sealed — rate seeding (H8) will refuse and the engine goes flat until the file arrives.'
            : `Deliveries last sealed ${deliveries.ageHours}h ago — past the accepted cadence (${deliveriesCadenceHours}h); rate seeding (H8) will refuse once history no longer covers the window.`,
        },
        banner: {
          text: deliveries.ageHours === null
            ? 'Missing deliveries: the demand primitive has never sealed. Plans refuse (H8) until the deliveries file is ingested.'
            : `Missing deliveries: last deliveries seal is ${deliveries.ageHours}h old (accepted cadence ${deliveriesCadenceHours}h). Plans refuse (H8) once history stops covering the window.`,
        },
      };
    }
  }

  return { asOf, perDataset, worst, dat01, alarms, missingDeliveries };
}

module.exports = {
  HOUR,
  DAT01_ID,
  DAT01_SLO_HOURS,
  DAT01_ALARM_HOURS,
  DAT01_OWNER,
  STATES,
  ALARM_CODES,
  BREACH_REASONS,
  evaluateFreshness,
};
