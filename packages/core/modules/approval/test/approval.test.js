'use strict';
/* ============================================================================
 * approval suite — the C3 financial-controls decision layer (gate 5).
 *
 * Zero dependencies, no clock, no I/O: principals, tiers, prior votes and
 * hold rows are always injected. The three A4 named proofs are pinned by
 * name:
 *   sod/raisers-cannot-approve        — the FULL per-role-pair matrix (every
 *                                       raiser role × every approver role),
 *                                       the audit's "test per role pair";
 *   sod/dual-control-above-threshold  — above the threshold one vote leaves
 *                                       the proposal OPEN; a second DISTINCT
 *                                       eligible approver completes it;
 *   sod/supplier-change-freeze        — identity deltas stage a hold, the
 *                                       stored identity keeps serving, and
 *                                       only an eligible out-of-band
 *                                       verification opens the door.
 * Every verdict here is re-proven at the database (sod-live.js in CI) —
 * the API+DB pair, neither layer trusted alone.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const A = require(path.join(__dirname, '..'));
const { reviewApproval, convertToPo } = A.decide;
const { classifySupplierChange, verifySupplierHold, rejectSupplierHold, FROZEN_SUPPLIER_FIELDS } = A.freeze;
const { ROLES, APPROVAL_ELIGIBLE, isApprovalEligible, approvalRequirement, limitForRole } = A.roles;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

function deepEq(a, b, name) { assert.deepStrictEqual(a, b, name); }

/* ---- fixtures ---------------------------------------------------------------
 * Synthetic principals and tiers (D-003: no real data, ever). The buyer
 * raises; the senior buyer and the manager approve. Dual threshold 1000;
 * SBR ceiling 5000; SCM ceiling 50000; O unlimited (NULL). */
const USERS = {
  origin:  { userId: 'u-origin',  role: 'O'   },
  manager: { userId: 'u-manager', role: 'SCM' },
  senior:  { userId: 'u-senior',  role: 'SBR' },
  buyer:   { userId: 'u-buyer',   role: 'BYR' },
  analyst: { userId: 'u-analyst', role: 'DTA' },
  viewer:  { userId: 'u-viewer',  role: 'VWR' },
};
const CONFIG = { dualThresholdAmount: 1000 };
const LIMITS = [
  { role: 'SBR', maxSingleAmount: 5000 },
  { role: 'SCM', maxSingleAmount: 50000 },
  { role: 'O',   maxSingleAmount: null },
];
function proposal(over) {
  return Object.assign({
    id: 'p-1', state: 'OPEN', raisedBy: USERS.buyer.userId,
    currencyCode: 'BHD', totalAmount: 500,
  }, over || {});
}
function approve(actor, over) {
  return reviewApproval(Object.assign({
    proposal: proposal(),
    actor,
    config: CONFIG,
    limits: LIMITS,
    prior: [],
    decision: 'APPROVED',
    reason: 'approved — within budget',
    tenantCurrency: 'BHD',
  }, over || {}));
}
function denialCode(result) {
  assert.ok(result.ok === false, 'expected a denial, got ok');
  return result.denial.reason;
}

/* ---- roles & tiers ---------------------------------------------------------*/

test('roles: the six §10 codes, exactly', () => {
  deepEq(ROLES, ['O', 'SCM', 'SBR', 'BYR', 'DTA', 'VWR']);
});
test('roles: the "Approve proposals / POs" capability row is exactly O/SCM/SBR', () => {
  deepEq(APPROVAL_ELIGIBLE, ['O', 'SCM', 'SBR']);
  assert.ok(isApprovalEligible('SCM') && !isApprovalEligible('BYR') && !isApprovalEligible('VWR'));
});
test('tiers: dual control applies strictly ABOVE the threshold — exactly at it is single', () => {
  assert.strictEqual(approvalRequirement(999, 1000), 1);
  assert.strictEqual(approvalRequirement(1000, 1000), 1);
  assert.strictEqual(approvalRequirement(1000.01, 1000), 2);
});
test('tiers: limits resolve fail-closed — a missing row is undefined, NULL is unlimited', () => {
  assert.strictEqual(limitForRole(LIMITS, 'SBR'), 5000);
  assert.strictEqual(limitForRole(LIMITS, 'O'), null);
  assert.strictEqual(limitForRole(LIMITS, 'BYR'), undefined);
});

/* ---- NAMED PROOF: sod/raisers-cannot-approve (the full role-pair matrix) ---*/

