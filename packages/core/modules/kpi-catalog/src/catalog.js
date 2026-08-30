'use strict';
/* ============================================================================
 * Sentinel — kpi-catalog module: every KPI defined once, as data.
 *
 * Contract sources:
 *   - build spec §16 (the KPI catalog — screen 34): "Every KPI is defined
 *     once, as data: definition, formula, source dataset, owner role, refresh
 *     cadence and target band live with the kpi-catalog module (§14.15)…
 *     Every KPI carries a freshness stamp from the last sealed ingest that
 *     feeds it — a KPI computed on stale data renders an explicit stale
 *     state, never a silent number. Targets are tenant-scoped and amendable
 *     per tenant without code change."
 *   - build spec §15.1 R1: tenantCurrency mandatory; mixed rows WITHHOLD
 *     actualInvValue / targetInvValue / maxInvValue / actualDIO as null with
 *     kpiWithheld + reason — "a withheld KPI is an operational event; a wrong
 *     KPI is a wrong steering decision"
 *   - build spec §15.1 R2: active === 0 → serviceLevel = null; UI renders
 *     "insufficient plannable data"
 *   - delivery spec §9 A1/A2 named proofs: kpi/tenant-currency-mandatory ·
 *     kpi/mixed-currency-withholds-value · kpi/service-level-null-when-unplannable
 *   - delivery spec gates 4 (fail-closed) + 15 (KPI layer dataState-aware)
 *
 * THIS MODULE NEVER RE-IMPLEMENTS A FORMULA. Formulas are the frozen canon
 * of their owning modules (the planning engine for the portfolio strip) —
 * same discipline as H8: the catalog carries the formula TEXT as spec
 * reference, the mapping functions carry engine OUTPUT into the dataState
 * envelope, and any grain difference between catalog text and verified canon
 * is DISCLOSED on the entry, never silently reconciled.
 *
 * States (the dataState envelope):
 *   OK                — computed from a fresh seal; value present
 *   WITHHELD          — fail-closed refusal (R1); value null, reason mandatory
 *   INSUFFICIENT_DATA — the population cannot produce the KPI (R2); value null
 *   STALE             — value present but the seal is older than the entry's
 *                       staleAfterHours — rendered stale, never silent
 *
 * Purity: no-db, no-react, no-framework, no-io, no clock. Every timestamp
 * enters as a parameter (asOf / lastSealedAt); identical inputs always
 * produce identical results.
 * ==========================================================================*/

const KPI_STATES = Object.freeze({
  OK: 'OK',
  WITHHELD: 'WITHHELD',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  STALE: 'STALE',
});

/* ---- the catalog (§16, verbatim; markdown emphasis stripped) -------------- */
/* staleAfterHours: the time-staleness threshold in hours. Time-based cadences
 * get explicit thresholds (daily → 26h, matching DAT-01's ≤26h tenant
 * expectation; weekly → 182h; monthly → 744h; hourly → 2h). Event-based
 * cadences ("every recompute", "weekly per session") get null — time cannot
 * judge them; their freshness is sequenced by the events themselves.        */
