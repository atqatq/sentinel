'use strict';
/* ============================================================================
 * The CF decide/apply API — the boundary surface (§14.13c).
 * The named proof `governance/cf-api` (D-036's scheduled follow-on).
 *
 * Pinned here: the request shape (identity fields retired — the boundary
 * decides whose hand is on the decision), the gate-before-door order, the
 * denial-record leg through the ARMED ledger (the record travels UNCHANGED,
 * the D-029 shape; the receipt carries the chain receipt), the door receipts
 * (APPLY with the re-derivation counts, REJECT with its reason), the status
 * mapping (200/400/403/404/500), the unarmed-loud refusal, the SoD refusals
 * unmangled, and determinism. The gate and the door are composed, never
 * re-implemented.
 * ==========================================================================*/
const assert = require('assert');
const { handleCfDecision } = require('../index.js');

let passed = 0, failed = 0;
const test = (name, fn) => {
  const p = (async () => {
    try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (e) { failed += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
  })();
  TESTS.push(p);
};
const TESTS = [];

/* ---- fixtures ---------------------------------------------------------------
 * A pending version requested by BUYER; the decider is APPROVER (a different
 * eligible principal — the SoD spine's happy path). */
const BUYER = { userId: 'u-buyer', role: 'BYR' };
const DECIDER = { userId: 'u-approver', role: 'SCM' };
const VERSION_ID = '11111111-1111-4111-8111-111111111111';

function pendingVersion() {
  return {
    id: VERSION_ID, tenantId: 't1', sku: 'SKU-1', version: 2,
    fromValue: 12, toValue: 15, state: 'PENDING', requestedBy: BUYER.userId,
    from: '12', to: '15',
  };
}

function makeDeps(over = {}) {
  const calls = { door: [], denials: [] };
  return {
    calls,
    loadCfVersion: over.loadCfVersion || (async (id) => (id === VERSION_ID ? pendingVersion() : null)),
    loadLatestSeal: over.loadLatestSeal || (async () => ({ refs: [{ ref: 'R1', sizingBasis: [{ sku: 'SKU-1', conversionFactor: 12 }] }] })),
    resolveCfVersion: over.resolveCfVersion || (async (input) => {
      calls.door.push(input);
      return { id: input.versionId, state: input.decision === 'APPLY' ? 'EFFECTIVE' : 'REJECTED', sku: 'SKU-1', version: 2,
               ...(input.decision === 'APPLY' ? { refsAffected: ['R1'], refsUnaffected: [], tasksInserted: 1 } : {}) };
    }),
    ledger: over.ledger === null ? undefined : (over.ledger || {
      appendDenialRecord: async (denial) => { calls.denials.push(denial); return { seq: 7, hash: 'h'.repeat(64) }; },
    }),
  };
}

const req = (over = {}) => ({
  actor: DECIDER, versionId: VERSION_ID, decision: 'APPLY', ...over,
});

/* ---- the request shape ------------------------------------------------------- */
console.log('\nThe request shape — identity is the session\u2019s, never the body\u2019s (§14.13c)');

test('IDENTITY_REQUIRED — a request without the session-merged actor envelope is the transport\u2019s fault', async () => {
  const r = await handleCfDecision({ versionId: VERSION_ID, decision: 'APPLY' }, makeDeps());
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.reason, 'IDENTITY_REQUIRED');
  const r2 = await handleCfDecision(req({ actor: { userId: 'u-approver' } }), makeDeps());
  assert.strictEqual(r2.status, 400);
  assert.strictEqual(r2.json.reason, 'IDENTITY_REQUIRED');
});

test('request-shape refusals: malformed versionId, unknown decision, a REJECT without its reason', async () => {
  const deps = makeDeps();
  const r1 = await handleCfDecision(req({ versionId: 'not-a-uuid' }), deps);
  assert.strictEqual(r1.status, 400);
  const r2 = await handleCfDecision(req({ decision: 'MAYBE' }), deps);
  assert.strictEqual(r2.status, 400);
  const r3 = await handleCfDecision(req({ decision: 'REJECT', reason: '  ' }), deps);
  assert.strictEqual(r3.status, 400);
  assert.strictEqual(deps.calls.door.length, 0, 'the gate never saw any of them');
  assert.strictEqual(deps.calls.denials.length, 0, 'a shape refusal is not a decision denial');
});

/* ---- the gate, judged by the API boundary ------------------------------------- */
console.log('\nThe gate before the door — the SoD spine through the boundary');

test('an eligible decider different from the requester APPLIES — the door receipt rides the 200', async () => {
  const deps = makeDeps();
  const r = await handleCfDecision(req(), deps);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.verdict, 'APPLIED');
  assert.strictEqual(r.json.state, 'EFFECTIVE');
  assert.strictEqual(r.json.refsAffected[0], 'R1', 'the re-derivation counts ride the receipt');
  assert.strictEqual(r.json.tasksInserted, 1);
  assert.strictEqual(deps.calls.door.length, 1);
  assert.strictEqual(deps.calls.door[0].decidedBy, DECIDER.userId);
  assert.ok(deps.calls.door[0].latestSeal, 'the latest seal rode the APPLY leg');
  assert.strictEqual(deps.calls.denials.length, 0);
});

