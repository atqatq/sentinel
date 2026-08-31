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
/* H4 · canonical day-unit math. The old `(new Date(b) - new Date(a)) / 86400000`
 * parsed through the RUNTIME's local zone: date-only strings read as UTC
 * midnight but naive datetimes read as local time, so the same data on a UTC
 * server and a UTC+3 server yielded different lead times, and a 12-hour gap
 * rounded across the half-day boundary (L-14). Now: day UNITS on canonical
 * values — date-only strings parse strictly (UTC), zone-carrying instants
 * count on the UTC calendar date they fall on (deterministic, storage-
 * canonical), and a naive datetime (no zone) returns null — the boundary
 * (calendar module, toCanonicalDate) converts with the explicit tenant
 * timezone; arriving here naive is a contract violation, never re-guessed. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const canonDay = (raw) => {
  if (typeof raw === 'string' && DATE_RE.test(raw)) {
    const ms = Date.UTC(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10)));
    return new Date(ms).toISOString().slice(0, 10) === raw ? Math.floor(ms / DAY_MS) : null;
  }
  if (typeof raw === 'string' && /T\d{2}:\d{2}.*?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const ms = Date.parse(raw);            // zone explicit — deterministic
    return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
  }
  return null;                             // naive datetime / junk: refuse (H4)
};
const days = (a, b) => {
  if (!a || !b) return null;
  const da = canonDay(a), db = canonDay(b);
  return da === null || db === null ? null : db - da;
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

/* ---- 5b. SRM ← the loop's second turn: scorecards fed by matching (§14.6d) -
 * The wiring the audit's M4 scorecards item names: `supplierScorecard()` (the
 * M2 H2 canon, UNCHANGED above) composed over a `matchPoLines` RESULT.
 * Attribution follows the DELIVERY — the line's actual supplier — never the
 * proposal's intent (SUPPLIER_CHANGED stays the deviation disclosure where it
 * happened). An UNSOLICITED line's own line-fact reconciliation is evidence
 * too; a CANCELLED line never is (void fill, void lateness — it falls out of
 * the H2 denominators by the engine's own filter and is DISCLOSED here). A
 * line naming no supplier lands in `unattributed` — evidence is never dropped
 * onto a guess, never silently discarded. One canon: this function composes
 * `supplierScorecard`, it never re-implements a denominator. */
function supplierScorecards(matched) {
  const m = matched || {};
  const refuse = (code, detail) => {
    throw new TypeError(`supplierScorecards: ${code} — ${detail}`);
  };
  if (!Array.isArray(m.lines)) refuse('WIRING_MALFORMED', 'the matchPoLines result carries a lines array — feed the wiring the matching layer, not raw evidence');
  const bySupplier = new Map();   // supplier → { evidence: [], flags: {} }
  let unattributed = 0;
  for (const line of m.lines) {
    if (!line || !Array.isArray(line.reconciliations)) {
      refuse('WIRING_MALFORMED', 'every line result carries its reconciliations array — feed the wiring the matching layer, not raw evidence');
    }
    const ev = line.reconciliations;
    if (line.supplier == null || line.supplier === '') { unattributed += ev.length; continue; }
    let bucket = bySupplier.get(line.supplier);
    if (!bucket) { bucket = { evidence: [], flags: {} }; bySupplier.set(line.supplier, bucket); }
    bucket.evidence.push(...ev);
    /* the flag rollup counts LINES carrying the flag — on the line result
     * (line-level facts: PO_CANCELLED, RECEIPTS_AFTER_CANCEL, GOODS_RETURNED,
     * OVER_RECEIVED, WAITING_INCONSISTENT, AMENDED…) or on its evidence
     * (reconciliation flags) — a flag present at both levels is one line's
     * fact, counted once. */
    const seen = new Set([...(line.flags || []), ...ev.flatMap((x) => (x && x.flags) || [])]);
    for (const f of seen) bucket.flags[f] = (bucket.flags[f] || 0) + 1;
  }
  const suppliers = Array.from(bySupplier.keys()).sort();   // code-unit order — deterministic
  return {
    suppliers: suppliers.map((name) => {
      const { evidence: ev, flags: flagCounts } = bySupplier.get(name);
      const card = supplierScorecard(ev);
      const unsolicited = ev.filter((x) => x && x.outcome === 'UNSOLICITED').length;
      const cancelled = ev.filter((x) => x && x.outcome === 'CANCELLED').length;
      return { supplier: name, ...card, unsolicitedLines: unsolicited, cancelledLines: cancelled, flagCounts };
    }),
    unattributedLines: unattributed,
  };
}

