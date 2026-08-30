'use strict';
/* ============================================================================
 * plan-service — engine live wiring + sealed snapshots (M2 unit 3).
 *
 * Contract sources (read, not remembered):
 *   - delivery spec §6.3 M2: "Engine live (computeRef + KPIs fail-closed)";
 *     gates 15 (dataState-aware KPIs) served through kpi-catalog.
 *   - build spec §11 (daily seal): a snapshot per tenant stores the full
 *     computed state + payload hash. M2 slice: plan_seal, one per tenant-day.
 *   - build spec (deliveries dashboard row): deliveriesPerDay is a manually
 *     entered driver, "normalized by normalizeDeliveries()" — the run request
 *     carries it; this service never re-derives it from history.
 *   - engine canon (frozen): S = Start+In−End−Out; T = S×CF;
 *     RATE = seedConsPerDelivery(T, histTotalDeliveries);
 *     histMonthly = T / histMonths (workbook $U$1 = 3).
 *   - H8 (build spec §15.2): the deliveries history must cover the
 *     consumption window — seedRateInputs refuses otherwise; a refusal here
 *     refuses the RUN (a wrong rate wrongs every plan derived from it).
 *   - §14.4b (identical basis): the driver divisor and the magnification use
 *     the SAME working-day count — a real tenant calendar passes
 *     calendar-derived wd to BOTH normalizeDeliveries and computeRef; a flat
 *     (or absent) calendar takes the engine's byte-identical default.
 *   - ADR-0002: every DB touch is tenant-scoped via app.tenant_id — enforced
 *     in the adapters behind the ports, proven live in plan-seal-live.
 *
 * Ports (injected — this module owns orchestration, not I/O):
 *   loader.loadTenant(tenantId)
 *     → { code, currencyCode, timezone, calendarSpec|null } | null
 *   loader.loadPlanInputs(tenantId)
 *     → { paramsByRef: { [ref]: {lead,safetyDays,orderFreq,moq} each
 *                         {manual,calculated,override} },
 *         items: [{ sku, recipeRef, conversionFactor, convertedUnit, price,
 *                   shelfLifeDays, preferredForRecipeRef }],
 *         stock: [{ sku, quantity, currency }],   // currency = tenant currency
 *                                                // (C2 already normalized: tenant_value)
 *         openPo: [{ sku, poNumber, waitingQtyConverted }],  // null = unconverted
 *         consumption: [{ sku, start, end, startBalance, goodsIn, goodsOut, endBalance }],
 *         deliveries: [{ start, end, deliveries }],  // H8 interval form (daily rows → [day,day])
 *         latestSeal: { sealDate, payloadHash, sealedAt } | null }
 *   saver.saveSeal({tenantId, sealDate, engineVersion, schemaVersion,
 *                   payloadHash, payload, sealedBy})
 *     → { replayed: bool, seal: { tenantId, sealDate, engineVersion,
 *           schemaVersion, payloadHash, payload, sealedAt } }
 *
 * Determinism: asOf is injected (no clock); rows are sorted before hashing;
 * identical inputs produce an identical payloadHash (tested).
 * ==========================================================================*/

const crypto = require('crypto');
const E = require('../../core/modules/planning-engine');
const KPI = require('../../core/modules/kpi-catalog');
const CAL = require('../../core/modules/calendar');
const { parseIsoDate, seedRateInputs } = require('../../core/modules/ingestion').window;
const { SCHEMA_VERSION } = require('../../db');
const { canonicalJson } = require('./canonicalJson');

const DRIVER_GRANULARITIES = ['daily', 'weekly', 'monthly', 'quarterly', 'ytd'];
/* null/undefined/'' are ABSENT values — Number(null) would trap them as 0,
 * the exact nz() defect class this system exists to kill. */
const asNum = (x) => (x === null || x === undefined || x === ''
  ? null
  : (Number.isFinite(Number(x)) ? Number(x) : null));

/* ---- wiring errors (TypeError, per module convention) -------------------- */