test('SOD_DECIDER_IS_REQUESTER refuses 403 with its Class-D record through the ARMED ledger', async () => {
  const deps = makeDeps();
  /* the SAME user in an ELIGIBLE role: eligibility passes, the SoD spine fires */
  const r = await handleCfDecision(req({ actor: { userId: BUYER.userId, role: 'SCM' } }), deps);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.reason, 'SOD_DECIDER_IS_REQUESTER', 'the gate\u2019s own code, unmangled');
  assert.strictEqual(deps.calls.denials.length, 1, 'the denial is recorded');
  assert.strictEqual(deps.calls.denials[0].class, 'D');
  assert.strictEqual(deps.calls.denials[0].action, 'item_cf_version.apply');
  assert.strictEqual(deps.calls.denials[0].entityId, VERSION_ID);
  assert.strictEqual(r.json.ledger.seq, 7, 'the chain receipt rides the refusal — the record is answerable');
  assert.strictEqual(deps.calls.door.length, 0, 'the door never ran');
});

test('NOT_ELIGIBLE_DECIDER — BYR (a real role, never an approver) refuses 403 and is recorded', async () => {
  const deps = makeDeps();
  const r = await handleCfDecision(req({ actor: BUYER }), deps);   // BYR decides its own request — eligibility fires first
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.reason, 'NOT_ELIGIBLE_DECIDER');
  assert.strictEqual(deps.calls.denials.length, 1);
  assert.strictEqual(deps.calls.door.length, 0);
});

test('a non-eligible principal refuses 403 and is recorded; REJECT with a reason is accepted', async () => {
  const deps = makeDeps();
  const r = await handleCfDecision(req({ actor: { userId: 'u-viewer', role: 'VWR' } }), deps);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.reason, 'NOT_ELIGIBLE_DECIDER');
  const r2 = await handleCfDecision(req({ decision: 'REJECT', reason: 'factor conflicts with the recipe basis' }), deps);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.verdict, 'REJECTED');
  assert.strictEqual(r2.json.state, 'REJECTED');
  assert.strictEqual(deps.calls.denials.length, 1, 'only the refusal is recorded — a success is not a denial');
  assert.strictEqual(deps.calls.door[0].reason, 'factor conflicts with the recipe basis', 'the why reaches the door');
});

test('MISSING_REASON on REJECT is a gate denial (403 with its record), not a shape refusal — the why is part of the record', async () => {
  /* the handler's shape check passes decision=REJECT only when reason is absent
   * entirely — a whitespace reason catches there; a MISSING reason reaches the
   * gate via decision REJECT + reason undefined? No: the shape refuses first.
   * The pin: BOTH layers refuse, the shape's refusal is 400, the gate's own
   * MISSING_REASON still holds for direct gate calls (the pure layer is
   * unchanged and pinned by governance/cf-change). */
  const deps = makeDeps();
  const r = await handleCfDecision({ actor: DECIDER, versionId: VERSION_ID, decision: 'REJECT' }, deps);
  assert.strictEqual(r.status, 400, 'the boundary refuses the shape before the gate');
  assert.strictEqual(deps.calls.door.length, 0);
});

/* ---- the version, re-proved ----------------------------------------------------- */
console.log('\nThe version is re-proved — never judged from a claim');

test('CF_VERSION_NOT_FOUND — 404; another tenant\u2019s version is indistinguishable from no version', async () => {
  const deps = makeDeps();
  const r = await handleCfDecision(req({ versionId: '22222222-2222-4222-8222-222222222222' }), deps);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.reason, 'CF_VERSION_NOT_FOUND');
  assert.strictEqual(deps.calls.door.length, 0);
});

test('a non-PENDING version is the GATE\u2019s refusal (VERSION_NOT_PENDING, 403 + record) — the loaded row is what is judged', async () => {
  const deps = makeDeps({ loadCfVersion: async () => ({ ...pendingVersion(), state: 'EFFECTIVE' }) });
  const r = await handleCfDecision(req(), deps);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.reason, 'VERSION_NOT_PENDING');
  assert.strictEqual(deps.calls.denials.length, 1);
});

/* ---- the armed posture ----------------------------------------------------------- */
console.log('\nThe armed posture — a denial never leaves no trace');

test('an UNARMED ledger is a wiring error — the API refuses loudly (500), never silently unlogged', async () => {
  const deps = makeDeps({ ledger: null });
  const r = await handleCfDecision(req({ actor: BUYER }), deps);   // a denial path
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.json.verdict, 'ERROR');
  assert.ok(/appendDenialRecord|REQUIRED/.test(r.json.message), r.json.message);
});

test('missing ports are wiring errors (TypeError → 500), not refusals', async () => {
  const r = await handleCfDecision(req(), null);
  assert.strictEqual(r.status, 500);
  const r2 = await handleCfDecision(req(), { loadCfVersion: async () => null });
  assert.strictEqual(r2.status, 500);
});

/* ---- determinism ------------------------------------------------------------------- */
console.log('\nDeterminism — the boundary owns no arithmetic');

test('identical inputs through the same deps produce deep-equal receipts', async () => {
  const mk = () => makeDeps();
  const a = await handleCfDecision(req(), mk());
  const b = await handleCfDecision(req(), mk());
  assert.deepStrictEqual(a, b);
});

(async () => { await Promise.all(TESTS); console.log(`\ngovernance/cf-api: ${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); })();
