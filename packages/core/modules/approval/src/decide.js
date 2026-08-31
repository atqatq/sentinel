'use strict';
/* ============================================================================
 * approval/decide.js — the C3 SoD decision layer (gate 5, named proofs
 * `sod/raisers-cannot-approve` and `sod/dual-control-above-threshold`).
 *
 * Pure and deterministic: no clock, no I/O — the caller injects the proposal
 * state, the resolved principal (userId + role, resolved from tenant_role by
 * the boundary), the tenant's tier config, the role limits and the prior
 * approval rows. The DATABASE re-proves every invariant this module proves
 * (the RESTRICTIVE sod_binding policy + the proposal_state_guard trigger):
 * the two layers agreeing is the API+DB pair the amendment demands — neither
 * is trusted alone.
 *
 * Every refusal returns a Class-D-shaped denial record (§16.2): actor, role,
 * action, entity, entityId, reason (the code), outcome 'denied'. The ledger
 * write that makes it durable lands with H5 (the next M3 unit) — the shape
 * is fixed HERE so the ledger consumes it verbatim, never a forked format.
 * ==========================================================================*/

const roles = require('./roles.js');

const ACTIONS = {
  APPROVE: 'proposal.approve',
  CONVERT: 'proposal.convert',
};

function denial(actor, action, entityId, reason) {
  return {
    class: 'D',
    outcome: 'denied',
    actor: actor ? actor.userId : null,
    role: actor ? actor.role : null,
    action,
    entity: 'proposal',
    entityId: entityId || null,
    reason,
  };
}

function resolveLimit(limits, role) {
  const limit = roles.limitForRole(limits, role);
  if (limit === undefined) return { ok: false, reason: 'LIMIT_UNCONFIGURED' };
  return { ok: true, limit };
}

/* The heart of the SoD contract: may this actor cast this decision on this
 * proposal, and what does the proposal's state become?
 *
 *   proposal   { id, state, raisedBy, currencyCode, totalAmount }
 *   actor      { userId, role }              — the authenticated principal
 *   config     { dualThresholdAmount } | null — the tenant's tier config
 *   limits     [{ role, maxSingleAmount }]
 *   prior      [{ approverId, decision }]    — the proposal's decision rows
 *   decision   'APPROVED' | 'REJECTED'
 *   reason     non-empty string (§16.2: a reason is required)
 */
function reviewApproval(input) {
  const { proposal, actor, config, limits, prior, decision, reason, tenantCurrency } = input;

  if (!actor || !roles.isRole(actor.role)) return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal && proposal.id, 'PRINCIPAL_UNRESOLVED') };
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal && proposal.id, 'INVALID_DECISION') };
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal && proposal.id, 'MISSING_REASON') };
  }
  if (!proposal || proposal.state !== 'OPEN') {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal && proposal.id, 'PROPOSAL_NOT_OPEN') };
  }

  /* C2/R1 discipline at the controls seam: the tier arithmetic is only
   * meaningful in ONE currency — the tenant's. A proposal in any other
   * currency is refused, never converted or compared by guesswork. */
  if (typeof tenantCurrency !== 'string' || tenantCurrency === '') {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal.id, 'TENANT_CURRENCY_MISSING') };
  }
  if (proposal.currencyCode !== tenantCurrency) {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal.id, 'CURRENCY_NOT_TENANT_CURRENCY') };
  }

  /* SoD invariant #1 — the raiser can never approve their own raise. This is
   * the audit's fraud vector: "a legitimate-looking proposal, self-approved,
   * converted to a PO". */
  if (actor.userId === proposal.raisedBy) {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal.id, 'SOD_SELF_APPROVAL') };
  }

  /* SoD invariant #2 — role eligibility (§10: BYR/DTA/VWR never approve). */
  if (!roles.isApprovalEligible(actor.role)) {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal.id, 'NOT_ELIGIBLE_ROLE') };
  }

  /* One decision per approver — the DB UNIQUE is the structure; this is the
   * honest verdict for the retry instead of a constraint error. */
  if ((prior || []).some((p) => p.approverId === actor.userId)) {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal.id, 'ALREADY_DECIDED') };
  }

  if (!config || typeof config.dualThresholdAmount !== 'number') {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal.id, 'APPROVAL_CONFIG_MISSING') };
  }

  if (decision === 'REJECTED') {
    /* A rejection is terminal: the proposal is dismissed with the reason on
     * the decision row. A buyer re-raises — a NEW proposal, a NEW identity.
     * A rejection grants no spend, so the actor's ceiling does not bind it —
     * the limit bounds what an approver can GRANT, never what they refuse. */
    return { ok: true, outcome: 'DISMISSED', votes: (prior || []).filter((p) => p.decision === 'APPROVED').length, need: roles.approvalRequirement(proposal.totalAmount, config.dualThresholdAmount) };
  }

  /* Value tier: the actor's ceiling must cover the WHOLE proposal value — an
   * approval limit is not a discount on partial votes. */
  const resolved = resolveLimit(limits, actor.role);
  if (!resolved.ok) {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal.id, resolved.reason) };
  }
  if (resolved.limit !== null && proposal.totalAmount > resolved.limit) {
    return { ok: false, denial: denial(actor, ACTIONS.APPROVE, proposal.id, 'LIMIT_EXCEEDED') };
  }

  /* Count the qualified votes INCLUDING this one. Distinctness is structural
   * (UNIQUE proposal+approver at the DB; ALREADY_DECIDED here). */
  const eligiblePrior = (prior || []).filter((p) => p.decision === 'APPROVED');
  const votes = eligiblePrior.length + 1;
  const need = roles.approvalRequirement(proposal.totalAmount, config.dualThresholdAmount);

  return votes >= need
    ? { ok: true, outcome: 'APPROVED', votes, need }
    : { ok: true, outcome: 'RECORDED_OPEN', votes, need };
}

