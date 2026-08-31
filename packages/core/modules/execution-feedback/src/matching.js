'use strict';
/* ============================================================================
 * Sentinel — receipt→PO-line matching (the M6 normative layer, §14.6b).
 *
 * The audit's finding M6 [S]: "reconcileProposal receives `receipts` as given.
 * Real matching involves PO amendments, split GRNs, merged POs, over-receipt
 * tolerance, returns/credits, and cancellations (R5 supplies `Purchase Order
 * Status` including cancelled, which the feedback module never handles)."
 * Gate 16 closes when the rules are normative AND implemented: this module is
 * the implementation; build spec §14.6b is the contract it obeys. The named
 * acceptance proof is `feedback/matching`, covering split, amended, cancelled
 * and returned lines.
 *
 * Home rules (ADR-0001): pure — no I/O, no clock, no db; every fact enters as
 * a parameter; identical inputs produce deep-equal output. The matching layer
 * receives FACTS and never invents them. `reconcileProposal` (feedback.js)
 * remains the per-line leaf this layer composes — one matching brain, one
 * reconciliation canon, no forked formulas.
 *
 * Line identity is (poNumber, sku) — the same business identity the ingestion
 * layer keys and the schema uniques. Proposals link to lines through the
 * closed task's PO number(s). Cancellation leaves the loop; amendments ride
 * the deviation discipline; returns are facts, never averaged away; merges
 * allocate FIFO by raisedAt, disclosed — a silently averaged merge would
 * poison every downstream score.
 * ==========================================================================*/

const F = require('./feedback.js');

const STATUSES = ['OPEN', 'CANCELLED', 'CLOSED'];
const EVENT_TYPES = ['receipt', 'return'];
const EPS = 1e-9;

/* ---- refusal family (fail-closed: a wiring error is loud, never guessed) -- */
function refuse(code, detail) {
  throw new TypeError(`matchPoLines: ${code} — ${detail}`);
}
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

function validate(input) {
  const { proposals, poLines, events, amendments } = input;
  for (const p of proposals) {
    if (!p || typeof p.refId !== 'string' || !p.refId) refuse('PROPOSAL_MALFORMED', 'every proposal carries a refId');
    if (!finite(p.qty) || p.qty < 0) refuse('PROPOSAL_QTY_INVALID', `proposal ${p.refId} qty must be a finite number >= 0`);
    if (!Array.isArray(p.poNumbers)) refuse('PROPOSAL_MALFORMED', `proposal ${p.refId} carries a poNumbers array (the closed task's PO number(s))`);
  }
  const keys = new Set();
  for (const l of poLines) {
    if (!l || typeof l.poNumber !== 'string' || !l.poNumber || typeof l.sku !== 'string' || !l.sku) {
      refuse('PO_LINE_MALFORMED', 'every PO line carries poNumber and sku — the line identity');
    }
    if (!finite(l.ordered) || l.ordered < 0) refuse('PO_LINE_QTY_INVALID', `line ${l.poNumber}/${l.sku} ordered must be a finite number >= 0`);
    if (!finite(l.waiting) || l.waiting < 0) refuse('PO_LINE_QTY_INVALID', `line ${l.poNumber}/${l.sku} waiting must be a finite number >= 0`);
    if (l.received != null && (!finite(l.received) || l.received < 0)) refuse('PO_LINE_QTY_INVALID', `line ${l.poNumber}/${l.sku} received must be a finite number >= 0 when present`);
    if (l.status != null && !STATUSES.includes(l.status)) {
      refuse('PO_LINE_STATUS_UNKNOWN', `line ${l.poNumber}/${l.sku} status ${JSON.stringify(l.status)} is not one of ${STATUSES.join(' | ')}`);
    }
    const key = `${l.poNumber}\u0000${l.sku}`;
    if (keys.has(key)) refuse('PO_LINE_DUPLICATE', `line ${l.poNumber}/${l.sku} appears twice — the identity must stay unique`);
    keys.add(key);
  }
  for (const e of events) {
    if (!e || !EVENT_TYPES.includes(e.type)) refuse('EVENT_TYPE_UNKNOWN', `event type must be one of ${EVENT_TYPES.join(' | ')}`);
    if (typeof e.poNumber !== 'string' || typeof e.sku !== 'string') refuse('EVENT_MALFORMED', 'every event carries poNumber and sku');
    if (!finite(e.qty) || e.qty <= 0) refuse('EVENT_QTY_INVALID', `${e.type} on ${e.poNumber}/${e.sku} must carry a finite qty > 0 (a return is a typed event, not a negative quantity)`);
    if (!keys.has(`${e.poNumber}\u0000${e.sku}`)) refuse('EVENT_UNKNOWN_LINE', `${e.type} on ${e.poNumber}/${e.sku} — the caller's facts view and its events disagree; presenting consistent facts is the caller's contract`);
  }
  for (const a of amendments) {
    if (!a || a.field !== 'ordered') refuse('AMENDMENT_FIELD_UNSUPPORTED', `only the ordered quantity is amendable in this contract (got ${JSON.stringify(a && a.field)})`);
    if (typeof a.poNumber !== 'string' || typeof a.sku !== 'string') refuse('AMENDMENT_MALFORMED', 'every amendment carries poNumber and sku');
    if (!finite(a.from) || !finite(a.to) || a.from < 0 || a.to < 0) refuse('AMENDMENT_QTY_INVALID', `amendment on ${a.poNumber}/${a.sku} from/to must be finite numbers >= 0`);
    if (!keys.has(`${a.poNumber}\u0000${a.sku}`)) refuse('AMENDMENT_UNKNOWN_LINE', `amendment references ${a.poNumber}/${a.sku} which the facts view does not carry`);
  }
}