test('NAMED PROOF sod/raisers-cannot-approve: every raiser role × every approver role — the raiser always refuses, ineligible roles always refuse', () => {
  for (const raiserRole of ROLES) {
    for (const approverRole of ROLES) {
      const raiser = { userId: 'u-' + raiserRole, role: raiserRole };
      const approver = { userId: 'u-' + approverRole, role: approverRole };
      const result = reviewApproval({
        proposal: proposal({ raisedBy: raiser.userId }),
        actor: approver, config: CONFIG, limits: LIMITS, prior: [],
        decision: 'APPROVED', reason: 'r', tenantCurrency: 'BHD',
      });
      if (approver.userId === raiser.userId) {
        // the SAME user, whatever their role: the fraud vector itself
        assert.strictEqual(denialCode(result), 'SOD_SELF_APPROVAL', `${raiserRole} self-approval must refuse`);
      } else if (!isApprovalEligible(approverRole)) {
        assert.strictEqual(denialCode(result), 'NOT_ELIGIBLE_ROLE', `${approverRole} must never approve`);
      } else {
        assert.ok(result.ok, `${approverRole} approving ${raiserRole}'s raise is legitimate`);
      }
    }
  }
});
test('NAMED PROOF sod/raisers-cannot-approve: the denial is the same code at the API the DB policy raises', () => {
  assert.strictEqual(denialCode(approve(USERS.buyer)), 'SOD_SELF_APPROVAL');
});

/* ---- NAMED PROOF: sod/dual-control-above-threshold -------------------------*/

test('NAMED PROOF sod/dual-control-above-threshold: one approval above the threshold leaves the proposal OPEN', () => {
  /* 4000 sits ABOVE the 1000 dual threshold but within SBR's 5000 ceiling —
   * the tiered value and the dual-control value are different dials. */
  const result = approve(USERS.senior, { proposal: proposal({ totalAmount: 4000 }) });
  assert.ok(result.ok && result.outcome === 'RECORDED_OPEN');
  assert.strictEqual(result.need, 2);
  assert.strictEqual(result.votes, 1);
});
test('NAMED PROOF sod/dual-control-above-threshold: a second DISTINCT eligible approver completes it', () => {
  const result = approve(USERS.manager, {
    proposal: proposal({ totalAmount: 4000 }),
    prior: [{ approverId: USERS.senior.userId, decision: 'APPROVED' }],
  });
  assert.ok(result.ok && result.outcome === 'APPROVED');
  assert.strictEqual(result.votes, 2);
});
test('NAMED PROOF sod/dual-control-above-threshold: the same approver cannot vote twice — ALREADY_DECIDED', () => {
  assert.strictEqual(denialCode(approve(USERS.senior, {
    proposal: proposal({ totalAmount: 4000 }),
    prior: [{ approverId: USERS.senior.userId, decision: 'APPROVED' }],
  })), 'ALREADY_DECIDED');
});
test('at or below the threshold a single eligible approval completes the proposal', () => {
  const result = approve(USERS.senior, { proposal: proposal({ totalAmount: 1000 }) });
  assert.ok(result.ok && result.outcome === 'APPROVED' && result.need === 1);
});

/* ---- value-tiered limits ---------------------------------------------------*/

test('limits: an approval above the approver\'s ceiling refuses LIMIT_EXCEEDED — a limit is not a discount on partial votes', () => {
  assert.strictEqual(denialCode(approve(USERS.senior, { proposal: proposal({ totalAmount: 5000.01 }) })), 'LIMIT_EXCEEDED');
  assert.ok(approve(USERS.senior, { proposal: proposal({ totalAmount: 5000 }) }).ok);
});
test('limits: Origin\'s NULL ceiling is unlimited', () => {
  assert.ok(approve(USERS.origin, { proposal: proposal({ totalAmount: 1000000 }) }).ok);
});
test('limits: an unconfigured tier refuses fail-closed — LIMIT_UNCONFIGURED, never an open door', () => {
  assert.strictEqual(denialCode(approve(USERS.manager, { limits: [] })), 'LIMIT_UNCONFIGURED');
});

/* ---- the refusal family ----------------------------------------------------*/