function assertPorts(ports) {
  if (!ports || typeof ports !== 'object') {
    throw new TypeError('runPlan: ports object required ({loader, saver})');
  }
  const l = ports.loader;
  if (!l || typeof l !== 'object' || typeof l.loadTenant !== 'function' ||
      typeof l.loadPlanInputs !== 'function') {
    throw new TypeError('runPlan: ports.loader must provide loadTenant + loadPlanInputs');
  }
  if (!ports.saver || typeof ports.saver !== 'object' ||
      typeof ports.saver.saveSeal !== 'function') {
    throw new TypeError('runPlan: ports.saver must provide saveSeal');
  }
}

/* ---- request-shape refusals (400-class; data refusals carry task+banner) -- */

function invalidRequest(detail) {
  return { verdict: 'REFUSED', reason: 'INVALID_REQUEST', detail };
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') return invalidRequest('request body required');
  if (typeof request.tenantId !== 'string' || request.tenantId === '') {
    return invalidRequest('tenantId (non-empty string) is required');
  }
  if (!request.driver || typeof request.driver !== 'object') {
    return invalidRequest('driver {value, granularity} is required — the deliveries dashboard entry');
  }
  if (!Number.isFinite(asNum(request.driver.value))) {
    return invalidRequest('driver.value must be a finite number');
  }
  if (typeof request.driver.granularity !== 'string' ||
      !DRIVER_GRANULARITIES.includes(request.driver.granularity.toLowerCase())) {
    return invalidRequest(`driver.granularity must be one of ${DRIVER_GRANULARITIES.join(' | ')}`);
  }
  if (request.targets !== undefined && request.targets !== null) {
    if (typeof request.targets !== 'object') return invalidRequest('targets must be an object');
    for (const k of ['cogsPct', 'avgRevPerDelivery', 'targetDIO']) {
      const v = request.targets[k];
      if (v === undefined || v === null) continue;
      const n = asNum(v);
      if (n === null || n < 0) return invalidRequest(`targets.${k} must be a finite number >= 0`);
    }
  }
  if (String(request.driver.granularity).toLowerCase() === 'ytd') {
    const m = request.driver.monthsElapsed;
    if (!Number.isInteger(m) || m < 1) {
      return invalidRequest('driver.monthsElapsed must be an integer >= 1 for a ytd driver');
    }
  }
  return null;
}

/* ---- calendar basis (§14.4b identical-basis discipline) ------------------- */
/* Returns { ok, workingDaysOpts, basisNote } — workingDaysOpts is passed to
 * BOTH normalizeDeliveries and computeRef (or {} for the byte-identical
 * engine default when the tenant has no calendar or a flat one). */

function resolveBasis(tenant, asOfParsed) {
  const spec = tenant.calendarSpec;
  if (!spec) return { ok: true, workingDaysOpts: {}, basisNote: 'flat (workbook constants)' };
  const parsed = CAL.parseCalendar(spec);
  if (!parsed.ok) {
    return { ok: false, refusal: {
      verdict: 'REFUSED', reason: 'INVALID_CALENDAR', detail: parsed.detail || parsed.reason,
      task: { type: 'DATA_HEALTH', field: 'tenantCalendar', detail: `Tenant working calendar is invalid (${parsed.reason}); plan run refused.` },
      banner: { text: 'Plan run refused: the tenant working calendar is invalid. Named in the data-health task.' },
    } };
  }
  if (parsed.calendar.kind === 'flat') {
    return { ok: true, workingDaysOpts: {}, basisNote: 'flat tenant calendar (workbook constants)' };
  }
  const year = Number(asOfParsed.value.slice(0, 4));
  const month = Number(asOfParsed.value.slice(5, 7));
  return { ok: true, realCalendar: parsed.calendar, year, month, workingDaysOpts: null, basisNote: 'tenant working calendar' };
}

/* For a real calendar: the per-granularity working-day count — the month of
 * asOf for daily/weekly/monthly/quarterly; JANUARY of the year for ytd
 * (calendar.deliveryBasis ytd convention: wd(Jan) × monthsElapsed). The SAME
 * count feeds the driver divisor and the magnification, so §14.4b's
 * cancellation holds exactly per period. */
