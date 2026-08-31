'use strict';
/* ============================================================================
 * approval/roles.js — the §10 role vocabulary and the value tiers.
 *
 * Roles are stable short codes, canonical in the permission matrix, the
 * ledger `role` field and the UI pills (build spec §10). The approval
 * capability row ("Approve proposals / POs") names exactly O, SCM, SBR —
 * BYR, DTA and VWR never approve, no matter the value.
 *
 * The tiers are DATA, never code: approval_config (the per-tenant dual-control
 * threshold) and approval_limit (the per-role single-approval ceiling) are
 * tenant rows, Origin-amendable. This module only INTERPRETS them:
 *   - dual control applies strictly ABOVE the threshold (at-threshold is a
 *     single-approval decision — the audit's "dual approval above tier 2");
 *   - a missing limit row for an eligible role is fail-closed
 *     (LIMIT_UNCONFIGURED) — an unconfigured tier is not an open door;
 *   - a present row with NULL ceiling is unlimited (the Origin row).
 * ==========================================================================*/

const ROLES = ['O', 'SCM', 'SBR', 'BYR', 'DTA', 'VWR'];

/* Build spec §10, capability row "Approve proposals / POs". */
const APPROVAL_ELIGIBLE = ['O', 'SCM', 'SBR'];

function isRole(role) {
  return typeof role === 'string' && ROLES.includes(role);
}

function isApprovalEligible(role) {
  return isRole(role) && APPROVAL_ELIGIBLE.includes(role);
}

/* Votes required to move a proposal OPEN → APPROVED. Above the threshold is
 * strictly `>` — exactly at the threshold is still a single approval. */
function approvalRequirement(totalAmount, dualThresholdAmount) {
  if (typeof totalAmount !== 'number' || !Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error('INVALID_PROPOSAL_TOTAL');
  }
  if (typeof dualThresholdAmount !== 'number' || !Number.isFinite(dualThresholdAmount) || dualThresholdAmount < 0) {
    throw new Error('INVALID_DUAL_THRESHOLD');
  }
  return totalAmount > dualThresholdAmount ? 2 : 1;
}

/* Resolves the ceiling for a role from the tenant's approval_limit rows.
 *   row found, maxSingleAmount === null  → null (unlimited)
 *   row found, number                    → the ceiling
 *   no row                               → undefined (the caller refuses,
 *                                          LIMIT_UNCONFIGURED — fail-closed) */
function limitForRole(limitRows, role) {
  const row = (limitRows || []).find((r) => r && r.role === role);
  if (!row) return undefined;
  if (row.maxSingleAmount === null || row.maxSingleAmount === undefined) return null;
  const n = Number(row.maxSingleAmount);
  if (!Number.isFinite(n) || n < 0) throw new Error('INVALID_APPROVAL_LIMIT');
  return n;
}

module.exports = {
  ROLES,
  APPROVAL_ELIGIBLE,
  isRole,
  isApprovalEligible,
  approvalRequirement,
  limitForRole,
};
