'use strict';
/* ============================================================================
 * Sentinel — closed-loop execution feedback.
 *
 * The chain of record:
 *   PROPOSAL (engine)  →  DECISION (buyer + reason code)  →  COMMITMENT (PO)
 *      →  EXECUTION (GRN receipts)  →  RECONCILIATION  →  SIGNALS to each node
 *
 * Without this module the platform is open-loop: it advises, and never learns
 * whether the advice was taken, was right, or was even needed. Every function
 * here converts an execution fact into a signal some node consumes.
 * ==========================================================================*/

const nz = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const pct = (a, b) => (nz(b) === 0 ? null : nz(a) / nz(b));
const days = (a, b) => {
  if (!a || !b) return null;
  const d = (new Date(b) - new Date(a)) / 86400000;
  return Number.isFinite(d) ? Math.round(d) : null;
};

/* Why a buyer deviated. This is the learning payload — an unexplained deviation
 * teaches nothing, so the UI must require one when qty/SKU/supplier changes. */
const REASON_CODES = [
  'PRICE_TOO_HIGH', 'SUPPLIER_MOQ', 'SHELF_LIFE', 'CASH_CONSTRAINT',
  'BULK_OPPORTUNITY', 'SUPPLIER_UNAVAILABLE', 'FORECAST_DISAGREE',
  'ORDER_CONSOLIDATION', 'STOCK_ON_WAY', 'QUALITY_HOLD', 'OTHER',
];

/* ---- 1. Reconcile one proposal against what actually happened ------------- */
/* proposal:   {refId, sku, supplier, qty, expectedUnitPrice, raisedAt}
 * commitment: {poNumber, sku, supplier, qty, unitPrice, orderedAt, expectedDelivery}
 *             (null = never acted on)
 * receipts:   [{qty, receivedAt, unitPrice}]                                   */
function reconcileProposal(proposal, commitment, receipts) {
  const p = proposal || {};
  const r = Array.isArray(receipts) ? receipts : [];
  const receivedQty = r.reduce((s, x) => s + nz(x.qty), 0);
  const lastReceipt = r.length
    ? r.slice().sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt))).pop()
    : null;

  if (!commitment) {
    const ageDays = days(p.raisedAt, p.asOf || new Date().toISOString());
    /* M2 · a proposal still inside its decision SLA is PENDING, not IGNORED.
     * Buyers are scored on this; judging them during the decision window is unfair
     * and makes actedRate meaningless. */
    const sla = p.slaDays == null ? 3 : nz(p.slaDays);
    const pending = ageDays !== null && ageDays < sla;
    return {
      outcome: pending ? 'PENDING' : 'IGNORED', adherenceQty: 0, receivedQty: 0,
      substituted: false, priceVariance: null, priceVariancePct: null,
      realizedLeadDays: null, fillRate: null, ageDays,
      flags: pending ? ['PENDING_DECISION'] : ['NO_COMMITMENT'],
    };
  }

  const flags = [];
  const substituted = !!(commitment.sku && p.sku && commitment.sku !== p.sku);
  const supplierChanged = !!(commitment.supplier && p.supplier && commitment.supplier !== p.supplier);
  if (substituted) flags.push('SKU_SUBSTITUTED');
  if (supplierChanged) flags.push('SUPPLIER_CHANGED');

  const adherenceQty = pct(commitment.qty, p.qty);            // ordered ÷ proposed
  const fillRate = pct(receivedQty, commitment.qty);          // received ÷ ordered
  const realizedLeadDays = days(commitment.orderedAt, lastReceipt && lastReceipt.receivedAt);
  const promisedLeadDays = days(commitment.orderedAt, commitment.expectedDelivery);
  const lateByDays = (realizedLeadDays !== null && promisedLeadDays !== null)
    ? realizedLeadDays - promisedLeadDays : null;

  /* H3 · quantity-WEIGHTED actual price. Using the last receipt's price
   * overstated variance by 100% on a two-partial fixture (proved by probe).
   * Food commodities routinely price partials differently.                    */
  const priced = r.filter((x) => x.unitPrice != null && nz(x.qty) > 0);
  const pricedQty = priced.reduce((s2, x) => s2 + nz(x.qty), 0);
  const actualPrice = pricedQty > 0
    ? priced.reduce((s2, x) => s2 + nz(x.qty) * nz(x.unitPrice), 0) / pricedQty
    : nz(commitment.unitPrice);
  const mixedPrice = new Set(priced.map((x) => nz(x.unitPrice))).size > 1;
  const priceVariance = p.expectedUnitPrice != null ? actualPrice - nz(p.expectedUnitPrice) : null;
  const priceVariancePct = (p.expectedUnitPrice != null && nz(p.expectedUnitPrice) !== 0)
    ? priceVariance / nz(p.expectedUnitPrice) : null;
  if (priceVariancePct !== null && priceVariancePct > 0.05) flags.push('PRICE_ABOVE_EXPECTED');
  if (mixedPrice) flags.push('MIXED_RECEIPT_PRICES');

  let outcome;
  if (substituted) outcome = 'SUBSTITUTED';
  else if (adherenceQty === null) outcome = 'MODIFIED';
  else if (adherenceQty >= 0.95 && adherenceQty <= 1.05) outcome = 'FOLLOWED';
  else if (adherenceQty > 0) outcome = 'MODIFIED';
  else outcome = 'IGNORED';

  if (receivedQty > 0 && fillRate !== null && fillRate < 0.95) flags.push('SHORT_DELIVERED');
  if (lateByDays !== null && lateByDays > 0) flags.push('LATE');
  if (!commitment.reasonCode && outcome !== 'FOLLOWED') flags.push('DEVIATION_UNEXPLAINED');

  return {
    outcome, adherenceQty, receivedQty, substituted, supplierChanged,
    priceVariance, priceVariancePct, actualPrice, mixedPrice,
    realizedLeadDays, promisedLeadDays,
    lateByDays, fillRate, flags, reasonCode: commitment.reasonCode || null,
  };
}