function workingDaysForGranularity(basis, granularity, monthsElapsed) {
  const cal = basis.realCalendar;
  const targetMonth = granularity === 'ytd' ? 1 : basis.month;
  const r = CAL.workingDaysInMonth(cal, basis.year, targetMonth);
  if (!r.ok) {
    return { ok: false, refusal: {
      verdict: 'REFUSED', reason: 'INVALID_CALENDAR', detail: r.detail || r.reason,
      task: { type: 'DATA_HEALTH', field: 'tenantCalendar', detail: `Working-day basis could not be derived (${r.reason}); plan run refused.` },
      banner: { text: 'Plan run refused: the working-day basis could not be derived from the tenant calendar.' },
    } };
  }
  return { ok: true, wd: r.count, workingDaysOpts: { workingDays: r.count }, monthsElapsed };
}

/* ---- per-member aggregations (canon formulas, engine-owned) --------------- */

const bySkuThen = (a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);

/* Planning-unit conversion for any item-denominated quantity (stock,
 * consumption). Three honest outcomes:
 *   - usable factor (finite > 0)   → convert (canon toPlanningUnits);
 *   - no factor, no converted_unit → identity (the item unit IS the
 *     planning unit) and DISCLOSE (visible, never silent);
 *   - converted_unit declared but factor unusable → corrupt: the row cannot
 *     be converted and must not be blended — the RUN refuses
 *     (UNCONVERTIBLE_MEMBER; R3 refuse-don't-guess). */
function planUnits(qty, item, disclosures) {
  const cf = asNum(item.conversionFactor);
  if (cf !== null && cf > 0) {
    const conv = E.toPlanningUnits(qty, cf); // canon envelope: {value, valid, reason}
    if (!conv.valid) {
      return { ok: false, corrupt: true, sku: item.sku, detail: `item ${item.sku}: conversion refused (${conv.reason})` };
    }
    return { ok: true, value: conv.value };
  }
  if (item.convertedUnit) {
    return { ok: false, corrupt: true, sku: item.sku,
             detail: `item ${item.sku} declares converted unit "${item.convertedUnit}" but carries no usable conversion factor` };
  }
  disclosures.membersWithoutConversion.push(item.sku);
  const n = Number(qty);
  if (!Number.isFinite(n)) {
    return { ok: false, corrupt: true, sku: item.sku, detail: `non-numeric quantity for ${item.sku}` };
  }
  return { ok: true, value: n };
}

/* T = S × CF (converted consumption) via planUnits above. */
function memberConsumptionConverted(item, row, disclosures) {
  const S = E.reconcileConsumptionUnit({
    start: row.startBalance, goodsIn: row.goodsIn, goodsOut: row.goodsOut, end: row.endBalance,
  });
  return planUnits(S, item, disclosures);
}

/* ---- per-ref assembly ------------------------------------------------------ */

/* Inclusive calendar-month span of a window — the workbook $U$1 "histMonths"
 * analog (engine header: histMonthly = T / histMonths). Deterministic, no
 * clock: derived purely from the window edges. */
function windowMonths(window) {
  const ys = Number(window.start.slice(0, 4)); const ms = Number(window.start.slice(5, 7));
  const ye = Number(window.end.slice(0, 4));   const me = Number(window.end.slice(5, 7));
  return 12 * (ye - ys) + (me - ms) + 1;
}

function refused(reason, detail, task, banner) {
  return { ok: false, refusal: { verdict: 'REFUSED', reason, detail, ...(task ? { task } : {}), ...(banner ? { banner } : {}) } };
}

const unconvertible = (c) => refused(
  'UNCONVERTIBLE_MEMBER', c.detail,
  { type: 'DATA_HEALTH', field: 'itemConversion', detail: `${c.detail}; plan run refused (R3: refuse, don't guess).` },
  { text: 'Plan run refused: an item quantity cannot be converted to planning units. Named in the data-health task.' },
);

/* Assemble + compute ONE ref. Every engine formula stays in the engine — this
 * function only aggregates tenant rows into the canon's input shapes. */
