'use strict';
/* ============================================================================
 * Sentinel planning engine — decoded verbatim from the Riyadh SUPPLY CHAIN DDS.
 * Source of truth: 'Master Data', 'MRP', 'Consumption', 'Target Inventory' sheets.
 * Model: DELIVERIES are the only raw primitive; consumption + every planning
 * figure derive from a per-SKU consumption-per-delivery RATE × deliveries/day.
 * ==========================================================================*/

const WD = 22;   // working days per month  (Master Data H2 = G2/22 ; J2 = L2/22)
const WK = 4;    // weeks per month         (Master Data K2 = L2/4)

/* L-07 · version stamp. Bumped on every engine-logic change; the plan-service
 * stamps it into every sealed snapshot (plan_seal.engine_version) so any
 * production behavior question resolves to an exact logic state (delivery
 * spec §6.2). Additive contract — golden outputs are unaffected. */
const ENGINE_VERSION = '1.0.0';

const nz = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const round = (x) => Math.round(nz(x));

/* ---- Consumption sheet: derive the per-SKU rate from history --------------
 * S = Start + In - End - Out            (physical consumption, unit)      [S3]
 * T = S * conversionFactor              (consumption, converted)          [T3]
 * histMonthly  = T / histMonths         (U3 = T/$U$1 ; $U$1 = 3)          [U3]
 * consPerDelivery (RATE) = T / histTotalDeliveries  (V3 = T/$B$1)         [V3]
 * magnifiedMonthly = rate * DPD * 22    (W3 = V3*$W$1*22 ; $W$1 = DPD)    [W3]
 * The RATE (consPerDelivery) is the stable per-SKU coefficient we persist. */
function reconcileConsumptionUnit(m) { // m: {start,goodsIn,goodsOut,end}
  return nz(m.start) + nz(m.goodsIn) - nz(m.end) - nz(m.goodsOut);           // S
}
function seedConsPerDelivery(consumptionConvertedHist, histTotalDeliveries) {  // V
  const d = nz(histTotalDeliveries);
  return d > 0 ? nz(consumptionConvertedHist) / d : 0;
}

/* ---- C1 · Purchase-unit → planning-unit conversion -----------------------
 * THE most dangerous transformation in the system. PO quantities arrive in
 * purchase units (CTN, BTL); planning works in converted units (Piece, Kg).
 * A missed conversion is an order-of-magnitude error in BOTH directions:
 * suppressed proposals (stockout believed covered) or duplicate ordering.
 * Refuses rather than guessing when the factor is absent.                     */
function toPlanningUnits(qty, conversionFactor) {
  const cf = Number(conversionFactor);
  if (!Number.isFinite(cf) || cf <= 0) {
    return { value: null, valid: false, reason: 'missing or invalid conversion factor' };
  }
  return { value: nz(qty) * cf, valid: true, conversionFactor: cf };
}
function convertPoLines(lines) {
  const out = { openPOConverted: 0, unconverted: [], lines: [] };
  for (const l of lines || []) {
    const c = toPlanningUnits(l.waiting, l.conversionFactor);
    if (!c.valid) { out.unconverted.push({ ...l, reason: c.reason }); continue; }
    out.openPOConverted += c.value;
    out.lines.push({ ...l, waitingConverted: c.value });
  }
  return out;
}

/* ---- Recipe Ref planning (Master Data columns E..Z) -----------------------
 * ref: { onHand(E), openPO(F), invValue(W), histMonthly(G),
 *        consPerDelivery(Σ member V) }
 * params: { lead(M), safetyDays(N), orderFreq(O), moq(P) }
 * driver: deliveriesPerDay (Consumption!W1 / Target Inventory!C10, "Current DPD")
 * NOTE MRP shows the "EOQ (incl. low safety)" column (Master Data Z) as its EOQ.
 */