test('currency: the tier arithmetic only exists in the tenant currency — a foreign-currency proposal refuses, never converts', () => {
  assert.strictEqual(denialCode(approve(USERS.senior, { proposal: proposal({ currencyCode: 'AED' }) })), 'CURRENCY_NOT_TENANT_CURRENCY');
  assert.strictEqual(denialCode(approve(USERS.senior, { tenantCurrency: undefined })), 'TENANT_CURRENCY_MISSING');
});
test('reason: a decision without a reason cannot exist (§16.2)', () => {
  assert.strictEqual(denialCode(approve(USERS.senior, { reason: '' })), 'MISSING_REASON');
  assert.strictEqual(denialCode(approve(USERS.senior, { reason: '   ' })), 'MISSING_REASON');
});
test('state: decisions land on OPEN proposals only', () => {
  assert.strictEqual(denialCode(approve(USERS.senior, { proposal: proposal({ state: 'APPROVED' }) })), 'PROPOSAL_NOT_OPEN');
});
test('shape: an unknown decision and an unresolved principal refuse', () => {
  assert.strictEqual(denialCode(approve(USERS.senior, { decision: 'MAYBE' })), 'INVALID_DECISION');
  assert.strictEqual(denialCode(approve({ userId: 'x', role: 'ADMIN' })), 'PRINCIPAL_UNRESOLVED');
});
test('config: a tenant without the dual threshold refuses APPROVAL_CONFIG_MISSING', () => {
  assert.strictEqual(denialCode(approve(USERS.senior, { config: null })), 'APPROVAL_CONFIG_MISSING');
});

/* ---- rejection is terminal --------------------------------------------------*/

test('rejection: a REJECTED decision dismisses — a rejected proposal is re-raised, never revived', () => {
  const result = approve(USERS.senior, { decision: 'REJECTED', reason: 'no budget line' });
  assert.ok(result.ok && result.outcome === 'DISMISSED');
});

/* ---- the denial record is Class-D-shaped (H5 consumes it verbatim) ----------*/

test('denial payload: every refusal carries the §16.2 Class-D semantic fields', () => {
  const result = approve(USERS.buyer);
  assert.ok(result.ok === false);
  const d = result.denial;
  assert.strictEqual(d.class, 'D');
  assert.strictEqual(d.outcome, 'denied');
  assert.strictEqual(d.actor, USERS.buyer.userId);
  assert.strictEqual(d.role, 'BYR');
  assert.strictEqual(d.action, 'proposal.approve');
  assert.strictEqual(d.entity, 'proposal');
  assert.strictEqual(d.entityId, 'p-1');
  assert.strictEqual(d.reason, 'SOD_SELF_APPROVAL');
});
test('determinism: identical inputs produce deep-equal verdicts', () => {
  const a = approve(USERS.senior, { proposal: proposal({ totalAmount: 40000 }) });
  const b = approve(USERS.senior, { proposal: proposal({ totalAmount: 40000 }) });
  deepEq(a, b);
});

/* ---- conversion -------------------------------------------------------------*/

test('conversion: an APPROVED proposal converts with its lines verbatim — a document of record, no Precoro write-back', () => {
  const lines = [{ sku: 'SKU-1', qty: 10, unitCode: 'CTN', unitPrice: 12.5 }];
  const result = convertToPo({
    proposal: proposal({ state: 'APPROVED', supplierId: 's-1', totalAmount: 125 }),
    actor: USERS.senior, config: CONFIG, prior: [{ approverId: 'x', decision: 'APPROVED' }],
    poCode: 'PO-100', lines,
  });
  assert.ok(result.ok && result.outcome === 'CONVERTED');
  assert.strictEqual(result.po.code, 'PO-100');
  assert.strictEqual(result.po.totalAmount, 125);
  deepEq(result.po.lines, lines);
});
test('conversion: refuses anything but APPROVED — the state machine is not a suggestion', () => {
  assert.strictEqual(denialCode(convertToPo({
    proposal: proposal(), actor: USERS.senior, config: CONFIG, prior: [], poCode: 'PO-1',
  })), 'PROPOSAL_NOT_APPROVED');
});
test('conversion: re-proves the votes at the seam — DUAL_CONTROL_NOT_SATISFIED is defense in depth', () => {
  assert.strictEqual(denialCode(convertToPo({
    proposal: proposal({ state: 'APPROVED', totalAmount: 40000 }),
    actor: USERS.senior, config: CONFIG, prior: [], poCode: 'PO-1',
  })), 'DUAL_CONTROL_NOT_SATISFIED');
});
test('conversion: a PO without a code refuses', () => {
  assert.strictEqual(denialCode(convertToPo({
    proposal: proposal({ state: 'APPROVED' }), actor: USERS.senior, config: CONFIG,
    prior: [{ approverId: 'x', decision: 'APPROVED' }], poCode: '',
  })), 'MISSING_PO_CODE');
});

/* ---- NAMED PROOF: sod/supplier-change-freeze --------------------------------*/