function assembleRef(ref, ctx) {
  const { inputs, tenant, disclosures, workingDaysOpts, dpd } = ctx;
  const members = inputs.items.filter((it) => it.recipeRef === ref).sort(bySkuThen);
  const params = E.activeParams(inputs.paramsByRef[ref]);

  let onHand = 0, invValue = 0, openPO = 0;
  let masterPrice = 0, shelfLifeDays = null;
  const consumptionRows = []; // {item, row} in deterministic order

  for (const m of members) {
    for (const s of inputs.stock.filter((r) => r.sku === m.sku)) {
      const c = planUnits(s.quantity, m, disclosures);
      if (!c.ok) return unconvertible(c);
      onHand += c.value;
      const v = asNum(s.tenantValue);
      if (v === null) return refused('INVALID_STOCK_VALUE', `stock row for ${m.sku} carries a non-numeric tenant value`,
        { type: 'DATA_HEALTH', field: 'stockValue', detail: `Stock row for ${m.sku} has a non-numeric tenant value; plan run refused.` },
        { text: 'Plan run refused: a stock row carries a non-numeric value. Named in the data-health task.' });
      invValue += v;
    }
    for (const p of inputs.openPo.filter((r) => r.sku === m.sku)) {
      const w = asNum(p.waitingQtyConverted);
      if (w === null || w < 0) {
        disclosures.unconvertedOpenPo.push({ sku: p.sku, poNumber: p.poNumber });
      } else {
        openPO += w; // C1 already converted at ingestion — planning units in, planning units out
      }
    }
    const price = asNum(m.price);
    if (price !== null && price > 0 && (masterPrice === 0 || m.preferredForRecipeRef)) masterPrice = price;
    const sl = asNum(m.shelfLifeDays);
    if (sl !== null && sl > 0 && (shelfLifeDays === null || sl < shelfLifeDays)) shelfLifeDays = sl;
    for (const row of inputs.consumption.filter((r) => r.sku === m.sku)) consumptionRows.push({ item: m, row });
  }

  /* H8 — rate seeding. A ref WITH consumption must have its window covered by
   * the deliveries history, or the RUN refuses (the guard's named reasons,
   * task and banner ride through untouched). A ref with NO consumption is the
   * honest day-one case: rate 0, dataState NO_USAGE. */
  let consPerDelivery = 0, histMonthly = 0, rateInputs = null;
  if (consumptionRows.length > 0) {
    let start = null, end = null, T_total = 0;
    for (const { item, row } of consumptionRows) {
      const s = parseIsoDate(row.start); const e = parseIsoDate(row.end);
      if (!s.ok || !e.ok || e.ms < s.ms) {
        const detail = `consumption row for ${item.sku}: ${!s.ok ? s.detail || s.reason : (!e.ok ? e.detail || e.reason : 'end before start')}`;
        return refused('INVALID_CONSUMPTION_ENTRY', detail,
          { type: 'DATA_HEALTH', field: 'consumptionWindow', detail: `${detail}; plan run refused.` },
          { text: 'Plan run refused: a consumption row has invalid dates. Named in the data-health task.' });
      }
      if (start === null || s.value < start) start = s.value;
      if (end === null || e.value > end) end = e.value;
      const c = memberConsumptionConverted(item, row, disclosures);
      if (!c.ok) return unconvertible(c);
      T_total += c.value;
    }
    const window = { start, end };
    const seed = seedRateInputs(window, inputs.deliveries);
    if (!seed.ok) {
      /* H8 ride-through: the guard's named reason, exact gaps/invalid rows,
       * offending index and extent all survive into the receipt — the
       * data-health task and banner come with them, untouched. */
      return { ok: false, refusal: {
        verdict: 'REFUSED', reason: seed.reason, detail: seed.detail,
        ...(seed.gaps ? { gaps: seed.gaps } : {}),
        ...(seed.invalid ? { invalid: seed.invalid } : {}),
        ...(seed.index !== undefined ? { index: seed.index } : {}),
        ...(seed.extent ? { extent: seed.extent } : {}),
        ...(seed.task ? { task: seed.task } : {}), ...(seed.banner ? { banner: seed.banner } : {}),
      } };
    }
    consPerDelivery = E.seedConsPerDelivery(T_total, seed.histTotalDeliveries);
    histMonthly = T_total / windowMonths(window);
    rateInputs = {
      window,
      histMonths: windowMonths(window),
      consumptionConverted: T_total,
      histTotalDeliveries: seed.histTotalDeliveries,
      partialEdge: seed.partialEdge,
    };
  }

  const computed = E.computeRef(
    { onHand, openPO, invValue, histMonthly, consPerDelivery,
      masterPrice, shelfLifeDays: shelfLifeDays || 0, quarantine: 0, reserved: 0, damaged: 0 },
    params, dpd, workingDaysOpts,
  );

  return { ok: true, row: {
    ref,
    members: members.map((m) => m.sku),
    currency: tenant.currencyCode, // C2: rows are tenant-currency-normalized at ingestion
    ...(rateInputs ? { rateInputs } : {}),
    ...computed,
  } };
}