/* ---- 2. PLAN ← lead-time learning ---------------------------------------
 * Closes the 84%-missing-lead-time gap from observed reality rather than asking
 * 230 suppliers to fill a form. p80 is the default planning value: using the
 * median plans for the average day and stocks out on half of them.            */
function leadTimeEstimate(observations, opts) {
  const o = opts || {};
  const vals = (observations || [])
    .map((x) => (typeof x === 'number' ? x : nz(x.realizedLeadDays)))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (!vals.length) return { suggested: null, n: 0, confidence: 'none' };
  const at = (q) => vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))];
  const median = at(0.5), p80 = at(0.8);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const spread = vals[vals.length - 1] - vals[0];
  const confidence = vals.length >= 12 ? 'high' : vals.length >= 5 ? 'medium' : 'low';
  const basis = o.basis === 'median' ? median : p80;
  return { suggested: Math.ceil(basis), median, p80, mean: Math.round(mean * 10) / 10,
           spread, n: vals.length, confidence, basis: o.basis || 'p80' };
}

/* ---- 3. PLAN ← did our parameters actually work? -------------------------
 * The optimizer's training signal. Only judges refs where advice was FOLLOWED —
 * a stockout after the buyer ignored us is not a parameter failure.           */
function parameterEfficacy(history) {
  const h = history || [];
  const followed = h.filter((x) => x.outcome === 'FOLLOWED');
  const stockoutsAfterFollow = followed.filter((x) => x.stockedOutAfter).length;
  const overstockAfterFollow = followed.filter((x) => x.overstockedAfter).length;
  const signals = [];
  const MIN_SAMPLE = 12;              // M3 · was 3 — far too few to retrain the optimizer
  if (followed.length >= MIN_SAMPLE) {
    const soRate = stockoutsAfterFollow / followed.length;
    const osRate = overstockAfterFollow / followed.length;
    if (soRate > 0.2) signals.push({ param: 'safetyDays', direction: 'increase', evidence: soRate });
    if (osRate > 0.3) signals.push({ param: 'orderFreq', direction: 'decrease', evidence: osRate });
    if (osRate > 0.3 && soRate === 0) signals.push({ param: 'safetyDays', direction: 'decrease', evidence: osRate });
  }
  return { n: h.length, followed: followed.length, stockoutsAfterFollow, overstockAfterFollow,
           signals, minSample: MIN_SAMPLE,
           confidence: followed.length >= 24 ? 'high' : followed.length >= MIN_SAMPLE ? 'medium' : 'insufficient' };
}

/* ---- 4. PLAN ← was the engine even right? --------------------------------
 * Precision: of what we proposed, how much was genuinely needed.
 * Recall:    of what actually ran out, how much we had warned about.
 * MISSED shortages (a stockout we never proposed for) are the dangerous class —
 * they are invisible in an adherence-only view.                               */