const STORED = {
  external_id: 'S-100', name: 'Fresh Produce Trading', payment_term_days: 45,
  payment_terms_text: 'SOA +45 Days', currency_code: 'BHD',
};

test('NAMED PROOF sod/supplier-change-freeze: the frozen surface is exactly the H7 identity bases + the remittance fields', () => {
  deepEq(FROZEN_SUPPLIER_FIELDS, ['external_id', 'name', 'payment_term_days', 'payment_terms_text', 'currency_code']);
});
test('NAMED PROOF sod/supplier-change-freeze: a non-frozen delta rides the normal upsert — operations are not frozen', () => {
  const result = classifySupplierChange(STORED, Object.assign({}, STORED, { is_active: false, moq_value: 25 }));
  assert.strictEqual(result.frozen, false);
});
test('NAMED PROOF sod/supplier-change-freeze: an identity delta stages a hold — and the delta carries ALL five fields so the apply path cannot smuggle an extra change', () => {
  const result = classifySupplierChange(STORED, Object.assign({}, STORED, { name: 'Fresh Produce Trading WLL', payment_term_days: 30 }));
  assert.ok(result.frozen);
  deepEq(result.changed, ['name', 'payment_term_days']);
  for (const field of FROZEN_SUPPLIER_FIELDS) {
    assert.ok(result.delta[field] && 'from' in result.delta[field] && 'to' in result.delta[field], `delta must carry ${field}`);
  }
  assert.strictEqual(result.delta.name.from, 'Fresh Produce Trading');
  assert.strictEqual(result.delta.name.to, 'Fresh Produce Trading WLL');
  assert.strictEqual(result.delta.external_id.from, result.delta.external_id.to);
});
test('NAMED PROOF sod/supplier-change-freeze: a NEW supplier is not a change — identity creation is not frozen', () => {
  const result = classifySupplierChange(null, STORED);
  assert.strictEqual(result.frozen, false);
});

test('freeze verification: an eligible verifier with a reference applies the held change', () => {
  const hold = { id: 'h-1', state: 'COOLING_OFF', requestedBy: null };
  const result = verifySupplierHold({ hold, actor: USERS.manager, reference: 'OBV-2026-014 (bank letter on file)' });
  assert.ok(result.ok && result.outcome === 'APPLY');
});
test('freeze verification: the reference is the out-of-band evidence — without it there is no apply', () => {
  const hold = { id: 'h-1', state: 'COOLING_OFF', requestedBy: null };
  assert.strictEqual(denialCode(verifySupplierHold({ hold, actor: USERS.manager, reference: '' })), 'MISSING_VERIFICATION_REFERENCE');
  assert.strictEqual(denialCode(verifySupplierHold({ hold, actor: USERS.manager, reference: undefined })), 'MISSING_VERIFICATION_REFERENCE');
});
test('freeze verification: ineligible verifiers refuse — the freeze is an approval-capable act', () => {
  const hold = { id: 'h-1', state: 'COOLING_OFF', requestedBy: null };
  assert.strictEqual(denialCode(verifySupplierHold({ hold, actor: USERS.buyer, reference: 'r' })), 'NOT_ELIGIBLE_VERIFIER');
});
test('freeze verification: a user-requested hold is never verified by its requester — the SoD spine holds on the freeze too', () => {
  const hold = { id: 'h-1', state: 'COOLING_OFF', requestedBy: USERS.senior.userId };
  assert.strictEqual(denialCode(verifySupplierHold({ hold, actor: USERS.senior, reference: 'r' })), 'SOD_VERIFIER_IS_REQUESTER');
  assert.ok(verifySupplierHold({ hold, actor: USERS.manager, reference: 'r' }).ok);
});
test('freeze lifecycle: only a COOLING_OFF hold verifies; rejecting needs a reason too', () => {
  assert.strictEqual(denialCode(verifySupplierHold({ hold: { id: 'h-2', state: 'APPLIED', requestedBy: null }, actor: USERS.manager, reference: 'r' })), 'HOLD_NOT_PENDING');
  assert.ok(rejectSupplierHold({ hold: { id: 'h-3', state: 'COOLING_OFF', requestedBy: null }, actor: USERS.manager, reason: 'supplier denies the change' }).ok);
  assert.strictEqual(denialCode(rejectSupplierHold({ hold: { id: 'h-3', state: 'COOLING_OFF', requestedBy: null }, actor: USERS.manager, reason: '' })), 'MISSING_REASON');
});

console.log(`\n  approval: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
