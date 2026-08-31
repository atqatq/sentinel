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

test('rejection: a REJECTED decision dismisses — a rejected proposal is re-raised, never revived; the actor\'s ceiling does not bind a refusal', () => {
  const result = approve(USERS.senior, { decision: 'REJECTED', reason: 'no budget line', limits: [] });
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
    proposal: proposal({ state: 'APPROVED', totalAmount: 40000, supplierId: 's-1' }),
    actor: USERS.senior, config: CONFIG, prior: [], poCode: 'PO-1',
  })), 'DUAL_CONTROL_NOT_SATISFIED');
});
test('conversion: a proposal that never named a supplier cannot become a PO — CONVERT_NO_SUPPLIER, the honest refusal before the constraint', () => {
  assert.strictEqual(denialCode(convertToPo({
    proposal: proposal({ state: 'APPROVED' }), actor: USERS.senior, config: CONFIG,
    prior: [{ approverId: 'x', decision: 'APPROVED' }], poCode: 'PO-1',
  })), 'CONVERT_NO_SUPPLIER');
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

/* ===========================================================================
 * NAMED PROOF governance/cf-change — conversion-factor governance (M7,
 * §14.13b). The audit's three legs, decided here and re-proven at the
 * database (item_cf_freeze trigger + resolveCfVersion door, sod-live.js):
 * classification (stage, never apply), the C3 decision gate, and the
 * re-derivation derive. Every refusal is a Class-D denial record.
 * =========================================================================*/
const { classifyCfChange, decideCfVersion, deriveRederiveTasks } = A.cf;

console.log('\nNAMED PROOF governance/cf-change');

/* ---- classifyCfChange: the ingestion seam's partition --------------------- */
test('cf classify: no stored row is bootstrap — the first load applies freely', () => {
  const r = classifyCfChange(null, { sku: 'SKU-1', conversionFactor: 12 });
  assert.deepStrictEqual(r, { staged: false, apply: true });
});
test('cf classify: an equal factor rides — a no-op write, nothing fires', () => {
  const r = classifyCfChange({ sku: 'SKU-1', conversionFactor: 12 }, { sku: 'SKU-1', conversionFactor: 12 });
  assert.deepStrictEqual(r, { staged: false, apply: true });
});
test('cf classify: a different usable factor STAGES — from/to preserved as canonical strings', () => {
  const r = classifyCfChange({ sku: 'SKU-1', conversionFactor: 12 }, { sku: 'SKU-1', conversionFactor: 24 });
  assert.strictEqual(r.staged, true);
  assert.strictEqual(r.from, '12');
  assert.strictEqual(r.to, '24');
  assert.strictEqual(r.fromValue, 12);
  assert.strictEqual(r.toValue, 24);
  assert.strictEqual(r.sku, 'SKU-1');
});
test('cf classify: a stored NULL factor with an incoming usable one stages too — from none to some is a change', () => {
  const r = classifyCfChange({ sku: 'SKU-1', conversionFactor: null }, { sku: 'SKU-1', conversionFactor: 12 });
  assert.strictEqual(r.staged, true);
  assert.strictEqual(r.from, null);
  assert.strictEqual(r.to, '12');
});
test('cf classify: a blank NEVER wipes — the stored factor keeps serving, disclosed', () => {
  for (const blank of [null, undefined, '']) {
    const r = classifyCfChange({ sku: 'SKU-1', conversionFactor: 12 }, { sku: 'SKU-1', conversionFactor: blank });
    assert.deepStrictEqual(r, { staged: false, apply: false, keep: true, disclosure: 'CF_BLANK_KEEPS_SERVING' }, `blank ${String(blank)}`);
  }
});
test('cf classify: an invalid incoming factor is kept and named — corrupt master is a data error, not a change request', () => {
  for (const bad of [0, -3, 'abc', Number.NaN]) {
    const r = classifyCfChange({ sku: 'SKU-1', conversionFactor: 12 }, { sku: 'SKU-1', conversionFactor: bad });
    assert.strictEqual(r.staged, false, `invalid ${String(bad)}`);
    assert.strictEqual(r.apply, false);
    assert.strictEqual(r.keep, true);
    assert.strictEqual(r.disclosure, 'CF_INVALID_KEPT');
    assert.ok(typeof r.detail === 'string' && r.detail.length > 0);
  }
});
test('cf classify: malformed shapes refuse by name — the wiring posture', () => {
  assert.throws(() => classifyCfChange({}, null), /WIRING_MALFORMED/);
  assert.throws(() => classifyCfChange(42, { sku: 'S' }), /WIRING_MALFORMED/);
  assert.throws(() => classifyCfChange({ sku: 'S', conversionFactor: 1 }, [1, 2]), /WIRING_MALFORMED/);
});

/* ---- decideCfVersion: the C3 gate ----------------------------------------- */
function cfVersion(over) {
  return Object.assign({ id: 'v-1', sku: 'SKU-1', version: 3, state: 'PENDING', requestedBy: null, toValue: 24 }, over || {});
}
test('cf decide: an unresolved principal refuses', () => {
  assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion(), actor: null, decision: 'APPLY' })), 'PRINCIPAL_UNRESOLVED');
  assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion(), actor: { userId: 'x', role: 'NOPE' }, decision: 'APPLY' })), 'PRINCIPAL_UNRESOLVED');
});
test('cf decide: a malformed version refuses', () => {
  assert.strictEqual(denialCode(decideCfVersion({ version: null, actor: USERS.manager, decision: 'APPLY' })), 'WIRING_MALFORMED');
  assert.strictEqual(denialCode(decideCfVersion({ version: [1], actor: USERS.manager, decision: 'APPLY' })), 'WIRING_MALFORMED');
});
test('cf decide: only a PENDING version decides', () => {
  assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion({ state: 'EFFECTIVE' }), actor: USERS.manager, decision: 'APPLY' })), 'VERSION_NOT_PENDING');
  assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion({ state: 'REJECTED' }), actor: USERS.manager, decision: 'REJECT', reason: 'r' })), 'VERSION_NOT_PENDING');
});
test('cf decide: the gate is approval-eligible — BYR, DTA, VWR never decide a factor change', () => {
  for (const u of [USERS.buyer, USERS.analyst, USERS.viewer]) {
    assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion(), actor: u, decision: 'APPLY' })), 'NOT_ELIGIBLE_DECIDER', u.role);
  }
  for (const u of [USERS.origin, USERS.manager, USERS.senior]) {
    assert.ok(decideCfVersion({ version: cfVersion(), actor: u, decision: 'APPLY' }).ok, u.role);
  }
});
test('cf decide: a user-requested version is never decided by its requester; pipeline-staged (null) may be decided by any eligible', () => {
  const userRequested = cfVersion({ requestedBy: USERS.senior.userId });
  assert.strictEqual(denialCode(decideCfVersion({ version: userRequested, actor: USERS.senior, decision: 'APPLY' })), 'SOD_DECIDER_IS_REQUESTER');
  assert.ok(decideCfVersion({ version: userRequested, actor: USERS.manager, decision: 'APPLY' }).ok);
  assert.ok(decideCfVersion({ version: cfVersion({ requestedBy: null }), actor: USERS.manager, decision: 'APPLY' }).ok);
});
test('cf decide: rejecting is a decision too — reason required, same gate', () => {
  assert.ok(decideCfVersion({ version: cfVersion(), actor: USERS.manager, decision: 'REJECT', reason: 'wrong factor — master confirmed 12' }).ok);
  assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion(), actor: USERS.manager, decision: 'REJECT', reason: '' })), 'MISSING_REASON');
  assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion(), actor: USERS.buyer, decision: 'REJECT', reason: 'r' })), 'NOT_ELIGIBLE_DECIDER');
});
test('cf decide: an unknown decision refuses', () => {
  assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion(), actor: USERS.manager, decision: 'MAYBE' })), 'INVALID_DECISION');
});
test('cf decide: the core refuses what the trigger cannot see — an unfit target never applies (CF_INVALID)', () => {
  assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion({ toValue: 0 }), actor: USERS.manager, decision: 'APPLY' })), 'CF_INVALID');
  assert.strictEqual(denialCode(decideCfVersion({ version: cfVersion({ toValue: -2 }), actor: USERS.manager, decision: 'APPLY' })), 'CF_INVALID');
});
test('cf decide: every refusal is a Class-D denial record naming the entity', () => {
  const d = decideCfVersion({ version: cfVersion(), actor: USERS.buyer, decision: 'APPLY' }).denial;
  assert.strictEqual(d.class, 'D');
  assert.strictEqual(d.outcome, 'denied');
  assert.strictEqual(d.entity, 'item_cf_version');
  assert.strictEqual(d.action, 'item_cf_version.apply');
  assert.strictEqual(d.reason, 'NOT_ELIGIBLE_DECIDER');
});