const CATALOG = [
  /* ---- 16.1 Sourcing (SRC) — owner: SBR unless noted ---- */
  { id: 'SRC-01', group: 'SRC', name: 'Supplier OTIF %', definition: 'Receipts that are on-time and in-full vs PO lines due in the window', formula: 'on-time-in-full receipt lines ÷ PO lines due × 100', source: 'R1 POs + R2 receipts (receipt dates, received qty)', owner: 'SBR', cadence: 'daily', staleAfterHours: 26, target: '≥ 95%; < 90% red' },
  { id: 'SRC-02', group: 'SRC', name: 'Fill rate %', definition: 'Lines received complete vs lines ordered', formula: 'complete lines ÷ ordered lines × 100', source: 'R1 + R2', owner: 'SBR', cadence: 'daily', staleAfterHours: 26, target: '≥ 97%' },
  { id: 'SRC-03', group: 'SRC', name: 'Lead-time drift (days)', definition: 'Realized P50 lead days minus agreed lead days, per supplier × category', formula: 'P50(realized) − agreed', source: 'R1 promised vs actual + learning loop', owner: 'SBR', cadence: 'weekly', staleAfterHours: 182, target: '≤ +1d amber; +3d red' },
  { id: 'SRC-04', group: 'SRC', name: 'Price variance %', definition: 'PO unit price vs agreed baseline price', formula: '(PO price − baseline) ÷ baseline × 100', source: 'R1 + price baselines', owner: 'BYR', cadence: 'daily', staleAfterHours: 26, target: 'within ±3%' },
  { id: 'SRC-05', group: 'SRC', name: 'Single-source exposure', definition: 'Share of active categories with exactly one approved supplier', formula: 'single-source categories ÷ active categories × 100', source: 'Supplier Scorecards single-source tile (A15.2)', owner: 'SBR', cadence: 'weekly', staleAfterHours: 182, target: '≤ 15%' },
  { id: 'SRC-06', group: 'SRC', name: 'Top-5 spend concentration', definition: 'Share of spend held by the five largest suppliers', formula: 'top-5 supplier spend ÷ total spend × 100', source: 'R1 spend', owner: 'SBR / SCM', cadence: 'monthly', staleAfterHours: 744, target: 'trend-monitored' },
  { id: 'SRC-07', group: 'SRC', name: 'Realized savings %', definition: 'Verified savings against the four baselines (screen 12)', formula: 'realized savings ÷ addressable spend × 100', source: 'execution-feedback module', owner: 'SCM', cadence: 'monthly', staleAfterHours: 744, target: '> 2% YTD' },

  /* ---- 16.2 Inventory (INV) — owner: SCM unless noted ---- */
  { id: 'INV-01', group: 'INV', name: 'IRA %', definition: 'Inventory record accuracy from ingested count adjustments (§14.12 measure-only)', formula: '1 − (lines with variance beyond tolerance ÷ counted lines) × 100', source: 'count sessions + ingested adjustments', owner: 'DTA / warehouse owner', cadence: 'weekly per session', staleAfterHours: null, target: '≥ 98%' },
  { id: 'INV-02', group: 'INV', name: 'DIO (days)', definition: 'Days of inventory outstanding', formula: 'average inventory value ÷ daily COGS', source: 'inventory value + consumption', owner: 'SCM', cadence: 'daily', staleAfterHours: 26, target: 'tenant target band' },
  { id: 'INV-03', group: 'INV', name: 'Reorder-breach count', definition: 'SKUs below reorder point at each recompute', formula: 'count of status-below-reorder SKUs', source: 'engine output (screen 2)', owner: 'SCM / BYR', cadence: 'every recompute', staleAfterHours: null, target: 'trend; auto-tasks' },
  { id: 'INV-04', group: 'INV', name: 'Service level %', definition: 'Shortage-free SKU-days share', formula: 'shortage-free SKU-days ÷ total SKU-days × 100', source: 'engine run-outs', owner: 'SCM', cadence: 'daily', staleAfterHours: 26, target: '≥ 97%' },
  { id: 'INV-05', group: 'INV', name: 'Dead stock %', definition: 'Value with no movement in 60 days', formula: 'dead-stock value ÷ total value × 100', source: 'movement ledger (ingested)', owner: 'SCM', cadence: 'weekly', staleAfterHours: 182, target: '≤ 5%' },
  { id: 'INV-06', group: 'INV', name: 'Expiry-risk value', definition: 'Value expiring within 7 days', formula: 'Σ value(expiry ≤ 7d)', source: 'shelf-life + FEFO data', owner: 'SCM', cadence: 'daily', staleAfterHours: 26, target: '≤ agreed cap' },
  { id: 'INV-07', group: 'INV', name: 'Transfer reconcile rate %', definition: 'Approved transfer plans verified against ingested movement (§14.7)', formula: 'RECONCILED ÷ (RECONCILED + MISMATCH) × 100', source: 'transfer plans + goods-in/out aggregates', owner: 'SCM', cadence: 'daily', staleAfterHours: 26, target: '≥ 95%; MISMATCH > 7d escalates' },
  { id: 'INV-08', group: 'INV', name: 'Quarantine aging (qty-days)', definition: 'Open quarantine exposure over time', formula: 'Σ(open quarantine qty × days open)', source: 'warehouse-kind reads (ingested, read-only)', owner: 'warehouse owner', cadence: 'daily', staleAfterHours: 26, target: 'downward trend' },

  /* ---- 16.3 Data Health (DAT) — owner: DTA ---- */
  { id: 'DAT-01', group: 'DAT', name: 'Ingestion freshness (hours)', definition: 'Hours since last successful per-tenant seal, worst across file types', formula: 'now − last sealed ingest', source: 'pipeline', owner: 'DTA', cadence: 'hourly', staleAfterHours: 2, target: '≤ 26h; > 36h red + alarm' },
  { id: 'DAT-02', group: 'DAT', name: 'First-pass acceptance %', definition: 'Files passing all gates without manual repair', formula: 'clean files ÷ received files × 100', source: 'pipeline', owner: 'DTA', cadence: 'daily', staleAfterHours: 26, target: '≥ 90%' },
  { id: 'DAT-03', group: 'DAT', name: 'Rejected-row rate %', definition: 'Rows quarantined by validation gates', formula: 'rejected rows ÷ ingested rows × 100', source: 'pipeline', owner: 'DTA', cadence: 'daily', staleAfterHours: 26, target: '≤ 1%' },
  { id: 'DAT-04', group: 'DAT', name: 'Duplicate-hit rate %', definition: 'Idempotency keys seen before (re-upload hygiene)', formula: 'duplicate keys ÷ ingested keys × 100', source: 'pipeline', owner: 'DTA', cadence: 'daily', staleAfterHours: 26, target: 'informational' },
  { id: 'DAT-05', group: 'DAT', name: 'Master-data completeness %', definition: 'SKUs/suppliers carrying required fields (lead time, conversion factors, Supplier ID)', formula: 'complete records ÷ population × 100', source: 'master data', owner: 'DTA', cadence: 'weekly', staleAfterHours: 182, target: '≥ 95%' },
  { id: 'DAT-06', group: 'DAT', name: 'FX pin coverage %', definition: 'Lines normalized with the pinned tenant-day rate', formula: 'pinned lines ÷ total lines × 100', source: 'currency normalization', owner: 'DTA', cadence: 'daily', staleAfterHours: 26, target: '100%' },

  /* ---- 16.4 Team productivity (TM) — owner: SCM unless noted ---- */
  { id: 'TM-01', group: 'TM', name: 'Plan-to-execute latency (h)', definition: 'Median hours from proposal APPROVED to the matching Precoro action', formula: 'median(approved → matching PO/receipt)', source: 'feedback chain', owner: 'SCM', cadence: 'daily', staleAfterHours: 26, target: '≤ 48h' },
  { id: 'TM-02', group: 'TM', name: 'Reconciliation auto-rate %', definition: 'Share of reconciliations completed without manual touch — measures the "Precoro executes, Sentinel plans + verifies" boundary working as designed', formula: 'auto-RECONCILED ÷ total reconciled × 100', source: '§14.7 pipeline', owner: 'SCM', cadence: 'daily', staleAfterHours: 26, target: '≥ 90%' },
  { id: 'TM-03', group: 'TM', name: 'Exception backlog & age', definition: 'Open MISMATCH plans, quarantine recommendations, recount flags — with age buckets', formula: 'count + max age by type', source: 'tasks', owner: 'SCM', cadence: 'daily', staleAfterHours: 26, target: 'none > 7d' },
  { id: 'TM-04', group: 'TM', name: 'Approval SLA (h)', definition: 'Median queue time by approval type', formula: 'median(time in queue)', source: 'approvals (screen 20)', owner: 'O / SCM', cadence: 'daily', staleAfterHours: 26, target: '≤ 24h' },
  { id: 'TM-05', group: 'TM', name: 'Weekly active users', definition: 'Distinct active users by tenant × role', formula: 'distinct users / week', source: 'platform', owner: 'O', cadence: 'weekly', staleAfterHours: 182, target: 'adoption trend' },

  /* ---- 16.5 Project milestones (PM) ---- */
  { id: 'PM-01', group: 'PM', name: 'Cutover readiness %', definition: 'Completed items across the cutover workstreams', formula: 'done items ÷ total items × 100', source: 'cutover project spec', owner: 'O', cadence: 'weekly', staleAfterHours: 182, target: 'on-plan curve' },
  { id: 'PM-02', group: 'PM', name: 'Data-readiness gates passed', definition: 'Tenants × file types fully passing ingestion gates', formula: 'gates passed ÷ gates planned', source: 'ingestion', owner: 'DTA', cadence: 'weekly', staleAfterHours: 182, target: 'all tenants × types by cutover' },
];

