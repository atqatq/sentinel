'use strict';
/* ============================================================================
 * approval/cf.js — conversion-factor governance (M7, §14.13b; named proof
 * `governance/cf-change`).
 *
 * The audit's M7 finding: CF multiplies consumption, PO conversion (C1) and
 * order sizing, and the risk assessment calls CF errors order-of-magnitude —
 * yet nothing gated a CF edit, versioned it, or handled in-flight rows sized
 * under the old factor. This module is the arbitration mechanics §14.13
 * promised the category owner, in the same shape as the supplier-identity
 * freeze beside it (freeze.js): classify-then-stage, a dual-controlled
 * decision, and one door — the database re-proves every invariant here with
 * the item_cf_freeze trigger (no app.cf_apply_id, no factor delta).
 *
 * Pure and deterministic: no clock, no I/O — the stored row, the incoming row,
 * the version row and the latest seal are always injected. Timestamps and
 * writes are the executor's.
 *
 * Three surfaces:
 *   - classifyCfChange(oldRow, newRow) — the ingestion seam's partition:
 *     equal rides, different-and-usable STAGES a PENDING version (the stored
 *     factor keeps serving), a blank NEVER wipes, invalid is kept and named,
 *     bootstrap (no stored row) applies freely.
 *   - decideCfVersion({ version, actor, decision, reason }) — the C3 gate:
 *     eligible decider, never the requester, PENDING only, reason on reject,
 *     CF_INVALID refused at the core (the trigger cannot see the value's
 *     fitness — this module can). Refusals are Class-D denial records.
 *   - deriveRederiveTasks(latestSeal, version) — the third audit leg: the
 *     change raises re-derivation. Every ref whose sealed sizingBasis differs
 *     from the new factor raises ONE WARN task naming ref, sku and the
 *     from→to delta; matching refs are counted and disclosed, never tasked.
 *     Explicit re-derivation, never a silent rebase.
 * ==========================================================================*/

const roles = require('./roles.js');

const ACTIONS = {
  APPLY: 'item_cf_version.apply',
  REJECT: 'item_cf_version.reject',
};

function denial(actor, action, entityId, reason) {
  return {
    class: 'D',
    outcome: 'denied',
    actor: actor ? actor.userId : null,
    role: actor ? actor.role : null,
    action,
    entity: 'item_cf_version',
    entityId: entityId || null,
    reason,
  };
}

