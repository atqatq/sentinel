'use strict';
/* ============================================================================
 * Scorecard adapter (stub client) — the SQL mechanics of the §14.6f rollup
 * door (scorecard-adapter.js; the §16.1 Class-S "scorecard rollup" event)
 * without a database. The LIVE proof (scorecard-live.js) walks the real door
 * in CI; this suite pins the statement shapes, the boundary validations and
 * the fail-closed discipline that the live proof then re-proves against real
 * PostgreSQL:
 *   - statement-first: a malformed event sends ZERO statements — every
 *     §14.6f payload rule (class S, action SCORECARD_REBUILT, entity
 *     supplier_scorecard, entityId the canonical asOf, before null, after
 *     {asOf, suppliers, dueLines, pastPromiseDue}, the trigger in reason,
 *     the L-07 stamps present) refuses by name BEFORE the ledger is touched;
 *   - the payload travels UNCHANGED (the D-029 posture): the block the door
 *     appends is the pure layer's event, never a re-shaped fork;
 *   - the system envelope: actor 'system', role null (§16.1 Class S); a
 *     manual trigger's operator rides onBehalfOf (a uuid, 0004's posture);
 *   - the unarmed adapter exposes NO recordRebuild — the deployment refuses
 *     loudly (TypeError), never silently unlogged (an unlogged machine write
 *     is §16.1's blind spot).
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const DB = require(path.join(REPO, 'packages', 'db'));
const F = require(path.join(REPO, 'packages', 'core', 'modules', 'execution-feedback', 'src', 'feedback.js'));

const KEY = 'stub-hmac-key-0123456789abcdef-0123456789abcdef';
const T1 = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '22222222-2222-4222-8222-222222222222'; // on_behalf_of is UUID-typed (0004)

/* A real event from the PURE layer — the door is fed what the decision
 * layer yields, never a hand-made block. */
function pureEvent() {
  const { event } = F.rebuildScorecard(
    { lines: [{
      poNumber: 'PO-B', sku: 'FLOUR-1', status: 'OPEN', supplier: 'Maziwa Fresh',
      expectedDelivery: '2026-08-10', orderedAmended: 50, receivedQty: 0,
      returnedQty: 0, netReceived: 0, openQty: 50, fillRate: 0,
      flags: [], refIds: ['R1'], reconciliations: [],
    }] },
    { asOf: '2026-09-01', trigger: 'schedule', jobId: 'scorecard-nightly',
      engineVersion: '9.9.9', schemaVersion: '0009' });
  return event;
}