function computeRef(ref, params, deliveriesPerDay, opts) {
  const p = params || {};
  const lead = nz(p.lead), safetyDays = nz(p.safetyDays),
        orderFreq = nz(p.orderFreq), moq = nz(p.moq);
  /* H9 · the working-month basis. Default = the workbook constant (WD) —
   * byte-identical golden path. A tenant with a real working calendar passes
   * the calendar-derived, per-period working-day count (see the calendar
   * module, deliveryBasis) as opts.workingDays; the SAME value must feed
   * normalizeDeliveries so the identical-basis cancellation (§14.4b) holds
   * per period. A bad basis is a wiring error, refused loudly — NaN would
   * silently poison every figure downstream. */
  let WDm = WD;
  if (opts && opts.workingDays !== undefined) {
    const w = Number(opts.workingDays);
    if (!Number.isInteger(w) || w <= 0) {
      throw new TypeError('computeRef: opts.workingDays must be a positive integer working-day count (per-period, calendar-derived)');
    }
    WDm = w;
  }

  const onHand = nz(ref.onHand);
  // Available = planning stock. On-hand minus stock you cannot plan against.
  // v1: only quarantine is deferred out of availability (reserved/damaged land in v1.5;
  // pass them and they net out too). 3PL is part of on-hand and stays available.
  const quarantine = nz(ref.quarantine), reserved = nz(ref.reserved), damaged = nz(ref.damaged);
  const available = onHand - quarantine - reserved - damaged;   // planning stock (D)
  const openPO = nz(ref.openPO);
  const invValue = nz(ref.invValue);
  const dpd = nz(deliveriesPerDay);

  // magnified (projected) consumption — drives safety/reorder/EOQ/max/cycle
  // H9: WDm is the per-period working-month basis (22 flat / calendar-derived)
  const consPerDelivery = nz(ref.consPerDelivery);          // Σ member V (rate)
  const monthlyMagnified = consPerDelivery * dpd * WDm;     // L  (= Σ member W)
  const dailyConsumption = monthlyMagnified / WDm;          // J  (= consPerDelivery*dpd)
  const weeklyUsage = monthlyMagnified / WK;                // K

  // historical consumption — drives ONLY run-out (MRP H2 uses Master Data H)
  const histMonthly = nz(ref.histMonthly);                  // G
  const histDaily = histMonthly / WDm;                      // H — working days of cover

  const safetyStock = round(safetyDays * dailyConsumption);            // R = N*J
  const reorder     = round((lead + safetyDays) * dailyConsumption);   // S = (M+N)*J
  const eoq         = round(Math.max(moq, orderFreq * dailyConsumption)); // T = if(P>O*J,P,O*J)
  const maxStock    = round(eoq + safetyStock);                        // U = T+R
  const cycleStock  = round(safetyStock + eoq / 2);                    // V = R+T/2

  // Planning reads AVAILABLE (Riyadh cell used on-hand; Available is the correct input).
  const runOut = histDaily > 0 ? available / histDaily : null;       // H2 (null => "NC")
  const reorderPct = reorder > 0 ? available / reorder : null;       // M2 (null => "NC")

  // M4: a ref with stock on order but none on hand would otherwise get unitValue 0,
  // zeroing target/max value exactly when the item matters most. Fall back to the
  // item-master price (already ingested) and flag the substitution.
  let unitValue = onHand > 0 ? invValue / onHand : 0;                // W/E — valuation on on-hand
  let unitValueFallback = false;
  if (onHand === 0 && nz(ref.masterPrice) > 0) { unitValue = nz(ref.masterPrice); unitValueFallback = true; }
  const targetInvValue = unitValue * cycleStock;                     // X = (W/E)*V
  const maxInvValue = unitValue * maxStock;                          // Y = (W/E)*U

  // Order qty — Master Data Z, evaluated on available: max(MOQ, avail<reorder ? EOQ+(reorder-avail) : EOQ)
  const rawOrder = available < reorder ? eoq + (reorder - available) : eoq;
  let orderQty = round(Math.max(moq, rawOrder));                    // Z

  // Shelf-life cap (fresh-food guard). If the ref is perishable, never order more than
  // shelfLifeDays of cover. MOQ still wins — if MOQ exceeds what can be consumed before
  // spoilage, we cannot fix it by ordering less, so we flag it instead.
  const shelfLifeDays = nz(ref.shelfLifeDays);                      // 0 / absent = non-perishable
  const shelfLifeCap = shelfLifeDays > 0 ? Math.floor(shelfLifeDays * dailyConsumption) : null; // R4
  let shelfLifeCapped = false, moqExceedsShelfLife = false;
  if (shelfLifeCap !== null && dailyConsumption > 0) {
    if (moq > shelfLifeCap) {
      moqExceedsShelfLife = true;                                   // unfixable by sizing → flag
    } else if (orderQty > shelfLifeCap) {
      orderQty = shelfLifeCap; shelfLifeCapped = true;
    }
  }
  // triggered recommendation = only when available below reorder
  const orderRecQty = available < reorder ? orderQty : 0;

  const status = statusOf({ available, maxStock, reorderPct, safetyStock, openPO }); // O2

  /* Data-state discriminator. The workbook's "NC" collapses two very different
   * situations into one label, because reorderPct is null when reorder is 0 — which
   * happens both when there is no consumption AND when no planning parameters exist.
   * Precoro's planning fields are empty on day one, so without this every ref would
   * read "Inactive" while actually consuming. status stays byte-compatible; the UI
   * binds to displayStatus, which uses dataState. */
  const noUsage = dailyConsumption === 0;
  const noParams = (lead + safetyDays + orderFreq) === 0;
  const noLeadTime = lead === 0 && (safetyDays + orderFreq) > 0;
  const dataState = noUsage ? 'NO_USAGE'
    : noParams ? 'NO_PARAMS'
    : noLeadTime ? 'NO_LEAD_TIME'
    : 'OK';
  const inactive = reorderPct === null;   // preserved for golden compatibility

  return {
    lead, safetyDays, orderFreq, moq,
    onHand, quarantine, reserved, damaged, available, openPO, invValue, deliveriesPerDay: dpd,
    workingDays: WDm,   // H9 · disclosed basis: 22 (flat) or calendar-derived
    consPerDelivery, monthlyMagnified, dailyConsumption, weeklyUsage,
    histMonthly, histDaily,
    safetyStock, reorder, eoq, maxStock, cycleStock,
    runOut, reorderPct, unitValue, targetInvValue, maxInvValue,
    orderQty, orderRecQty, status, inactive, unitValueFallback,
    dataState, noUsage, noParams, noLeadTime,
    shelfLifeDays, shelfLifeCap, shelfLifeCapped, moqExceedsShelfLife,
  };
}