/* ---- catalog access -------------------------------------------------------- */

function getCatalog() { return CATALOG.map((e) => Object.freeze({ ...e })); }
function kpiById(id) {
  const e = CATALOG.find((k) => k.id === id);
  return e ? Object.freeze({ ...e }) : null;
}

/* ---- freshness (§16: a freshness stamp is mandatory, staleness is explicit) - */

function ageHoursBetween(fromMs, toMs) {
  return (toMs - fromMs) / 3600000;
}

/**
 * Time-staleness for one KPI entry.
 * @returns {{stale:boolean, ageHours:number, staleAfterHours:number|null}}
 *   stale false when the entry is event-based (staleAfterHours null) — time
 *   cannot judge an event cadence; strictly greater than the threshold is
 *   stale (at exactly the threshold the KPI is still fresh).
 */
function evaluateStaleness(lastSealedAt, staleAfterHours, asOf) {
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) throw new TypeError('evaluateStaleness: asOf must be epoch ms');
  if (typeof lastSealedAt !== 'number' || !Number.isFinite(lastSealedAt)) throw new TypeError('evaluateStaleness: lastSealedAt must be epoch ms');
  if (lastSealedAt > asOf) throw new TypeError('evaluateStaleness: seal is in the future of asOf');
  if (staleAfterHours === null || staleAfterHours === undefined) {
    return { stale: false, ageHours: ageHoursBetween(lastSealedAt, asOf), staleAfterHours: null };
  }
  const age = ageHoursBetween(lastSealedAt, asOf);
  return { stale: age > staleAfterHours, ageHours: age, staleAfterHours };
}