/* The stub client: records every statement; answers the ledger append. */
function stubClient() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      if (/pg_advisory_xact_lock/.test(norm)) return { rows: [], rowCount: 0 };
      if (/ORDER BY seq DESC LIMIT 1/.test(norm)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO ledger_block/.test(norm)) {
        return { rows: [{ seq: values[0], prevHash: values[18], hash: 'c'.repeat(64), at: new Date(Date.UTC(2026, 8, 1, 9, 0, 0, 0)) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed += 1; }
};
const refuses = (code, fn) => {
  try { fn(); return `expected ${code}, nothing threw`; }
  catch (e) { return e.message.includes(code) ? null : `expected ${code}, got: ${e.message}`; }
};

console.log('\nThe §14.6f rollup door — statement-first refusals (stub tier)');

test('the armed door appends the pure event UNCHANGED and returns the chain receipt', async () => {
  const client = stubClient();
  const door = DB.makeScorecardAdapter(client, T1, { ledger: { hmacKey: KEY } });
  const out = await door.recordRebuild(pureEvent());
  assert.strictEqual(out.recorded, true);
  assert.strictEqual(out.seq, 1, 'genesis append — seq 1 from the stub tail');
  const ins = client.calls.find((c) => c.text.startsWith('INSERT INTO ledger_block'));
  assert.ok(ins, 'exactly the ledger INSERT — no other statement');
  assert.strictEqual(ins.values[1], 'S', 'class');
  assert.strictEqual(ins.values[8], 'supplier_scorecard', 'entity');
  assert.strictEqual(ins.values[9], '2026-09-01', 'entityId = the asOf');
  assert.strictEqual(ins.values[10], 'SCORECARD_REBUILT', 'action');
  assert.strictEqual(ins.values[11], 'success', 'outcome');
  assert.strictEqual(ins.values[12], null, 'before — a rollup writes no business value');
  assert.deepStrictEqual(ins.values[13], { asOf: '2026-09-01', suppliers: ['Maziwa Fresh'], dueLines: 1, pastPromiseDue: 1 });
  assert.ok(ins.values[14].includes('trigger=schedule'), 'the trigger rides the reason');
  assert.strictEqual(ins.values[3], 'system', 'actor system (§16.1 Class S)');
  assert.strictEqual(ins.values[5], null, 'role null — only the system may');
});

test('a manual trigger rides onBehalfOf — the human attribution never lost', async () => {
  const client = stubClient();
  const door = DB.makeScorecardAdapter(client, T1, { ledger: { hmacKey: KEY } });
  await door.recordRebuild(pureEvent(), { onBehalfOf: OPERATOR });
  const ins = client.calls.find((c) => c.text.startsWith('INSERT INTO ledger_block'));
  assert.strictEqual(ins.values[4], OPERATOR, 'onBehalfOf carries the operator');
});

test('statement-first: a malformed payload refuses BEFORE any statement', async () => {
  const client = stubClient();
  const door = DB.makeScorecardAdapter(client, T1, { ledger: { hmacKey: KEY } });
  const base = pureEvent();
  const variants = [
    ['EVENT_REQUIRED', () => door.recordRebuild(null)],
    ['EVENT_CLASS_INVALID', () => door.recordRebuild({ ...base, class: 'W' })],
    ['EVENT_ACTION_INVALID', () => door.recordRebuild({ ...base, action: 'FX_PIN' })],
    ['EVENT_ENTITY_INVALID', () => door.recordRebuild({ ...base, entity: 'fx_rate_pin' })],
    ['EVENT_ASOF_INVALID', () => door.recordRebuild({ ...base, entityId: '09/01/2026' })],
    ['EVENT_BEFORE_INVALID', () => door.recordRebuild({ ...base, before: { x: 1 } })],
    ['EVENT_AFTER_INVALID', () => door.recordRebuild({ ...base, after: { ...base.after, suppliers: 'all' } })],
    ['EVENT_AFTER_INVALID', () => door.recordRebuild({ ...base, after: { ...base.after, asOf: '2026-09-02' } })],
    ['EVENT_TRIGGER_REQUIRED', () => door.recordRebuild({ ...base, reason: 'because' })],
    ['EVENT_STAMPS_REQUIRED', () => door.recordRebuild({ ...base, engineVersion: null })],
    ['EVENT_STAMPS_REQUIRED', () => door.recordRebuild({ ...base, schemaVersion: undefined })],
    ['OPERATOR_INVALID', () => door.recordRebuild(pureEvent(), { onBehalfOf: '   ' })],
  ];
  for (const [code, fn] of variants) {
    const err = refuses(code, fn);
    assert.strictEqual(err, null, `${code}: ${err}`);
  }
  assert.strictEqual(client.calls.length, 0, 'ZERO statements for every refusal — statement-first');
});

test('the unarmed adapter exposes NO recordRebuild — either armed or loud', () => {
  const door = DB.makeScorecardAdapter(stubClient(), T1, {});
  assert.strictEqual(door.recordRebuild, undefined, 'the deployment refuses loudly, never silently unlogged');
  const noOpts = DB.makeScorecardAdapter(stubClient(), T1);
  assert.strictEqual(noOpts.recordRebuild, undefined);
});

test('the tenant fence is required', () => {
  assert.throws(() => DB.makeScorecardAdapter(stubClient(), ''), /SCORECARD_TENANT_REQUIRED/);
});

console.log(`\nscorecard-adapter (stub): ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
