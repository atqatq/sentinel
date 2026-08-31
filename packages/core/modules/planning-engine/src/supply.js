'use strict';
/* ============================================================================
 * Sentinel — supply-status producers (the M5 normative layer, §14.6c).
 *
 * The audit's finding M5 [S]: "`supplyStatus` (engine.js:143–151) consumes
 * fields no export defines and no code derives. … the status axis must never
 * render from under-specified data." Until this layer existed, `overduePO`,
 * `partialPO` and `supplierIssue` arrived from nobody — the second ontology
 * axis was under-specified data wearing a vocabulary. This module is the
 * implementation; build spec §14.6c is the contract it obeys. The named
 * acceptance proof is `ingestion/supply-status-producers`.
 *
 * Home rules (ADR-0001): pure — no I/O, no clock, no db; every fact enters as
 * a parameter; identical inputs produce deep-equal output. The producer
 * receives FACTS and never invents them. `supplyStatus` (engine.js) remains
 * the classifier this module feeds — one vocabulary, no forked classification.
 *
 * Liveness is the spine (§14.6c): a line is live iff its status is OPEN or
 * absent; CANCELLED and CLOSED lines leave the loop — the §14.6b rationale
 * verbatim (the truck is not coming). The engine's openPO input becomes the
 * live-line sum, so a cancelled commitment can no longer paint "Follow-up
 * with Supplier" on a ref whose trucks are never coming — the same defect
 * class §14.6b already stopped at the guard.
 * ==========================================================================*/

const STATUSES = ['OPEN', 'CANCELLED', 'CLOSED'];
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ---- refusal family (fail-closed: a wiring error is loud, never guessed) -- */
function refuse(code, detail) {
  throw new TypeError(`deriveSupplyFacts: ${code} — ${detail}`);
}
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** H4 canonical UTC date (YYYY-MM-DD), validated as a REAL calendar day —
 *  string comparison is only trustworthy when the string itself is honest.
 *  Returns the canonical string, null (absent), or undefined (present but
 *  invalid — the caller refuses by name). */
function canonicalDate(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !CANONICAL_DATE.test(v)) return undefined;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return v;
}

/* ---- the producer ----------------------------------------------------------
 * lines: the caller-scoped facts (one ref's member-SKU Open-PO lines, in the
 * caller's deterministic order — sums accumulate in the order given). Each
 * line: {poNumber, sku, waiting (C1-converted planning units), received?,
 * expectedDelivery?, status?, supplierBanned?}.
 *
 * Returns the §14.6c facts: {openPO, overduePO, partialPO, supplierIssue,
 * cancelledLines, cancelledWaiting, closedLines, closedWaiting,
 * unpromisedLines, unpromisedWaiting}. */
function deriveSupplyFacts(input) {
  const { lines, asOf } = input || {};
  if (!Array.isArray(lines)) refuse('LINES_MALFORMED', 'lines must be an array');
  const asOfCanon = canonicalDate(asOf);
  if (asOfCanon === null) {
    refuse('ASOF_REQUIRED', "the producer owns no clock — asOf is the plan run's canonical UTC date (H4)");
  }
  if (asOfCanon === undefined) {
    refuse('ASOF_INVALID', `asOf ${JSON.stringify(asOf)} is not an H4 canonical UTC date (YYYY-MM-DD)`);
  }

  const seen = new Set();
  const facts = {
    openPO: 0, overduePO: 0, partialPO: 0, supplierIssue: false,
    cancelledLines: 0, cancelledWaiting: 0, closedLines: 0, closedWaiting: 0,
    unpromisedLines: 0, unpromisedWaiting: 0,
  };

  for (const l of lines) {
    if (!l || typeof l.poNumber !== 'string' || !l.poNumber || typeof l.sku !== 'string' || !l.sku) {
      refuse('LINE_MALFORMED', 'every line carries poNumber and sku — the line identity (§14.6b)');
    }
    if (!finite(l.waiting) || l.waiting < 0) {
      refuse('LINE_QTY_INVALID', `line ${l.poNumber}/${l.sku} waiting must be a finite number >= 0 (C1-converted planning units; an unconverted line belongs to the caller's disclosure, not here)`);
    }
    if (l.received != null && (!finite(l.received) || l.received < 0)) {
      refuse('LINE_QTY_INVALID', `line ${l.poNumber}/${l.sku} received must be a finite number >= 0 when present`);
    }
    if (l.supplierBanned != null && typeof l.supplierBanned !== 'boolean') {
      refuse('LINE_MALFORMED', `line ${l.poNumber}/${l.sku} supplierBanned must be a boolean when present`);
    }
    let status = null;
    if (l.status != null) {
      if (typeof l.status !== 'string' || !STATUSES.includes(l.status)) {
        refuse('LINE_STATUS_UNKNOWN', `line ${l.poNumber}/${l.sku} status ${JSON.stringify(l.status)} is not one of ${STATUSES.join(' | ')}`);
      }
      status = l.status;
    }
    const promised = canonicalDate(l.expectedDelivery);
    if (promised === undefined) {
      refuse('LINE_DATE_INVALID', `line ${l.poNumber}/${l.sku} expectedDelivery ${JSON.stringify(l.expectedDelivery)} is not an H4 canonical UTC date (YYYY-MM-DD)`);
    }
    const key = `${l.poNumber}\u0000${l.sku}`;
    if (seen.has(key)) refuse('LINE_DUPLICATE', `line ${l.poNumber}/${l.sku} appears twice — the identity must stay unique`);
    seen.add(key);

    const live = status === null || status === 'OPEN';
    if (!live) {
      /* Dead lines leave the loop — and a dead line still carrying waiting
       * means the export disagrees with the PO lifecycle: disclosed, never
       * silently absorbed. */
      if (status === 'CANCELLED') {
        facts.cancelledLines++;
        if (l.waiting > 0) facts.cancelledWaiting += l.waiting;
      } else {
        facts.closedLines++;
        if (l.waiting > 0) facts.closedWaiting += l.waiting;
      }
      continue;
    }

    facts.openPO += l.waiting;
    if (l.waiting > 0) {
      if (promised === null) {
        /* No promise, no lateness — follow-up without a promise date is
         * blind, and data health should say so. */
        facts.unpromisedLines++;
        facts.unpromisedWaiting += l.waiting;
      } else if (promised < asOfCanon) {
        facts.overduePO += l.waiting;
      }
      const received = l.received == null ? 0 : l.received;
      if (received > 0) facts.partialPO += l.waiting;
    }
    if (l.supplierBanned === true) facts.supplierIssue = true;
  }
  return facts;
}

module.exports = { deriveSupplyFacts, STATUSES };