/* ---- Inventory-status ladder — verbatim from MRP!O2, evaluated on AVAILABLE
 * (Riyadh's D was on-hand; Available is the correct planning input). 7 branches. */
function statusOf({ available, maxStock, reorderPct, safetyStock, openPO }) {
  if (available > maxStock * 1.2) return 'Over Stock';
  if (reorderPct === null) return 'OK';                 // M="NC" (no consumption)
  if (available === 0) return 'Zero Stock';
  if (available < safetyStock) return 'Below Safety';
  if (openPO > 0) return 'Follow-up with Supplier';
  if (reorderPct < 1.01) return 'Below Reorder';
  if (available > maxStock + maxStock * 0.2) return 'Over Stock';
  return 'OK';
}

/* ---- Supply-status axis (additive; ontology second axis) ------------------
 * Independent of inventory health — an item can be healthy AND have a late PO.
 * Derived from open-PO facts for the ref: {openPO, overduePO, partialPO}.
 * Order: Supplier Issue > Late PO > Partial Delivery > Follow-up > Normal.  */
function supplyStatus(po) {
  const openPO = nz(po && po.openPO), overdue = nz(po && po.overduePO),
        partial = nz(po && po.partialPO), flagged = !!(po && po.supplierIssue);
  if (flagged) return 'Supplier Issue';
  if (overdue > 0) return 'Late PO';
  if (partial > 0) return 'Partial Delivery';
  if (openPO > 0) return 'Follow-up with Supplier';
  return 'Normal';
}