/* FIFO allocation of a merged line's quantities to its proposals, in
 * raisedAt order (ties by refId — reproducible). Returns per-proposal slices
 * of ordered and of the given event list. The allocation is DISCLOSED. */
function allocate(line, props, events) {
  const order = props.slice().sort((a, b) => {
    const d = String(a.raisedAt).localeCompare(String(b.raisedAt));
    return d !== 0 ? d : String(a.refId).localeCompare(String(b.refId));
  });
  const sortedEvents = events.slice().sort((a, b) => {
    const d = String(a.at).localeCompare(String(b.at));
    return d !== 0 ? d : EVENT_TYPES.indexOf(a.type) - EVENT_TYPES.indexOf(b.type);
  });
  const slices = order.map((p) => ({ proposal: p, ordered: 0, events: [] }));
  let remainingOrdered = line.ordered;
  let ei = 0;
  for (const s of slices) {
    const take = Math.max(0, Math.min(remainingOrdered, s.proposal.qty == null ? remainingOrdered : s.proposal.qty));
    s.ordered = take;
    remainingOrdered -= take;
    while (ei < sortedEvents.length && s.ordered + s.events.reduce((t, x) => t + x.qty, 0) < take + EPS) {
      s.events.push(sortedEvents[ei]); ei += 1;
    }
  }
  /* any events beyond the allocated ordered stay with the LAST slice — the
   * facts belong to the line; the allocation discloses where they landed. */
  while (ei < sortedEvents.length) { slices[slices.length - 1].events.push(sortedEvents[ei]); ei += 1; }
  return { slices, disclosed: 'fifo-by-raisedAt' };
}

