'use strict';
/* ============================================================================
 * approval/freeze.js — the supplier-identity change freeze (C3, named proof
 * `sod/supplier-change-freeze`).
 *
 * The audit's fraud model: supplier bank-detail substitution enters through
 * exactly the seam of a legitimate-looking supplier master change. Sentinel
 * discards banking fields at ingestion (C4), but the fields it DOES carry —
 * the H7 identity bases (external_id, name) and the remittance-relevant
 * surface (payment_term_days, payment_terms_text, currency_code) — still
 * reroute physical goods and invoices. Any change to THOSE is frozen:
 *
 *   - classifySupplierChange partitions an incoming supplier row against the
 *     stored row: frozen-field deltas stage a hold; everything else rides
 *     normally. The delta carries ALL FIVE frozen fields with from/to
 *     (null-preserving, strings) — the SQL trigger compares the applied row
 *     against this delta EXACTLY, so the apply path cannot smuggle an extra
 *     change in.
 *   - verifySupplierHold is the out-of-band gate: a non-empty verification
 *     reference (the evidence of the out-of-band check), an approval-eligible
 *     verifier, and never the requester. The SQL side refuses any identity
 *     change executed without the verified hold (app.hold_apply_id) — the
 *     freeze has no bypass, only this door.
 *
 * Pure and deterministic; the hold lifecycle's persistence is the executor's.
 * ==========================================================================*/

const roles = require('./roles.js');

/* The Sentinel-visible identity/remittance surface (banking fields are
 * discarded at ingestion — the audit acknowledges this and names the freeze
 * "supplier-identity change freeze" for exactly this surface). */
const FROZEN_SUPPLIER_FIELDS = [
  'external_id',
  'name',
  'payment_term_days',
  'payment_terms_text',
  'currency_code',
];

const ACTIONS = {
  VERIFY: 'supplier_change_hold.verify',
  REJECT: 'supplier_change_hold.reject',
};

function denial(actor, action, entityId, reason) {
  return {
    class: 'D',
    outcome: 'denied',
    actor: actor ? actor.userId : null,
    role: actor ? actor.role : null,
    action,
    entity: 'supplier_change_hold',
    entityId: entityId || null,
    reason,
  };
}

function text(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

/* Partitions the incoming supplier row against the stored row.
 *   frozen: false — no frozen-field delta; the row rides the normal upsert.
 *   frozen: true  — delta (all five fields, from/to as strings|null) plus the
 *                   changed-field list; the executor stages the hold instead
 *                   of applying, and the stored identity keeps serving. */
function classifySupplierChange(oldRow, newRow) {
  if (!oldRow) return { frozen: false, changed: [], delta: null };

  const changed = [];
  for (const field of FROZEN_SUPPLIER_FIELDS) {
    const from = oldRow[field];
    const to = newRow ? newRow[field] : undefined;
    if (from !== to) changed.push(field);
  }
  if (changed.length === 0) return { frozen: false, changed: [], delta: null };

  const delta = {};
  for (const field of FROZEN_SUPPLIER_FIELDS) {
    delta[field] = { from: text(oldRow[field]), to: text(newRow ? newRow[field] : undefined) };
  }
  return { frozen: true, changed, delta };
}

/* The out-of-band verification gate. requestedBy === null means the hold was
 * staged by the pipeline itself (ingestion-originated) — any eligible
 * verifier may verify it. A user-requested hold can never be verified by its
 * requester (the same SoD spine as approvals). */
function verifySupplierHold(input) {
  const { hold, actor, reference } = input;

  if (!actor || !roles.isRole(actor.role)) {
    return { ok: false, denial: denial(actor, ACTIONS.VERIFY, hold && hold.id, 'PRINCIPAL_UNRESOLVED') };
  }
  if (!hold || hold.state !== 'COOLING_OFF') {
    return { ok: false, denial: denial(actor, ACTIONS.VERIFY, hold && hold.id, 'HOLD_NOT_PENDING') };
  }
  if (typeof reference !== 'string' || reference.trim() === '') {
    return { ok: false, denial: denial(actor, ACTIONS.VERIFY, hold.id, 'MISSING_VERIFICATION_REFERENCE') };
  }
  if (!roles.isApprovalEligible(actor.role)) {
    return { ok: false, denial: denial(actor, ACTIONS.VERIFY, hold.id, 'NOT_ELIGIBLE_VERIFIER') };
  }
  if (hold.requestedBy && actor.userId === hold.requestedBy) {
    return { ok: false, denial: denial(actor, ACTIONS.VERIFY, hold.id, 'SOD_VERIFIER_IS_REQUESTER') };
  }
  return { ok: true, outcome: 'APPLY' };
}

/* Rejecting a hold is a decision too — reason required, eligible verifier,
 * never the requester. The stored identity simply keeps serving. */
function rejectSupplierHold(input) {
  const { hold, actor, reason } = input;

  if (!actor || !roles.isRole(actor.role)) {
    return { ok: false, denial: denial(actor, ACTIONS.REJECT, hold && hold.id, 'PRINCIPAL_UNRESOLVED') };
  }
  if (!hold || hold.state !== 'COOLING_OFF') {
    return { ok: false, denial: denial(actor, ACTIONS.REJECT, hold && hold.id, 'HOLD_NOT_PENDING') };
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { ok: false, denial: denial(actor, ACTIONS.REJECT, hold.id, 'MISSING_REASON') };
  }
  if (!roles.isApprovalEligible(actor.role)) {
    return { ok: false, denial: denial(actor, ACTIONS.REJECT, hold.id, 'NOT_ELIGIBLE_VERIFIER') };
  }
  if (hold.requestedBy && actor.userId === hold.requestedBy) {
    return { ok: false, denial: denial(actor, ACTIONS.REJECT, hold.id, 'SOD_VERIFIER_IS_REQUESTER') };
  }
  return { ok: true, outcome: 'REJECTED' };
}

module.exports = {
  FROZEN_SUPPLIER_FIELDS,
  classifySupplierChange,
  verifySupplierHold,
  rejectSupplierHold,
  ACTIONS,
};