/* ---- Parameter provenance resolver (ontology Parameter Engine) ------------
 * Each planning param resolves to an ACTIVE value: a manual override wins over
 * a calculated value; else calculated; else the stored manual input.
 * Returns {value, source} where source ∈ manual-override|calculated|manual.  */
function resolveParam(param) {
  const p = param || {};
  if (p.override !== undefined && p.override !== null && p.override !== '')
    return { value: nz(p.override), source: 'manual-override' };
  if (p.calculated !== undefined && p.calculated !== null && p.calculated !== '')
    return { value: nz(p.calculated), source: 'calculated' };
  return { value: nz(p.manual), source: 'manual' };
}
function activeParams(paramSet) {
  const out = {};
  for (const k of ['lead', 'safetyDays', 'orderFreq', 'moq'])
    out[k] = resolveParam(paramSet && paramSet[k]).value;
  return out;
}

/* ---- Portfolio KPIs — Target Inventory sheet ------------------------------
 * dailyCOGS         = avgRevPerDelivery * deliveriesPerDay * cogsPct
 * targetInvValue    = targetDIO * dailyCOGS                (C11, with staging)
 * withoutStaging    = withStaging * (1 - 0.21)             (C12)
 * actualDIO         = actualInvValue / dailyCOGS
 */
function portfolioKPIs(refRows, targets, deliveriesPerDay, tenantCurrency, opts) {
  /* C2 · currency. Rows must already be normalized to ONE tenant currency at
   * ingestion. If any row carries a different currency, we refuse to sum rather
   * than silently add BHD to AED (a probe proved the old behaviour did exactly
   * that). M1 · counts bind to displayStatus, not the raw ladder, so an
   * unplanned ref cannot masquerade as 'Over Stock' in the KPI strip.          */
  /* R1 · FAIL CLOSED. tenantCurrency is mandatory — an optional tripwire that the
   * caller can forget is a laminated sign on an unlocked door. When any row is in
   * another currency we WITHHOLD the money KPIs rather than returning a poisoned
   * sum: a withheld KPI with a reason is an operational event; a wrong KPI is a
   * wrong steering decision on a $50M portfolio. */
  const o = opts || {};
  if (!tenantCurrency || typeof tenantCurrency !== 'string') {
    throw new Error('portfolioKPIs: tenantCurrency is required (fail-closed money layer)');
  }
  const expected = tenantCurrency;
  const mixed = (refRows || []).filter(r => r.currency && r.currency !== expected).map(r => r.currency);
  const kpiWithheld = mixed.length > 0;
  let actualInvValue = 0, targetInvValueBottomUp = 0, maxInvValue = 0;
  const counts = {};
  let shortages = 0, active = 0, unplanned = 0;
  for (const c of refRows) {
    actualInvValue += c.invValue;
    targetInvValueBottomUp += c.targetInvValue;
    maxInvValue += c.maxInvValue;
    const shown = displayStatus(c);                       // M1
    counts[shown] = (counts[shown] || 0) + 1;
    if (c.dataState === 'NO_PARAMS' || c.dataState === 'NO_LEAD_TIME') unplanned++;
    if (c.dataState === 'OK') active++;                   // only plannable refs count
    if (shown === 'Zero Stock' || shown === 'Below Safety') shortages++;
  }
  const dpd = nz(deliveriesPerDay);
  const dailyCOGS = nz(targets.cogsPct) * nz(targets.avgRevPerDelivery) * dpd;
  const targetInvValueTopDown = nz(targets.targetDIO) * dailyCOGS;   // C11
  const targetInvValueNoStaging = targetInvValueTopDown * (1 - 0.21);// C12
  const actualDIO = dailyCOGS > 0 ? actualInvValue / dailyCOGS : 0;
  /* R2 · a portfolio with nothing plannable has NO service level. Reporting 100%
   * is the same day-one lie M1 was written to kill, entering through another door. */
  const serviceLevel = active > 0 ? 1 - shortages / active : null;
  return {
    // money KPIs are withheld (null), never poisoned, when currencies are mixed
    actualInvValue: kpiWithheld ? null : actualInvValue,
    targetInvValueBottomUp: kpiWithheld ? null : targetInvValueBottomUp,
    maxInvValue: kpiWithheld ? null : maxInvValue,
    actualDIO: kpiWithheld ? null : actualDIO,
    targetInvValueTopDown: kpiWithheld ? null : targetInvValueTopDown,
    targetInvValueNoStaging: kpiWithheld ? null : targetInvValueNoStaging,
    dailyCOGS, targetDIO: nz(targets.targetDIO), shortages, active, serviceLevel, counts,
    unplanned, unplannedShare: refRows.length ? unplanned / refRows.length : 0,
    currency: expected, kpiWithheld,
    withheldReason: kpiWithheld ? 'rows not normalized to tenant currency' : null,
    currencyMixed: kpiWithheld, mixedCurrencies: Array.from(new Set(mixed)),
    valuesTrustworthy: !kpiWithheld,
  };
}