function matchPoLines(input) {
  const { proposals = [], poLines = [], events = [], amendments = [] } = input || {};
  validate({ proposals, poLines, events, amendments });

  /* group events by line */
  const eventsByLine = new Map();
  for (const e of events) {
    const k = `${e.poNumber}\u0000${e.sku}`;
    if (!eventsByLine.has(k)) eventsByLine.set(k, []);
    eventsByLine.get(k).push(e);
  }

  /* apply amendments: latest amendedAt wins; the deviation discipline extends */
  const amendedOrdered = new Map();   // key → amended qty
  const amendmentFlags = new Map();   // key → flags from amendments
  for (const a of amendments) {
    const k = `${a.poNumber}\u0000${a.sku}`;
    const prev = amendedOrdered.get(k);
    if (prev && String(prev.amendedAt).localeCompare(String(a.amendedAt)) >= 0) continue;
    amendedOrdered.set(k, a);
  }
  for (const [k, a] of amendedOrdered) {
    const flags = ['AMENDED'];
    if (!a.reasonCode) flags.push('AMENDMENT_UNEXPLAINED');
    amendmentFlags.set(k, flags);
  }

  /* link lines to proposals via the closed task's PO numbers */
  const byPo = new Map();
  for (const p of proposals) {
    for (const po of p.poNumbers) {
      if (!byPo.has(po)) byPo.set(po, []);
      byPo.get(po).push(p);
    }
  }

  const perLine = [];
  const perProposal = new Map();      // refId → aggregate being built
  const allocations = [];
  const unlinkedLines = [];
  for (const p of proposals) {
    perProposal.set(p.refId, {
      refId: p.refId, outcome: null, flags: new Set(),
      orderedTotal: 0, netReceivedTotal: 0, pricedQty: 0, priceSum: 0,
      maxLateByDays: null, leadStart: null, leadEnd: null,
      liveLines: 0, cancelledLines: 0, substituted: false, unexplained: false,
      poNumbers: new Set(),
    });
  }

  for (const line of poLines) {
    const k = `${line.poNumber}\u0000${line.sku}`;
    const linked = byPo.get(line.poNumber) || [];
    const status = line.status || 'OPEN';
    const cancelled = status === 'CANCELLED';
    const orderedAmended = cancelled ? line.ordered : (amendedOrdered.has(k) ? amendedOrdered.get(k).to : line.ordered);
    const lineEvents = eventsByLine.get(k) || [];
    const receipts = lineEvents.filter((e) => e.type === 'receipt');
    const returns = lineEvents.filter((e) => e.type === 'return');
    const receivedQty = receipts.reduce((s, e) => s + e.qty, 0);
    const returnedQty = returns.reduce((s, e) => s + e.qty, 0);
    const netReceived = receivedQty - returnedQty;

    const lflags = new Set(amendmentFlags.get(k) || []);
    if (cancelled) {
      lflags.add('PO_CANCELLED');
      if (receipts.length > 0) lflags.add('RECEIPTS_AFTER_CANCEL');
    } else {
      if (receivedQty > orderedAmended * 1.05 + EPS) lflags.add('OVER_RECEIVED');
      if (returnedQty > 0) lflags.add('GOODS_RETURNED');
      /* waiting rides the export's own arithmetic — ordered − received (gross;
       * returns are credit facts outside the Open-POs export) */
      const expectedWaiting = orderedAmended - receivedQty;
      if (Math.abs(line.waiting - expectedWaiting) > Math.max(orderedAmended * 0.005, EPS)) {
        lflags.add('WAITING_INCONSISTENT');
      }
    }

    /* the in-transit guard's quantity: GROSS received — what is still expected
     * to arrive; released when cancelled — the truck is not coming */
    const openQty = cancelled ? 0 : Math.max(0, orderedAmended - receivedQty);

    const lineResult = {
      poNumber: line.poNumber, sku: line.sku, status,
      /* §14.6d — attribution rides the line: the scorecard's second turn
       * measures WHO DELIVERED (the export's Supplier column), never who was
       * intended (the leaf's SUPPLIER_CHANGED flag discloses that deviation). */
      supplier: line.supplierName != null ? line.supplierName : null,
      orderedAmended, receivedQty, returnedQty, netReceived, openQty,
      fillRate: orderedAmended > 0 ? netReceived / orderedAmended : null,
      flags: lflags, refIds: linked.map((p) => p.refId),
      reconciliations: [],
    };

    if (!linked.length) {
      lineResult.outcome = 'UNSOLICITED';
      lineResult.flags = Array.from(lflags).sort();
      /* §14.6d — an unsolicited line is EVIDENCE too: a real delivery from a
       * real supplier. Its own line-fact reconciliation (no proposal exists to
       * adhere to — adherenceQty null; price variance null, no expected price
       * exists), the same fill and lateness arithmetic the linked path uses —
       * one canon, no forked formula. */
      const lastReceipt = receipts.length
        ? receipts.slice().sort((a, b) => String(a.at).localeCompare(String(b.at))).pop()
        : null;
      const realizedLead = daysBetween(line.poCreationDate, lastReceipt && lastReceipt.at);
      const promisedLead = daysBetween(line.poCreationDate, line.expectedDelivery);
      lineResult.reconciliations = [{
        poNumber: line.poNumber, sku: line.sku, outcome: 'UNSOLICITED',
        adherenceQty: null,
        fillRate: orderedAmended > 0 ? netReceived / orderedAmended : null,
        receivedQty: netReceived,
        realizedLeadDays: realizedLead, promisedLeadDays: promisedLead,
        lateByDays: realizedLead !== null && promisedLead !== null ? realizedLead - promisedLead : null,
        priceVariance: null, priceVariancePct: null,
        flags: ['UNSOLICITED'],
      }];
      /* the derived flags the leaf itself would raise — one canon, no forked
       * derivation (the §14.6b net-fill re-sync: SHORT against NET, no guard) */
      const uRec = lineResult.reconciliations[0];
      if (uRec.fillRate !== null && uRec.fillRate < 0.95) uRec.flags.push('SHORT_DELIVERED');
      if (uRec.lateByDays !== null && uRec.lateByDays > 0) uRec.flags.push('LATE');
      perLine.push(lineResult);
      unlinkedLines.push({ poNumber: line.poNumber, sku: line.sku, status, ordered: orderedAmended, receivedQty, supplier: line.supplierName != null ? line.supplierName : null });
      continue;
    }

    let slices, basis;
    if (linked.length === 1) {
      slices = [{ proposal: linked[0], ordered: orderedAmended, events: lineEvents }];
      basis = 'single-proposal';
    } else {
      const alloc = allocate({ ...line, ordered: orderedAmended }, linked, lineEvents);
      slices = alloc.slices;
      basis = alloc.disclosed;
    }

    for (const s of slices) {
      const p = s.proposal;
      const agg = perProposal.get(p.refId);
      const sliceEvents = s.events || [];
      const sliceReceipts = sliceEvents.filter((e) => e.type === 'receipt');
      const sliceReturns = sliceEvents.filter((e) => e.type === 'return');
      const sliceReceived = sliceReceipts.reduce((t, e) => t + e.qty, 0);
      const sliceReturned = sliceReturns.reduce((t, e) => t + e.qty, 0);
      const sliceNet = sliceReceived - sliceReturned;

      if (cancelled) {
        agg.cancelledLines += 1;
        const rec = {
          poNumber: line.poNumber, sku: line.sku, outcome: 'CANCELLED',
          adherenceQty: null, fillRate: sliceNet >= 0 && orderedAmended > 0 ? sliceNet / orderedAmended : null,
          receivedQty: sliceNet, realizedLeadDays: null, promisedLeadDays: null, lateByDays: null,
          priceVariance: null, priceVariancePct: null, flags: ['PO_CANCELLED'],
        };
        lineResult.reconciliations.push(rec);
        allocations.push({ poNumber: line.poNumber, sku: line.sku, refId: p.refId, basis,
          allocatedOrdered: s.ordered, allocatedReceived: sliceNet, cancelled: true });
        continue;
      }

      agg.liveLines += 1;
      agg.poNumbers.add(line.poNumber);
      agg.orderedTotal += s.ordered;
      agg.netReceivedTotal += sliceNet;
      if (agg.leadStart == null || (line.poCreationDate && String(line.poCreationDate).localeCompare(String(agg.leadStart)) < 0)) {
        if (line.poCreationDate) agg.leadStart = line.poCreationDate;
      }
      for (const e of sliceReceipts) {
        if (agg.leadEnd == null || String(e.at).localeCompare(String(agg.leadEnd)) > 0) agg.leadEnd = e.at;
      }

      const commitment = {
        poNumber: line.poNumber, sku: line.sku, supplier: line.supplierName,
        qty: s.ordered, unitPrice: line.unitPrice != null ? line.unitPrice : null,
        orderedAt: line.poCreationDate || null, expectedDelivery: line.expectedDelivery || null,
      };
      const rec = F.reconcileProposal(p, commitment, sliceReceipts.map((e) => ({ qty: e.qty, receivedAt: e.at, unitPrice: e.unitPrice })));
      /* returns are facts the leaf does not know — fill recomputes net, and the
       * derived flags re-sync against the NET fill (§14.6b: a fully returned
       * line is SHORT_DELIVERED with GOODS_RETURNED — no received>0 guard) */
      rec.receivedQty = sliceNet;
      rec.fillRate = s.ordered > 0 ? sliceNet / s.ordered : null;
      if (sliceReturned > 0) rec.flags.push('GOODS_RETURNED');
      const netShort = rec.fillRate !== null && rec.fillRate < 0.95;
      const hadShort = rec.flags.includes('SHORT_DELIVERED');
      if (netShort && !hadShort) rec.flags.push('SHORT_DELIVERED');
      if (!netShort && hadShort) rec.flags = rec.flags.filter((f) => f !== 'SHORT_DELIVERED');
      /* the honesty rule: no price fact anywhere → variance is null, never a
       * fabricated zero-variance (the known Open-POs export gap) */
      const hasPriceFact = line.unitPrice != null || sliceReceipts.some((e) => e.unitPrice != null);
      if (!hasPriceFact) { rec.priceVariance = null; rec.priceVariancePct = null; rec.actualPrice = null; }
      if (rec.flags.includes('SKU_SUBSTITUTED')) agg.substituted = true;
      if (rec.flags.includes('DEVIATION_UNEXPLAINED')) agg.unexplained = true;
      if (rec.lateByDays != null && (agg.maxLateByDays == null || rec.lateByDays > agg.maxLateByDays)) {
        agg.maxLateByDays = rec.lateByDays;
      }
      if (rec.actualPrice != null && sliceNet > 0) {
        agg.pricedQty += sliceNet;
        agg.priceSum += rec.actualPrice * sliceNet;
      }
      for (const f of rec.flags) if (f !== 'PO_CANCELLED') agg.flags.add(f);
      lineResult.reconciliations.push(rec);
      allocations.push({ poNumber: line.poNumber, sku: line.sku, refId: p.refId, basis,
        allocatedOrdered: s.ordered, allocatedReceived: sliceNet, cancelled: false });
    }

    lineResult.flags = Array.from(lflags).sort();
    perLine.push(lineResult);
  }

  /* aggregates — the §14.6 shape, fed unchanged to every downstream node */
  const aggregates = [];
  for (const p of proposals) {
    const agg = perProposal.get(p.refId);
    /* one Set to the end: a flag the aggregate builder pushes (DEVIATION below)
     * may already have ridden a line rec's flags — a duplicated entry would
     * corrupt every downstream count (the efficacy rollup counts entries). */
    const flagSet = new Set(agg.flags);
    if (agg.liveLines > 1) flagSet.add('SPLIT_ACROSS_POS');
    if (agg.cancelledLines > 0 && agg.liveLines > 0) flagSet.add('PART_CANCELLED');
    if (agg.cancelledLines > 0 && agg.liveLines === 0) {
      aggregates.push({
        refId: p.refId, outcome: 'CANCELLED', adherenceQty: null, receivedQty: 0,
        fillRate: null, realizedLeadDays: null, lateByDays: null,
        priceVariance: null, priceVariancePct: null,
        flags: Array.from(new Set([...flagSet, 'PO_CANCELLED'])).sort(),
        linesCancelled: agg.cancelledLines, linesLive: 0,
      });
      continue;
    }
    if (agg.liveLines === 0) {
      /* no closed-task PO numbers (or none linked): the no-commitment case is
       * the leaf's — PENDING inside the decision SLA, IGNORED past it (M2). */
      const rec = F.reconcileProposal(p, null, []);
      aggregates.push({
        refId: p.refId, outcome: rec.outcome, adherenceQty: 0, receivedQty: 0,
        fillRate: null, realizedLeadDays: null, lateByDays: null,
        priceVariance: null, priceVariancePct: null,
        flags: rec.flags.slice().sort(), linesCancelled: 0, linesLive: 0,
      });
      continue;
    }
    const adherenceQty = p.qty > 0 ? agg.orderedTotal / p.qty : null;
    const fillRate = agg.orderedTotal > 0 ? agg.netReceivedTotal / agg.orderedTotal : null;
    let outcome;
    if (agg.substituted) outcome = 'SUBSTITUTED';
    else if (adherenceQty === null) outcome = 'MODIFIED';
    else if (adherenceQty >= 0.95 && adherenceQty <= 1.05) outcome = 'FOLLOWED';
    else if (adherenceQty > 0) outcome = 'MODIFIED';
    else outcome = 'IGNORED';
    if (agg.unexplained && outcome !== 'FOLLOWED') flagSet.add('DEVIATION_UNEXPLAINED');
    /* lead span in canonical day units (the H4 canon, via feedback's rules) */
    const lead = daysBetween(agg.leadStart, agg.leadEnd);
    const priceVariance = agg.pricedQty > 0
      ? agg.priceSum / agg.pricedQty - (p.expectedUnitPrice != null ? p.expectedUnitPrice : 0)
      : null;
    aggregates.push({
      refId: p.refId, outcome, adherenceQty, receivedQty: agg.netReceivedTotal, fillRate,
      realizedLeadDays: lead, lateByDays: agg.maxLateByDays,
      priceVariance, priceVariancePct: priceVariance != null && p.expectedUnitPrice ? priceVariance / p.expectedUnitPrice : null,
      flags: Array.from(flagSet).sort(), linesCancelled: agg.cancelledLines, linesLive: agg.liveLines,
    });
  }

  return {
    lines: perLine,
    proposals: aggregates,
    allocations,
    unlinked: unlinkedLines,
    openPosition: {
      onOrder: perLine.reduce((s, l) => s + l.openQty, 0),
      lines: perLine.filter((l) => l.openQty > 0).map((l) => ({ poNumber: l.poNumber, sku: l.sku, open: l.openQty })),
    },
  };
}

/* day-unit math on canonical dates (the H4 canon; lead spans only use the
 * date-only / zone-stamped shapes the boundary converts upstream) */
function daysBetween(a, b) {
  if (!a || !b) return null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const toDay = (raw) => {
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const ms = Date.UTC(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10)));
      return new Date(ms).toISOString().slice(0, 10) === raw ? Math.floor(ms / DAY_MS) : null;
    }
    if (typeof raw === 'string' && /T\d{2}:\d{2}.*?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
      const ms = Date.parse(raw);
      return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
    }
    return null;
  };
  const da = toDay(a), db = toDay(b);
  return da === null || db === null ? null : db - da;
}

module.exports = { matchPoLines, STATUSES, EVENT_TYPES };
