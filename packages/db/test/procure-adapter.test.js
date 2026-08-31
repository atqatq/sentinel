'use strict';
/* ============================================================================
 * Procure adapter — structural proof WITHOUT a database (stub client).
 *
 * The live half (real PostgreSQL: the RESTRICTIVE SoD policy, the state-guard
 * and freeze triggers, RLS) is packages/db/test/sod-live.js in the db-rls
 * job. THIS suite pins what a stub can see: the statement sequences (raise =
 * head + one line INSERT each; convert = PO → lines → advance, all built
 * before the first issue), the explicit tenant predicates on every statement,
 * the resolveHold(APPLY) GUC ordering (hold_apply_id set BEFORE the supplier
 * UPDATE — the only door through the freeze), and the fail-closed refusals.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');
const { makeProcureAdapter } = require(path.join(__dirname, '..', 'procure-adapter'));
const DB = require(path.join(__dirname, '..', 'index.js'));

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  const pass = () => { passed++; console.log('  ✓ ' + name); };
  const fail = (e) => { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); };
  let out;
  try { out = fn(); } catch (e) { fail(e); return; }
  if (out && typeof out.then === 'function') pending.push(out.then(pass, fail));
  else pass();
}

/* Stub client: records every statement; SELECTs return scripted rows. */
function stubClient({ proposalRow = null, controls = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      if (/FROM approval_config/i.test(text)) return { rows: controls ? [controls.config] : [], rowCount: controls ? 1 : 0 };
      if (/FROM approval_limit/i.test(text)) return { rows: controls ? controls.limits : [], rowCount: controls ? controls.limits.length : 0 };
      if (/FROM proposal WHERE/i.test(text) && /RETURNING/i.test(text) === false) {
        return proposalRow ? { rows: [proposalRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO proposal /i.test(text)) {
        return { rows: [{ id: 'p-uuid', code: values[1], state: 'OPEN', raisedBy: values[2] }], rowCount: 1 };
      }
      if (/INSERT INTO purchase_order/i.test(text)) return { rows: [{ id: 'po-uuid', code: values[1] }], rowCount: 1 };
      if (/UPDATE proposal SET state/i.test(text)) return { rows: [{ id: 'p-uuid', state: values[2] }], rowCount: 1 };
      if (/UPDATE supplier_change_hold/i.test(text)) return { rows: [{ id: 'h-uuid', state: 'APPLIED' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
}

const T = '11111111-1111-4111-8111-111111111111';
const U = { buyer: 'u-buyer', senior: 'u-senior', manager: 'u-manager' };
const DELTA = {
  external_id: { from: 'S-100', to: 'S-100' },
  name: { from: 'Old Name', to: 'New Name' },
  payment_term_days: { from: '45', to: '45' },
  payment_terms_text: { from: 'SOA +45 Days', to: 'SOA +45 Days' },
  currency_code: { from: 'BHD', to: 'BHD' },
};

console.log('\nThe adapter is tenant-fenced and statement-first');

test('SCHEMA_VERSION tracks the highest applied migration (0003)', () => {
  assert.strictEqual(DB.SCHEMA_VERSION, '0003');
});

test('every statement carries the explicit tenant predicate or parameter', async () => {
  const c = stubClient();
  const a = makeProcureAdapter(c, T);
  await a.loadControls();
  await a.loadProposalByCode('PR-1');
  for (const call of c.calls) {
    assert.ok(call.values.includes(T) || /\$1/.test(call.text), 'unfenced statement: ' + call.text);
  }
  assert.ok(c.calls.every((x) => /tenant_id = \$1/.test(x.text)), 'reads must lead with the tenant predicate');
});

test('raiseProposal builds head + every line INSERT before the first issue', async () => {
  const c = stubClient();
  const a = makeProcureAdapter(c, T);
  await a.raiseProposal({
    code: 'PR-1', raisedBy: U.buyer, currencyCode: 'BHD', totalAmount: 500,
    lines: [{ sku: 'SKU-1', qty: 10, unitCode: 'CTN', unitPrice: 12.5 }, { sku: 'SKU-2', qty: 1, unitCode: 'PCS', unitPrice: 375 }],
  });
  const inserts = c.calls.filter((x) => /INSERT INTO proposal/.test(x.text));
  assert.strictEqual(inserts.length, 3, 'one head + two lines');
  const line2 = c.calls[c.calls.length - 1];
  assert.ok(/INSERT INTO proposal_line/.test(line2.text), 'lines issue after the head');
  assert.strictEqual(line2.values[1], 'p-uuid', 'line INSERTs carry the RETURNING head id');
});

test('raiseProposal refuses a malformed intent with ZERO statements issued', async () => {
  const c = stubClient();
  const a = makeProcureAdapter(c, T);
  await assert.rejects(() => a.raiseProposal({ code: '', raisedBy: U.buyer, currencyCode: 'BHD', totalAmount: 500, lines: [{ sku: 's', qty: 1, unitCode: 'PCS', unitPrice: 1 }] }), /INVALID_PROPOSAL_INTENT/);
  await assert.rejects(() => a.raiseProposal({ code: 'PR-2', raisedBy: U.buyer, currencyCode: 'BHD', totalAmount: 500, lines: [] }), /INVALID_PROPOSAL_INTENT/);
  assert.strictEqual(c.calls.length, 0, 'nothing reached the database');
});

test('recordApproval issues exactly one INSERT with the decision and its reason', async () => {
  const c = stubClient();
  const a = makeProcureAdapter(c, T);
  await a.recordApproval({ proposalId: 'p-uuid', approverId: U.manager, decision: 'APPROVED', reason: 'ok' });
  assert.strictEqual(c.calls.length, 1);
  assert.ok(/INSERT INTO approval/.test(c.calls[0].text));
  assert.deepStrictEqual(c.calls[0].values, [T, 'p-uuid', U.manager, 'APPROVED', 'ok']);
});

test('convertProposal issues PO → lines → state advance, in that order, and only from APPROVED', async () => {
  const c = stubClient({ proposalRow: { id: 'p-uuid', state: 'APPROVED', supplierId: 's-1', currencyCode: 'BHD', totalAmount: 500 } });
  const a = makeProcureAdapter(c, T);
  await a.convertProposal({
    proposalId: 'p-uuid', poCode: 'PO-100', convertedBy: U.senior,
    lines: [{ sku: 'SKU-1', qty: 10, unitCode: 'CTN', unitPrice: 12.5 }],
  });
  const kinds = c.calls.map((x) => (/INSERT INTO purchase_order/.test(x.text) ? 'po'
    : /INSERT INTO po_line/.test(x.text) ? 'line'
    : /UPDATE proposal/.test(x.text) ? 'advance' : 'other'));
  assert.deepStrictEqual(kinds.filter((k) => k !== 'other'), ['po', 'line', 'advance']);
  const poCall = c.calls.find((x) => /INSERT INTO purchase_order/.test(x.text));
  assert.strictEqual(poCall.values[2], 'p-uuid', 'the PO is bound to its proposal (UNIQUE proposal_id)');
});

test('convertProposal refuses a proposal that is not APPROVED with zero writes', async () => {
  const c = stubClient({ proposalRow: null });
  const a = makeProcureAdapter(c, T);
  await assert.rejects(() => a.convertProposal({ proposalId: 'p-x', poCode: 'PO-1', convertedBy: U.senior, lines: [] }), /PROPOSAL_NOT_APPROVED/);
  assert.strictEqual(c.calls.filter((x) => /INSERT INTO purchase_order/.test(x.text)).length, 0);
});

test('advanceProposal is explicit about the FROM state — the trigger does the rest', async () => {
  const c = stubClient({ proposalRow: { id: 'p-uuid', state: 'APPROVED' } });
  const a = makeProcureAdapter(c, T);
  await a.advanceProposal({ proposalId: 'p-uuid', from: 'OPEN', to: 'APPROVED' });
  const upd = c.calls.find((x) => /UPDATE proposal/.test(x.text));
  assert.ok(/state = \$3/.test(upd.text) && /state = \$4/.test(upd.text), 'both TO and FROM are parameters');
  assert.deepStrictEqual(upd.values, [T, 'p-uuid', 'APPROVED', 'OPEN']);
});

console.log('\nThe freeze door: hold_apply_id set BEFORE the supplier moves');

test('resolveHold(APPLY) sets app.hold_apply_id transaction-locally, then updates the supplier to the held delta', async () => {
  const c = stubClient();
  const a = makeProcureAdapter(c, T);
  await a.resolveHold({ holdId: 'h-uuid', supplierId: 's-1', changedFields: DELTA, verifiedBy: U.manager, reference: 'OBV-1', decision: 'APPLY' });
  const guc = c.calls.find((x) => /set_config\('app\.hold_apply_id'/.test(x.text));
  assert.ok(guc, 'the GUC must be set');
  assert.strictEqual(guc.values[0], 'h-uuid');
  const upd = c.calls.find((x) => /UPDATE supplier SET/.test(x.text));
  assert.ok(c.calls.indexOf(guc) < c.calls.indexOf(upd), 'GUC precedes the supplier UPDATE');
  assert.strictEqual(upd.values[3], 'New Name', 'the row moves to the held "to" values');
  assert.ok(/::int/.test(upd.text), 'payment_term_days binds as an integer');
  const stamp = c.calls.find((x) => /UPDATE supplier_change_hold/.test(x.text));
  assert.ok(c.calls.indexOf(upd) < c.calls.indexOf(stamp), 'the hold is stamped APPLIED after the row moved');
});

test('resolveHold(APPLY) refuses without a reference — no statements issued', async () => {
  const c = stubClient();
  const a = makeProcureAdapter(c, T);
  await assert.rejects(() => a.resolveHold({ holdId: 'h-uuid', supplierId: 's-1', changedFields: DELTA, verifiedBy: U.manager, reference: '', decision: 'APPLY' }), /MISSING_VERIFICATION_REFERENCE/);
  assert.strictEqual(c.calls.length, 0);
});

test('resolveHold(REJECT) stamps the hold REJECTED and never touches the supplier row', async () => {
  const c = stubClient();
  const a = makeProcureAdapter(c, T);
  await a.resolveHold({ holdId: 'h-uuid', supplierId: 's-1', changedFields: DELTA, verifiedBy: U.manager, reference: 'declined', decision: 'REJECT' });
  assert.ok(c.calls.every((x) => !/UPDATE supplier /.test(x.text)), 'a rejected hold moves nothing');
  const upd = c.calls.find((x) => /UPDATE supplier_change_hold/.test(x.text));
  assert.ok(/state = 'REJECTED'/.test(upd.text));
});

test('stageSupplierHold stores the delta verbatim (the trigger compares exactly this)', async () => {
  const c = stubClient();
  const a = makeProcureAdapter(c, T);
  await a.stageSupplierHold({ supplierId: 's-1', changedFields: DELTA, requestedBy: null });
  const ins = c.calls[0];
  assert.ok(/INSERT INTO supplier_change_hold/.test(ins.text));
  assert.deepStrictEqual(JSON.parse(ins.values[2]), DELTA);
  assert.strictEqual(ins.values[3], null, 'pipeline-originated holds carry a NULL requester');
});

test('grantRole issues the Origin grant — the RLS policy re-proves the granter', async () => {
  const c = stubClient();
  const a = makeProcureAdapter(c, T);
  await a.grantRole({ userId: U.buyer, role: 'BYR', grantedBy: 'u-origin' });
  const ins = c.calls[0];
  assert.ok(/INSERT INTO tenant_role/.test(ins.text));
  assert.deepStrictEqual(ins.values, [T, U.buyer, 'BYR', 'u-origin']);
});

test('NUMERIC boundary: node-pg ships DECIMAL as strings — the adapter delivers finite numbers (the int8 lesson, pinned)', async () => {
  const c = stubClient();
  const real = c.query;
  c.query = async (text, values) => {
    const out = await real(text, values);
    if (/FROM approval_config/i.test(text)) return { rows: [{ currencyCode: 'BHD', dualThresholdAmount: '1000.000000' }], rowCount: 1 };
    if (/FROM approval_limit/i.test(text)) return { rows: [{ role: 'SBR', maxSingleAmount: '5000.000000' }, { role: 'O', maxSingleAmount: null }], rowCount: 2 };
    if (/FROM proposal WHERE/i.test(text) && !/INSERT/.test(text)) {
      return { rows: [{ id: 'p-uuid', state: 'OPEN', totalAmount: '4000.000000' }], rowCount: 1 };
    }
    return out;
  };
  const a = makeProcureAdapter(c, T);
  const ctl = await a.loadControls();
  assert.strictEqual(typeof ctl.config.dualThresholdAmount, 'number', 'the threshold must be a number at the boundary');
  assert.strictEqual(ctl.config.dualThresholdAmount, 1000);
  assert.strictEqual(ctl.limits[0].maxSingleAmount, 5000);
  assert.strictEqual(ctl.limits[1].maxSingleAmount, null, 'NULL stays null (Origin unlimited) — never 0');
  const p = await a.loadProposalByCode('PR-2');
  assert.strictEqual(typeof p.proposal.totalAmount, 'number');
  assert.strictEqual(p.proposal.totalAmount, 4000);
});

(async () => {
  await Promise.all(pending);

  console.log(`\n  procure-adapter (stub): ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