/* ---- Preferred ordering SKU (Recipe Ref → the SKU you actually buy) -------
 * Planning happens at Recipe Ref; a PO line needs one SKU. Resolution order:
 *   1. category-owner pinned preferredSku (manual, wins)
 *   2. highest purchase weight in the trailing window (qty × frequency), active only
 *   3. most recently purchased active SKU
 *   4. null → surfaces as "needs a preferred SKU" data-health item
 * Supplier follows the chosen SKU's primary supplier by the same trailing evidence.  */
function resolveOrderingSku(members, opts) {
  const o = opts || {};
  const active = (members || []).filter(m => m && m.active !== false);
  if (!active.length) return { sku: null, supplier: null, source: 'none' };
  const pinned = active.find(m => m.sku === o.preferredSku);
  if (pinned) return { sku: pinned.sku, supplier: pinned.primarySupplier || null, source: 'pinned' };
  /* H1 · weight on PLANNING units, not purchase units. Weighting raw quantities
   * lets a 500-piece single order beat 30 cartons of 100 (3,000 pieces) purely
   * because of denomination — the same unit distortion, now steering what we buy. */
  let cfMissing = false;
  const scored = active
    .map(m => {
      const cf = Number(m.conversionFactor);
      const usable = Number.isFinite(cf) && cf > 0;
      if (!usable) cfMissing = true;
      const qty = nz(m.purchasedQty) * (usable ? cf : 1);
      return { m, w: qty * (1 + nz(m.purchaseCount)), normalized: usable };
    })
    .sort((a, b) => b.w - a.w);
  /* R3 · one failure philosophy for unit errors: REFUSE, don't guess. If any
   * member lacks a usable factor we must not rank mixed denominations — that
   * re-creates the exact bias H1 fixed, and the winner steers real POs. */
  if (scored[0] && scored[0].w > 0 && !cfMissing)
    return { sku: scored[0].m.sku, supplier: scored[0].m.primarySupplier || null,
             source: 'history', unitNormalized: true, warning: null };
  const recent = active
    .filter(m => m.lastPurchasedAt)
    .sort((a, b) => String(b.lastPurchasedAt).localeCompare(String(a.lastPurchasedAt)))[0];
  if (recent) return { sku: recent.sku, supplier: recent.primarySupplier || null, source: 'recent',
                       unitNormalized: !cfMissing,
                       warning: cfMissing ? 'conversion factor missing — ranked by recency, backfill required' : null,
                       dataHealth: cfMissing ? 'MISSING_CONVERSION_FACTOR' : null };
  return { sku: null, supplier: null, source: 'unresolved',
           dataHealth: cfMissing ? 'MISSING_CONVERSION_FACTOR' : null };
}

/* ---- Deliveries input normalization (source: deliveries dashboard) ---------
 * Deliveries may be entered at any granularity. Everything normalizes to the
 * SAME basis the magnification uses (WD = 22), so the conversion cancels:
 *     magnifiedMonthly = rate × DPD × 22
 *     with monthly input:  DPD = monthly / 22  ⇒  magnified = rate × monthly  ✓
 * Weekly therefore divides by WD/4 = 5.5, quarterly by WD×3, YTD by WD×months.
 * The 22 is a convention, not a calendar claim — correctness comes from using
 * the identical basis on both sides, which is what makes the result exact.     */