/* The usable-factor predicate, canon with toPlanningUnits: finite and > 0. */
function usableCf(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/* The factor as it rides the version delta — a canonical string, or null.
 * (The freeze's null-preserving string discipline; the numeric value the
 * executor writes comes from toValue below, never from re-parsing these.) */
function cfText(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = usableCf(v);
  return n === null ? null : String(n);
}

/* ---- classifyCfChange — the ingestion seam's partition --------------------
 *   oldRow: the stored item row ({ sku, conversionFactor }) or null.
 *   newRow: the incoming normalized item row ({ conversionFactor } may be
 *           null/undefined — a blank column).
 * Outcomes:
 *   { staged: false, apply: true }                     — ride (equal / bootstrap)
 *   { staged: false, apply: false, keep: true, disclosure, detail? } — keep stored
 *   { staged: true, from, to, fromValue, toValue, sku } — stage the version   */
function classifyCfChange(oldRow, newRow) {
  if (oldRow !== null && (typeof oldRow !== 'object' || Array.isArray(oldRow))) {
    throw new Error('WIRING_MALFORMED: oldRow must be an object or null');
  }
  if (!newRow || typeof newRow !== 'object' || Array.isArray(newRow)) {
    throw new Error('WIRING_MALFORMED: newRow must be an object');
  }
  const sku = newRow.sku === undefined || newRow.sku === null || newRow.sku === '' ? null : String(newRow.sku);
  const incoming = newRow.conversionFactor;

  /* No stored row: first load is not a change — the factor applies freely. */
  if (!oldRow) return { staged: false, apply: true };

  /* Blank/absent incoming: a blank NEVER wipes — the stored factor keeps
   * serving, the run discloses once (the executor folds the counts). */
  if (incoming === null || incoming === undefined || incoming === '') {
    return { staged: false, apply: false, keep: true, disclosure: 'CF_BLANK_KEEPS_SERVING' };
  }

  const toNum = usableCf(incoming);
  if (toNum === null) {
    /* Present but invalid: corrupt master is disclosed, never applied,
     * never staged — an invalid target is a data error, not a change request. */
    return {
      staged: false, apply: false, keep: true,
      disclosure: 'CF_INVALID_KEPT',
      detail: `incoming conversion factor '${String(incoming)}' is not a usable positive number`,
    };
  }

  const fromNum = usableCf(oldRow.conversionFactor);
  const from = fromNum === null ? null : String(fromNum);
  const to = String(toNum);
  if (fromNum !== null && fromNum === toNum) {
    return { staged: false, apply: true }; // equal — a no-op write, nothing fires
  }
  return { staged: true, sku, from, to, fromValue: fromNum, toValue: toNum };
}

/* ---- decideCfVersion — the C3 gate ----------------------------------------
 *   version: { id, sku, version, state, requestedBy, toValue }
 *   actor:   { userId, role } — the resolved principal
 *   decision:'APPLY' | 'REJECT'; reason required for REJECT.
 * Returns { ok: true, outcome } or { ok: false, denial }. */
function decideCfVersion(input) {
  const { version, actor, decision, reason } = input || {};
  const action = decision === 'REJECT' ? ACTIONS.REJECT : ACTIONS.APPLY;

  if (!actor || !roles.isRole(actor.role)) {
    return { ok: false, denial: denial(actor, action, version && version.id, 'PRINCIPAL_UNRESOLVED') };
  }
  if (!version || typeof version !== 'object' || Array.isArray(version)) {
    return { ok: false, denial: denial(actor, action, null, 'WIRING_MALFORMED') };
  }
  if (version.state !== 'PENDING') {
    return { ok: false, denial: denial(actor, action, version.id, 'VERSION_NOT_PENDING') };
  }
  if (!roles.isApprovalEligible(actor.role)) {
    return { ok: false, denial: denial(actor, action, version.id, 'NOT_ELIGIBLE_DECIDER') };
  }
  /* pipeline-staged rows (requestedBy NULL) may be decided by any eligible
   * principal; a user-requested version can never be decided by its requester
   * (the same SoD spine as approvals and the supplier hold). */
  if (version.requestedBy && actor.userId === version.requestedBy) {
    return { ok: false, denial: denial(actor, action, version.id, 'SOD_DECIDER_IS_REQUESTER') };
  }
  if (decision !== 'APPLY' && decision !== 'REJECT') {
    return { ok: false, denial: denial(actor, action, version.id, 'INVALID_DECISION') };
  }
  if (decision === 'REJECT' && (typeof reason !== 'string' || reason.trim() === '')) {
    return { ok: false, denial: denial(actor, action, version.id, 'MISSING_REASON') };
  }
  if (decision === 'APPLY') {
    /* The core refuses what the trigger cannot see: the target's fitness. */
    if (usableCf(version.toValue) === null) {
      return { ok: false, denial: denial(actor, action, version.id, 'CF_INVALID') };
    }
  }
  return { ok: true, outcome: decision };
}

/* ---- deriveRederiveTasks — the third audit leg ----------------------------
 *   latestSeal: the most recent plan_seal payload ({ refs: [...] }) or null
 *               (no seal yet → nothing is in flight; the change still applies).
 *   version:    the EFFECTIVE version ({ sku, from, to, fromValue, toValue }).
 * Returns { tasks: [...], refsAffected, refsUnaffected } — sorted, one WARN
 * task per affected ref, deterministic. A seal payload without refs is a
 * wiring error, never an empty walk. */
function deriveRederiveTasks(latestSeal, version) {
  if (!version || typeof version !== 'object' || Array.isArray(version)) {
    throw new Error('WIRING_MALFORMED: version must be an object');
  }
  const toNum = usableCf(version.toValue);
  if (toNum === null) throw new Error('WIRING_MALFORMED: version.toValue must be a usable positive number');
  if (latestSeal === null || latestSeal === undefined) {
    return { tasks: [], refsAffected: 0, refsUnaffected: 0 };
  }
  if (typeof latestSeal !== 'object' || Array.isArray(latestSeal) || !Array.isArray(latestSeal.refs)) {
    throw new Error('WIRING_MALFORMED: latestSeal must be a seal payload with refs');
  }

  const tasks = [];
  let refsAffected = 0;
  let refsUnaffected = 0;
  const rows = [...latestSeal.refs].sort((a, b) => (String(a.ref) < String(b.ref) ? -1 : String(a.ref) > String(b.ref) ? 1 : 0));
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('WIRING_MALFORMED: refs entries must be objects');
    }
    const basis = Array.isArray(row.sizingBasis) ? row.sizingBasis : null;
    if (!basis) { refsUnaffected += 1; continue; } // pre-§14.13b seal — nothing to compare
    const stale = basis
      .filter((m) => m && typeof m === 'object' && m.sku !== undefined && m.conversionFactor !== null && m.conversionFactor !== undefined)
      .filter((m) => usableCf(m.conversionFactor) !== null && usableCf(m.conversionFactor) !== toNum)
      .sort((a, b) => (String(a.sku) < String(b.sku) ? -1 : String(a.sku) > String(b.sku) ? 1 : 0));
    if (stale.length === 0) { refsUnaffected += 1; continue; }
    refsAffected += 1;
    const detail = `ref ${row.ref}: conversion factor changed ${version.from === null ? '(none)' : version.from} → ${version.to}; sized under the old basis for ${stale.map((m) => m.sku).join(', ')} — re-derive before comparing (M7: explicit re-derivation, never a silent rebase)`;
    tasks.push({ type: 'DATA_HEALTH', field: 'conversion_factor', detail, severity: 'WARN' });
  }
  return { tasks, refsAffected, refsUnaffected };
}

module.exports = {
  ACTIONS,
  classifyCfChange,
  decideCfVersion,
  deriveRederiveTasks,
};