/* Conversion: an APPROVED proposal becomes the PO document Sentinel issues
 * (there is no write-back to Precoro anywhere — design-spec screen 5). The
 * DB state-guard re-proves the votes; this module returns the honest verdict
 * and the document shape, carrying the lines verbatim. */
function convertToPo(input) {
  const { proposal, actor, config, prior, poCode, lines } = input;

  if (!actor || !roles.isRole(actor.role)) return { ok: false, denial: denial(actor, ACTIONS.CONVERT, proposal && proposal.id, 'PRINCIPAL_UNRESOLVED') };
  if (typeof poCode !== 'string' || poCode.trim() === '') {
    return { ok: false, denial: denial(actor, ACTIONS.CONVERT, proposal && proposal.id, 'MISSING_PO_CODE') };
  }
  if (!proposal || proposal.state !== 'APPROVED') {
    return { ok: false, denial: denial(actor, ACTIONS.CONVERT, proposal && proposal.id, 'PROPOSAL_NOT_APPROVED') };
  }
  if (!config || typeof config.dualThresholdAmount !== 'number') {
    return { ok: false, denial: denial(actor, ACTIONS.CONVERT, proposal && proposal.id, 'APPROVAL_CONFIG_MISSING') };
  }
  if (!proposal.supplierId) {
    /* The PO is issued TO a supplier — a proposal that never named one cannot
     * convert (the document's supplier_id is NOT NULL; this is its named,
     * honest refusal instead of a constraint error). */
    return { ok: false, denial: denial(actor, ACTIONS.CONVERT, proposal.id, 'CONVERT_NO_SUPPLIER') };
  }

  /* Defense in depth: re-prove the vote count at the conversion seam — the
   * same qualified-vote rule the state guard enforces, computed from the
   * injected rows, never assumed from the state column alone. */
  const qualified = (prior || []).filter((p) => p.decision === 'APPROVED').length;
  const need = roles.approvalRequirement(proposal.totalAmount, config.dualThresholdAmount);
  if (qualified < need) {
    return { ok: false, denial: denial(actor, ACTIONS.CONVERT, proposal.id, 'DUAL_CONTROL_NOT_SATISFIED') };
  }

  return {
    ok: true,
    outcome: 'CONVERTED',
    po: {
      code: poCode,
      proposalId: proposal.id,
      supplierId: proposal.supplierId,
      currencyCode: proposal.currencyCode,
      totalAmount: proposal.totalAmount,
      lines: (lines || []).map((l) => ({ sku: l.sku, qty: l.qty, unitCode: l.unitCode, unitPrice: l.unitPrice })),
    },
  };
}

module.exports = { reviewApproval, convertToPo, ACTIONS, denial };