const DELIVERY_BASIS = { daily: 1, weekly: WD / 4, monthly: WD, quarterly: WD * 3 };
function normalizeDeliveries(value, granularity, opts) {
  const o = opts || {};
  const v = nz(value);
  const g = String(granularity || 'daily').toLowerCase();
  /* H9 · the basis defaults to the workbook constant (WD = 22) — byte-identical
   * golden path. A tenant with a real working calendar passes the calendar-
   * derived per-period working-day count (calendar module deliveryBasis) as
   * opts.workingDays; the SAME value must feed computeRef for the period, so
   * the identical-basis cancellation stays exact (§14.4b). Invalid basis is
   * REFUSED, never silently defaulted — a wrong divisor mis-states demand. */
  let WDm = WD;
  if (o.workingDays !== undefined) {
    const w = Number(o.workingDays);
    if (!Number.isInteger(w) || w <= 0) {
      return { deliveriesPerDay: 0, basis: null, granularity: g, valid: false,
               reason: 'invalid workingDays (must be a positive integer working-day count)' };
    }
    WDm = w;
  }
  let divisor;
  if (g === 'ytd') {
    const m = nz(o.monthsElapsed);
    if (m <= 0) return { deliveriesPerDay: 0, basis: null, granularity: g, valid: false,
                         reason: 'ytd requires monthsElapsed' };
    divisor = WDm * m;
  } else if (DELIVERY_BASIS[g] !== undefined) {
    divisor = g === 'daily' ? 1 : (g === 'weekly' ? WDm / 4 : (g === 'monthly' ? WDm : WDm * 3));
  } else {
    return { deliveriesPerDay: 0, basis: null, granularity: g, valid: false,
             reason: 'unknown granularity' };
  }
  if (v < 0) return { deliveriesPerDay: 0, basis: divisor, granularity: g, valid: false,
                      reason: 'negative deliveries' };
  return {
    deliveriesPerDay: v / divisor,
    basis: divisor, granularity: g, inputValue: v, valid: true,
    workingDays: g === 'daily' ? null : WDm,   // H9 · disclosed basis (null = none used)
    // coarser input = lower confidence: it smooths away the day-to-day signal
    confidence: g === 'daily' ? 'high' : (g === 'weekly' ? 'medium' : 'low'),
  };
}

/* ---- Seasonality / TSRC overlay ------------------------------------------
 * Demand adjustment enters ONLY as a multiplier on projected deliveries-per-day.
 * The engine formulas are untouched, so the verified baseline cannot drift:
 *   effectiveDPD = baseDPD × trend × seasonal × cyclical   (residual is not applied)
 * Multipliers default to 1.0 (no-op) — an unconfigured system behaves exactly as before. */
function effectiveDeliveriesPerDay(baseDPD, factors) {
  const f = factors || {};
  const one = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : 1; };
  return nz(baseDPD) * one(f.trend) * one(f.seasonal) * one(f.cyclical);
}

/* ---- Display status — the ONLY status the UI should render ----------------
 * Workbook returns literal "OK" for no-consumption items; per decision §2.2 we
 * surface those as "Inactive". Every screen binds to this, never to raw status. */
function displayStatus(c) {
  if (!c) return null;
  if (c.dataState === 'NO_USAGE') return 'Inactive';       // genuinely dormant
  if (c.dataState === 'NO_PARAMS') return 'Not Planned';   // consuming, but unplannable
  if (c.dataState === 'NO_LEAD_TIME') return 'No Lead Time';
  return c.status;
}

module.exports = {
  WD, WK, nz, round, ENGINE_VERSION,
  reconcileConsumptionUnit, seedConsPerDelivery,
  computeRef, statusOf, supplyStatus, resolveParam, activeParams,
  resolveOrderingSku, effectiveDeliveriesPerDay, normalizeDeliveries, DELIVERY_BASIS,
  toPlanningUnits, convertPoLines,
  portfolioKPIs, displayStatus,
};