/* ---- 5c. PLAN ← the loop's learning turn: efficacy fed by matching (§14.6e)
 * The wiring the audit's M3 efficacy item names: `parameterEfficacy()`,
 * `proposalQuality()` and `leadTimeEstimate()` (the M3/M2/lead-time canons,
 * UNCHANGED above) composed over a `matchPoLines` RESULT. The proposal is the
 * unit of judgment — a split commitment is ONE decision, never manufactured
 * sample size. The join is inventory's, not matching's: post-decision
 * observations ({refId, stockedOutAfter, overstockedAfter}, strict booleans —
 * a truthy-coerced string is the nz() disease inside a training signal) ride
 * in from the caller; a missing observation is UNOBSERVED, disclosed, never
 * silently clean. A CANCELLED proposal is disclosed by the engine's own
 * filter; an UNSOLICITED delivery is not the engine's advice and never enters
 * proposal-level efficacy; recall rides the same join (unknown-ref stockouts
 * are the missedShortages dangerous class). One canon: this function composes
 * the engines, it never re-implements a denominator or a floor. */
function efficacySignals(matched, observations) {
  const m = matched || {};
  const refuse = (code, detail) => {
    throw new TypeError(`efficacySignals: ${code} — ${detail}`);
  };
  if (!Array.isArray(m.proposals)) {
    refuse('WIRING_MALFORMED', 'the matchPoLines result carries a proposals array — feed the wiring the matching layer, not raw evidence');
  }
  const obs = observations == null ? [] : observations;
  if (!Array.isArray(obs)) {
    refuse('OBSERVATIONS_MALFORMED', 'observations ride an array of {refId, stockedOutAfter, overstockedAfter}');
  }
  const byRef = new Map();
  for (const o of obs) {
    if (!o || typeof o.refId !== 'string' || !o.refId) {
      refuse('OBSERVATION_MALFORMED', 'every observation names the proposal it observed (refId)');
    }
    if (o.stockedOutAfter !== undefined && typeof o.stockedOutAfter !== 'boolean') {
      refuse('OBSERVATION_MALFORMED', `observation ${o.refId} stockedOutAfter must be a boolean when present — a truthy-coerced string is the nz() disease`);
    }
    if (o.overstockedAfter !== undefined && typeof o.overstockedAfter !== 'boolean') {
      refuse('OBSERVATION_MALFORMED', `observation ${o.refId} overstockedAfter must be a boolean when present`);
    }
    if (byRef.has(o.refId)) {
      refuse('OBSERVATION_DUPLICATE', `two observations name ${o.refId} — one ref, one post-decision outcome; the ambiguity refuses, it is not averaged away`);
    }
    byRef.set(o.refId, o);
  }
  for (const a of m.proposals) {
    if (!a || typeof a.refId !== 'string' || !a.refId || typeof a.outcome !== 'string') {
      refuse('WIRING_MALFORMED', 'every proposal aggregate carries a refId and an outcome — feed the wiring the matching layer, not raw evidence');
    }
  }
  /* one proposal, one history entry — sorted by refId, deterministic */
  const ordered = m.proposals.slice()
    .sort((a, b) => (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0));
  const history = ordered.map((a) => {
    const o = byRef.get(a.refId) || {};
    return { refId: a.refId, outcome: a.outcome,
             stockedOutAfter: o.stockedOutAfter === true,
             overstockedAfter: o.overstockedAfter === true };
  });
  const observed = history.filter((h) => byRef.has(h.refId)).length;
  /* recall rides the same join — stockouts only, never reclassified; sorted
   * so missedRefs is deterministic */
  const stockouts = obs.filter((o) => o.stockedOutAfter === true)
    .map((o) => ({ refId: o.refId }))
    .sort((a, b) => (a.refId < b.refId ? -1 : 1));
  const props = ordered.map((a) => ({ refId: a.refId, outcome: a.outcome }));
  const flagCounts = {};
  for (const a of ordered) {
    for (const f of a.flags || []) flagCounts[f] = (flagCounts[f] || 0) + 1;
  }
  const knownRefs = new Set(ordered.map((a) => a.refId));
  return {
    efficacy: parameterEfficacy(history),          // M3 canon, unchanged
    quality: proposalQuality(props, stockouts),    // M2 canon, unchanged
    leadTime: leadTimeEstimate(ordered),           // lead-time canon, unchanged
    observed,
    unobserved: history.length - observed,
    unmatchedObservations: obs.filter((o) => o && o.refId && !knownRefs.has(o.refId)).length,
    cancelledProposals: ordered.filter((a) => a.outcome === 'CANCELLED').length,
    flagCounts,
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
  proposalQuality, supplierScorecard, supplierScorecards, efficacySignals,
  realizedSaving, inTransitPosition,
};