/* ---- deriveRederiveTasks: the third audit leg ------------------------------ */
function sealRow(ref, basis) { return { ref, sizingBasis: basis }; }
const SEAL = {
  refs: [
    sealRow('R-B', [{ sku: 'SKU-2', conversionFactor: 24 }]),          // already on the new basis
    sealRow('R-A', [{ sku: 'SKU-1', conversionFactor: 12 }, { sku: 'SKU-1B', conversionFactor: null }]), // stale + identity member
    sealRow('R-OLD', undefined),                                        // pre-§14.13b seal — nothing to compare
  ],
};
test('cf derive: no seal — nothing is in flight, the change applies with no tasks', () => {
  const r = deriveRederiveTasks(null, cfVersion());
  assert.deepStrictEqual(r, { tasks: [], refsAffected: 0, refsUnaffected: 0 });
});
test('cf derive: one WARN task per affected ref naming ref, skus and the from→to delta; matching and identity members never task', () => {
  const r = deriveRederiveTasks(SEAL, cfVersion({ from: '12', to: '24' }));
  assert.strictEqual(r.refsAffected, 1);
  assert.strictEqual(r.refsUnaffected, 2);
  assert.strictEqual(r.tasks.length, 1);
  const t = r.tasks[0];
  assert.strictEqual(t.type, 'DATA_HEALTH');
  assert.strictEqual(t.field, 'conversion_factor');
  assert.strictEqual(t.severity, 'WARN');
  assert.ok(t.detail.includes('R-A'));
  assert.ok(t.detail.includes('SKU-1'));
  assert.ok(t.detail.includes('12 → 24'));
});
test('cf derive: deterministic — sorted by ref, stable across runs', () => {
  const two = { refs: [sealRow('R-Z', [{ sku: 'S1', conversionFactor: 1 }]), sealRow('R-A', [{ sku: 'S2', conversionFactor: 2 }])] };
  const r1 = deriveRederiveTasks(two, cfVersion({ from: '1', to: '9' }));
  const r2 = deriveRederiveTasks(two, cfVersion({ from: '1', to: '9' }));
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(r1.tasks.length, 2);
  assert.ok(r1.tasks[0].detail.includes('R-A') && r1.tasks[1].detail.includes('R-Z'));
});
test('cf derive: malformed shapes refuse by name — a seal without refs is a wiring error, never an empty walk', () => {
  assert.throws(() => deriveRederiveTasks({}, cfVersion()), /WIRING_MALFORMED/);
  assert.throws(() => deriveRederiveTasks([], cfVersion()), /WIRING_MALFORMED/);
  assert.throws(() => deriveRederiveTasks(SEAL, null), /WIRING_MALFORMED/);
  assert.throws(() => deriveRederiveTasks(SEAL, cfVersion({ toValue: 0 })), /WIRING_MALFORMED/);
  assert.throws(() => deriveRederiveTasks({ refs: [42] }, cfVersion()), /WIRING_MALFORMED/);
});

console.log(`\n  approval: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