/* ==== runPlan — the wired engine run ====================================== */

async function runPlan(request, ports) {
  assertPorts(ports);
  const shape = validateRequest(request);
  if (shape) return shape;
  const { loader, saver } = ports;

  /* asOf — injected, strict UTC calendar date; the seal epoch is its midnight */
  const asOfParsed = parseIsoDate(request.asOf);
  if (!asOfParsed.ok) {
    return invalidRequest(`asOf: ${asOfParsed.detail || asOfParsed.reason}`);
  }
  const sealEpoch = asOfParsed.ms;

  /* tenant + R1 fail-closed currency */
  const tenant = await loader.loadTenant(request.tenantId);
  if (!tenant || typeof tenant !== 'object') {
    return { verdict: 'REFUSED', reason: 'MISSING_TENANT', detail: `tenant ${request.tenantId} not found` };
  }
  if (typeof tenant.currencyCode !== 'string' || tenant.currencyCode === '') {
    return refused('MISSING_TENANT_CURRENCY', 'tenant currency is mandatory (R1 fail-closed money layer)',
      { type: 'DATA_HEALTH', field: 'tenantCurrency', detail: 'Tenant has no currency configured; plan run refused (R1).' },
      { text: 'Plan run refused: the tenant currency is not configured. Named in the data-health task.' }).refusal;
  }

  /* §14.4b basis: flat/absent → engine default (byte-identical);
   * real calendar → calendar-derived wd into BOTH sides. */
  const granularity = request.driver.granularity.toLowerCase();
  const basis = resolveBasis(tenant, asOfParsed);
  if (!basis.ok) return basis.refusal;
  let workingDaysOpts = basis.workingDaysOpts;
  if (basis.realCalendar) {
    const w = workingDaysForGranularity(basis, granularity, request.driver.monthsElapsed);
    if (!w.ok) return w.refusal;
    workingDaysOpts = w.workingDaysOpts;
  }

  /* driver → deliveries/day (canon normalize; named refusals ride through) */
  const normalized = E.normalizeDeliveries(request.driver.value, granularity, {
    ...workingDaysOpts, monthsElapsed: request.driver.monthsElapsed,
  });
  if (!normalized.valid) {
    return refused('INVALID_DRIVER', `driver: ${normalized.reason}`,
      { type: 'DATA_HEALTH', field: 'deliveriesDriver', detail: `Deliveries driver refused (${normalized.reason}); plan run refused.` },
      { text: 'Plan run refused: the deliveries-per-day driver was refused. Named in the data-health task.' }).refusal;
  }
  const dpd = normalized.deliveriesPerDay;

  /* tenant inputs — sorted on arrival so the payload hash is order-stable */
  const raw = await loader.loadPlanInputs(request.tenantId);
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('runPlan: loader.loadPlanInputs must return an object');
  }
  const items = [...(raw.items || [])].sort(bySkuThen);
  const knownSkus = new Set(items.map((i) => i.sku));
  const disclosures = { unconvertedOpenPo: [], membersWithoutConversion: [], unknownSkuStock: [] };
  for (const s of raw.stock || []) {
    if (!knownSkus.has(s.sku)) disclosures.unknownSkuStock.push(s.sku);
  }
  const inputs = {
    paramsByRef: raw.paramsByRef || {},
    items,
    stock: [...(raw.stock || [])].filter((s) => knownSkus.has(s.sku)).sort(bySkuThen),
    openPo: [...(raw.openPo || [])].sort((a, b) => (a.sku === b.sku
      ? String(a.poNumber).localeCompare(String(b.poNumber)) : (a.sku < b.sku ? -1 : 1))),
    consumption: [...(raw.consumption || [])].sort((a, b) => (a.sku === b.sku
      ? (a.start < b.start ? -1 : 1) : (a.sku < b.sku ? -1 : 1))),
    deliveries: [...(raw.deliveries || [])].sort((a, b) => (a.start === b.start
      ? (a.end < b.end ? -1 : 1) : (a.start < b.start ? -1 : 1))),
  };

  /* the planned portfolio = every ref that has params OR members */
  const refNames = Array.from(new Set([
    ...Object.keys(inputs.paramsByRef),
    ...items.map((i) => i.recipeRef).filter((r) => typeof r === 'string' && r !== ''),
  ])).sort();

  const ctx = { inputs, tenant, disclosures, workingDaysOpts, dpd };
  const refRows = [];
  for (const ref of refNames) {
    const r = assembleRef(ref, ctx);
    if (!r.ok) return r.refusal;
    refRows.push(r.row);
  }

  /* portfolio + dataState-aware KPI layer (gates 4/15 evidence, served live) */
  const portfolio = E.portfolioKPIs(refRows, request.targets || {}, dpd, tenant.currencyCode);
  const kpis = KPI.fromEnginePortfolio(portfolio, { asOf: sealEpoch, lastSealedAt: sealEpoch });

  const payload = {
    asOf: asOfParsed.value,
    tenantId: request.tenantId,
    tenantCurrency: tenant.currencyCode,
    engineVersion: E.ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    driver: {
      value: normalized.inputValue, granularity: normalized.granularity,
      monthsElapsed: granularity === 'ytd' ? request.driver.monthsElapsed : undefined,
    },
    driverNormalized: {
      deliveriesPerDay: normalized.deliveriesPerDay, basis: normalized.basis,
      workingDays: normalized.workingDays, confidence: normalized.confidence,
    },
    basisNote: basis.basisNote,
    workingDays: workingDaysOpts.workingDays ?? null,
    refs: refRows,
    portfolio,
    kpis,
    disclosures: {
      unconvertedOpenPo: disclosures.unconvertedOpenPo,
      membersWithoutConversion: Array.from(new Set(disclosures.membersWithoutConversion)),
      unknownSkuStock: Array.from(new Set(disclosures.unknownSkuStock)),
    },
    counts: { refs: refRows.length, members: items.length },
  };
  const payloadHash = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');

  const saved = await saver.saveSeal({
    tenantId: request.tenantId,
    sealDate: asOfParsed.value,
    engineVersion: E.ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    payloadHash,
    payload,
    sealedBy: typeof request.actor === 'string' ? request.actor : null,
  });
  if (!saved || typeof saved !== 'object' || !saved.seal) {
    throw new TypeError('runPlan: saver.saveSeal must return {replayed, seal}');
  }

  if (saved.replayed) {
    /* H6-style replay: the tenant-day is already sealed — the stored seal is
     * returned untouched. A divergent request is DISCLOSED, never applied;
     * restating a sealed day is M8 semantics and does not exist here yet. */
    const divergent = saved.seal.payloadHash !== payloadHash;
    return {
      verdict: 'REPLAYED', sealDate: asOfParsed.value, replayed: true, divergent,
      payloadHash: saved.seal.payloadHash, requestHash: payloadHash, seal: saved.seal,
      ...(divergent ? { banner: { text: 'Replay: a seal already exists for this tenant-day; the new request diverged from it and was NOT applied (restatement is M8 semantics).' } } : {}),
    };
  }
  return {
    verdict: 'SEALED', sealDate: asOfParsed.value, replayed: false,
    payloadHash, engineVersion: E.ENGINE_VERSION, schemaVersion: SCHEMA_VERSION,
    seal: saved.seal,
  };
}

module.exports = { runPlan, invalidRequest };
