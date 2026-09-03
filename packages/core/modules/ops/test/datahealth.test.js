'use strict';
/* ============================================================================
 * The data-health sweep — the unpromised-waiting derivation (§14.6g).
 * The named proof `ops/unpromised-waiting-sweep` (D-033's named follow-on).
 *
 * Pinned here: the guards'-shape task objects (the register's writers
 * consume them verbatim), one WARN task per gapped ref (clean refs yield
 * NOTHING — the register carries gaps, never confirmations), the detail
 * naming the counts, sorted determinism, the refusal family (a ref that
 * never computed supply is not silently healthy), and the JSON round-trip.
 * ==========================================================================*/
const assert = require('assert');
const { unpromisedWaitingTasks, TASK_FIELD_PREFIX } = require('../index.js').datahealth;

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed += 1; }
};
const refuses = (code, fn) => {
  try { fn(); return `expected ${code}, nothing threw`; }
  catch (e) { return e.message.includes(code) ? null : `expected ${code}, got: ${e.message}`; }
};

/* A receipt's refs: two gapped, two clean, in non-sorted order on purpose. */
function refs() {
  return [
    { ref: 'WB-TART-002', supply: { status: 'Follow-up with Supplier', openPO: 10, unpromisedLines: 2, unpromisedWaiting: 40 } },
    { ref: 'WB-CAKE-001', supply: { status: 'Follow-up with Supplier', openPO: 5, unpromisedLines: 1, unpromisedWaiting: 12 } },
    { ref: 'WB-JUICE-003', supply: { status: 'OK', openPO: 0, unpromisedLines: 0, unpromisedWaiting: 0 } },
    { ref: 'WB-ROLL-004', supply: { status: 'Late PO', openPO: 7, unpromisedLines: 0, unpromisedWaiting: 0 } },
  ];
}

console.log('\nThe derivation — one WARN task per gapped ref (§14.6g)');

test('the gapped refs yield tasks in the guards\' verbatim shape; clean refs yield nothing', () => {
  const { tasks, summary } = unpromisedWaitingTasks(refs());
  assert.strictEqual(tasks.length, 2, 'gaps only — the register does not applaud clean refs');
  for (const t of tasks) {
    assert.strictEqual(t.type, 'DATA_HEALTH');
    assert.ok(t.field.startsWith(TASK_FIELD_PREFIX));
    assert.strictEqual(t.severity, 'WARN', 'a missing promise is a data gap, not an outage');
    assert.ok(typeof t.detail === 'string' && t.detail.length > 0);
  }
  assert.deepStrictEqual(tasks.map((t) => t.field), [
    'unpromised-waiting.WB-CAKE-001',
    'unpromised-waiting.WB-TART-002',
  ], 'sorted by field (refId) — deterministic');
  assert.deepStrictEqual(summary, { refs: 4, gapped: 2, unpromisedLines: 3, unpromisedWaiting: 52 });
});

test('the detail NAMES the counts — the register names the gap, never a bare field', () => {
  const { tasks } = unpromisedWaitingTasks(refs());
  const cake = tasks.find((t) => t.field === 'unpromised-waiting.WB-CAKE-001');
  assert.ok(cake.detail.includes('1 open PO line'), cake.detail);
  assert.ok(cake.detail.includes('12 planning units'), cake.detail);
  assert.ok(cake.detail.includes('WB-CAKE-001'), cake.detail);
});

test('refusals — the §14.6c posture: a ref that never computed supply is not silently healthy', () => {
  assert.strictEqual(refuses('REFS_MALFORMED', () => unpromisedWaitingTasks('refs')), null);
  assert.strictEqual(refuses('REFS_MALFORMED', () => unpromisedWaitingTasks(null)), null);
  assert.strictEqual(refuses('REF_MALFORMED', () => unpromisedWaitingTasks([{ supply: {} }])), null);
  assert.strictEqual(refuses('REF_MALFORMED', () => unpromisedWaitingTasks([{ ref: 'X' }])), null);
  assert.strictEqual(refuses('REF_MALFORMED', () => unpromisedWaitingTasks([{ ref: 'X', supply: { unpromisedLines: undefined, unpromisedWaiting: 0 } }])), null);
  assert.strictEqual(refuses('REF_MALFORMED', () => unpromisedWaitingTasks([{ ref: 'X', supply: { unpromisedLines: 1, unpromisedWaiting: 'many' } }])), null);
});

test('determinism — identical inputs are deep-equal and survive a JSON round-trip', () => {
  const a = unpromisedWaitingTasks(refs());
  const b = unpromisedWaitingTasks(refs());
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
});

console.log(`\nops/unpromised-waiting-sweep: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