/* ---- engine → catalog mapping (formulas stay engine-owned) ----------------- */

// The six money metrics the engine withholds under R1, verbatim metric names.
const MONEY_METRICS = Object.freeze([
  'actualInvValue', 'targetInvValueBottomUp', 'maxInvValue',
  'actualDIO', 'targetInvValueTopDown', 'targetInvValueNoStaging',
]);

// INV-04 grain note (disclosed, not silently reconciled): the catalog text
// says "shortage-free SKU-days", while the verified engine canon computes the
// share over plannable refs (1 − shortages ÷ active). The canon is frozen —
// the mapping uses it as-is and discloses the grain here and on the result.
const INV04_GRAIN_NOTE = 'engine canon computes the share over plannable refs (1 − shortages ÷ active); catalog text names SKU-days — difference disclosed, reconciliation owes a spec amendment';

function baseEnvelope(entry, freshness) {
  return {
    id: entry ? entry.id : null,
    metric: null,
    catalogRef: entry || null,
    value: null,
    dataState: KPI_STATES.OK,
    reason: null,
    freshness, // {ageHours, staleAfterHours, stale}
  };
}

function stampState(result, state, reason) {
  result.dataState = state;
  result.reason = reason || null;
  return result;
}

/**
 * Map the engine's portfolioKPIs output into dataState-aware KPI results.
 *
 * Mandatory context (fail-closed, R1 philosophy — optional tripwires fail
 * open): `portfolio.currency` (the tenant currency the engine stamped) and
 * `opts.lastSealedAt` (the §16 freshness stamp) must both be present or the
 * call throws — a KPI strip without its currency context or its seal is a
 * wiring error, not a renderable number.
 *
 * Withholding is surgical: R1 nulls the money metrics only — counts and the
 * service level still render from a mixed-currency run.
 *
 * @returns {{asOf:number, sealedAt:number, stale:boolean, grainNotes:string[], results:Array}}
 */