function proposalQuality(proposals, stockoutEvents) {
  const props = proposals || [], stocks = stockoutEvents || [];
  const proposedRefs = new Set(props.map((p) => p.refId));
  const decided = props.filter((p) => p.outcome && p.outcome !== 'PENDING');
  const acted = decided.filter((p) => p.outcome !== 'IGNORED').length;
  const missed = stocks.filter((s) => !proposedRefs.has(s.refId));
  const warned = stocks.filter((s) => proposedRefs.has(s.refId));
  return {
    proposed: props.length, acted, decided: decided.length,
    pending: props.length - decided.length,
    actedRate: decided.length ? acted / decided.length : null,   // M2 · exclude in-window
    stockouts: stocks.length,
    missedShortages: missed.length,
    recall: stocks.length ? warned.length / stocks.length : null,
    missedRefs: missed.map((s) => s.refId),
  };
}

/* ---- 5. SRM ← supplier scorecard from execution facts -------------------- */
function supplierScorecard(lines) {
  /* H2 · only DUE lines count. Averaging nulls as zero made a supplier with one
   * perfect delivery and one not-yet-due PO read 50% fill rate (proved by probe) —
   * an actively harmful signal, since this scorecard steers sourcing.           */
  const all = (lines || []).filter(Boolean);
  const l = all.filter((x) => x.fillRate !== null && x.fillRate !== undefined
                           && x.lateByDays !== null && x.lateByDays !== undefined);
  if (!l.length) return { n: 0, dueLines: 0, openLines: all.length, otif: null, fillRate: null,
                          onTimeRate: null, inFullRate: null, avgLateDays: null,
                          leadTime: { suggested: null, n: 0, confidence: 'none' },
                          priceAdherence: null, quarantineRate: null };
  const onTime = l.filter((x) => x.lateByDays !== null && x.lateByDays <= 0).length;
  const inFull = l.filter((x) => x.fillRate !== null && x.fillRate >= 0.98).length;
  const otifBoth = l.filter((x) => x.lateByDays !== null && x.lateByDays <= 0
                                && x.fillRate !== null && x.fillRate >= 0.98).length;
  const lates = l.map((x) => x.lateByDays).filter((v) => Number.isFinite(v) && v > 0);
  const priced = l.filter((x) => x.priceVariancePct !== null);
  const quarantined = l.filter((x) => x.quarantinedQty > 0).length;
  return {
    n: l.length, dueLines: l.length, openLines: all.length - l.length,
    onTimeRate: onTime / l.length,
    inFullRate: inFull / l.length,
    otif: otifBoth / l.length,
    fillRate: l.reduce((s, x) => s + (x.fillRate === null ? 0 : x.fillRate), 0) / l.length,
    avgLateDays: lates.length ? Math.round((lates.reduce((s, v) => s + v, 0) / lates.length) * 10) / 10 : null,
    leadTime: leadTimeEstimate(l),
    priceAdherence: priced.length
      ? priced.filter((x) => x.priceVariancePct <= 0.02).length / priced.length : null,
    quarantineRate: quarantined / l.length,
  };
}

/* ---- 6. SOURCE ← savings, realized rather than claimed -------------------
 * A saving only counts once goods are received at the actual price.           */
function realizedSaving(baselines, actualUnitPrice, receivedQty) {
  const b = baselines || {}, price = nz(actualUnitPrice), qty = nz(receivedQty);
  const out = {};
  for (const k of ['previousPrice', 'budget', 'benchmark', 'bestQuote']) {
    out[k] = b[k] == null ? null : Math.round((nz(b[k]) - price) * qty * 1000) / 1000;
  }
  return { perBaseline: out, qty, actualUnitPrice: price, realized: qty > 0 };
}

/* ---- 7. INVENTORY ← the double-order guard ------------------------------
 * A committed-but-undelivered PO must suppress a repeat proposal, or every
 * daily run re-orders the same shortage until the truck arrives.              */
function inTransitPosition(commitments, receiptsByPo) {
  const map = receiptsByPo || {};
  let onOrder = 0; const lines = [];
  for (const c of commitments || []) {
    const got = (map[c.poNumber] || []).reduce((s, r) => s + nz(r.qty), 0);
    const open = Math.max(0, nz(c.qty) - got);
    if (open > 0) {
      onOrder += open;
      lines.push({ poNumber: c.poNumber, sku: c.sku, open, expectedDelivery: c.expectedDelivery });
    }
  }
  return { onOrder, lines, suppressesProposal: onOrder > 0 };
}

module.exports = {
  REASON_CODES, reconcileProposal, leadTimeEstimate, parameterEfficacy,
  proposalQuality, supplierScorecard, realizedSaving, inTransitPosition,
};