function fromEnginePortfolio(portfolio, opts) {
  if (!portfolio || typeof portfolio !== 'object') throw new TypeError('fromEnginePortfolio: portfolio must be an object (engine portfolioKPIs output)');
  if (typeof opts !== 'object' || opts === null) throw new TypeError('fromEnginePortfolio: opts required');
  const { asOf, lastSealedAt } = opts;
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) throw new TypeError('fromEnginePortfolio: asOf must be epoch ms');
  if (typeof lastSealedAt !== 'number' || !Number.isFinite(lastSealedAt)) throw new TypeError('fromEnginePortfolio: lastSealedAt (the §16 freshness stamp) is mandatory');

  // kpi/tenant-currency-mandatory — the layer refuses to render without the
  // tenant-currency context the engine stamps on every portfolio.
  if (typeof portfolio.currency !== 'string' || portfolio.currency === '') {
    throw new TypeError('fromEnginePortfolio: portfolio.currency (tenant currency) is mandatory — fail-closed money layer');
  }

  const inv02 = kpiById('INV-02');
  const inv03 = kpiById('INV-03');
  const inv04 = kpiById('INV-04');

  // Staleness is evaluated per the daily-cadence entries (INV-02/INV-04);
  // INV-03 is event-based and never time-stale.
  const fresh = evaluateStaleness(lastSealedAt, inv02.staleAfterHours, asOf);

  const kpiWithheld = portfolio.kpiWithheld === true;
  const withheldReason = kpiWithheld
    ? `rows not normalized to tenant currency (${(portfolio.mixedCurrencies || []).join(', ')})`
    : null;

  const results = [];

  // The money strip — R1's named four plus the engine's other money metrics.
  for (const metric of MONEY_METRICS) {
    const entry = metric === 'actualDIO' ? inv02 : null;
    const r = baseEnvelope(entry, fresh);
    r.metric = metric;
    const raw = portfolio[metric];
    if (kpiWithheld) {
      // R1: withheld money KPIs are null WITHHELD — never a poisoned sum.
      stampState(r, KPI_STATES.WITHHELD, withheldReason);
      if (raw !== null && raw !== undefined) throw new TypeError(`fromEnginePortfolio: engine claims kpiWithheld but ${metric} carries a value — inconsistent portfolio`);
    } else {
      r.value = typeof raw === 'number' ? raw : null;
      if (fresh.stale) stampState(r, KPI_STATES.STALE, 'seal older than the KPI cadence');
    }
    results.push(r);
  }

  // INV-03 — reorder-breach count (event-based cadence, never time-stale).
  {
    const r = baseEnvelope(inv03, { stale: false, ageHours: fresh.ageHours, staleAfterHours: null });
    r.metric = 'reorderBreachCount';
    const counts = portfolio.counts || {};
    const composition = {
      zeroStock: counts['Zero Stock'] || 0,
      belowSafety: counts['Below Safety'] || 0,
      belowReorder: counts['Below Reorder'] || 0,
    };
    // "SKUs below reorder point" = the three at-or-below-reorder ladder
    // states; the composition is disclosed on the result, never averaged in.
    r.value = composition.zeroStock + composition.belowSafety + composition.belowReorder;
    r.composition = composition;
    results.push(r);
  }

  // INV-04 — service level. R2: null when nothing is plannable; the layer
  // renders that as INSUFFICIENT_DATA with the mandated UI string.
  {
    const r = baseEnvelope(inv04, fresh);
    r.metric = 'serviceLevel';
    r.grainNote = INV04_GRAIN_NOTE;
    const raw = portfolio.serviceLevel;
    if (raw === null || raw === undefined) {
      stampState(r, KPI_STATES.INSUFFICIENT_DATA, 'insufficient plannable data');
    } else {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
        throw new TypeError(`fromEnginePortfolio: serviceLevel must be a fraction in [0,1] or null — got ${raw}`);
      }
      r.value = raw * 100; // catalog formula: × 100; the UI formats decimals
      if (fresh.stale) stampState(r, KPI_STATES.STALE, 'seal older than the KPI cadence');
    }
    results.push(r);
  }

  return {
    asOf,
    sealedAt: lastSealedAt,
    currency: portfolio.currency,
    stale: fresh.stale,
    grainNotes: [INV04_GRAIN_NOTE],
    results,
  };
}

module.exports = {
  KPI_STATES, MONEY_METRICS, INV04_GRAIN_NOTE,
  getCatalog, kpiById, evaluateStaleness, fromEnginePortfolio,
};
