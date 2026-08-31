'use strict';
/* ============================================================================
 * M10 FX fail-safe — the staleness alarm channel, named proof `ops/fx-stale`.
 * THE AUDIT'S NAMED ACCEPTANCE TEST (SENTINEL_DEEP_TECHNICAL_AUDIT M10 [S]):
 * "Fix: fail-safe policy (continue on last pinned rate, mark all derived
 * money stale-visible, alarm); source of record named. Acceptance test:
 * ops/fx-stale.spec."
 *
 * Contract: build spec §14.17 + ADR-0003 §4 + DAT-06 (owner DTA, daily,
 * target 100%). Under test:
 *  - a CURRENT pin (exact day) → no alarm, silent by honesty (the target is
 *    met; an alarm would be noise, and noise trains operators to ignore);
 *  - a STALE pin (latest < the day) → FX_STALE alarm + DATA_HEALTH task +
 *    banner naming staleDays and the pinnedFor day — staleness is alarmed,
 *    NOT graded (DAT-06's target is 100% daily coverage; any fallback is a
 *    breach of a daily SLO; the age is disclosed, never excused);
 *  - NEVER_PINNED → FX_NEVER_PINNED, naming the refusing consequence (USD
 *    rows quarantine RATE_NOT_PINNED), with the coverage value null (no
 *    silent number — an uncovered day has no honest coverage value);
 *  - future pins are NOT candidates (tomorrow's rate must not excuse
 *    today's gap) and are not errors either (the job may pin ahead);
 *  - determinism + the fail-closed refusals (malformed day/table throw).
 * ==========================================================================*/
const assert = require('assert');
const ops = require('../index');
const { evaluateFxStaleness, STATES, ALARM_CODES, FX_ID, FX_OWNER } = ops.fx;

let passed = 0, failed = 0;
function test(name, fn){ try { fn(); passed++; console.log('  ✓ ' + name); }
  catch(e){ failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

console.log('\nM10 — the FX staleness alarm channel (ops/fx-stale, the audit\'s named test)');

const PIN_TODAY = { usdToLocalByDay: { '2026-08-30': 0.376 } };
const PIN_LATE = { usdToLocalByDay: { '2026-08-27': 0.375 } };

test('a current pin is silent: state CURRENT, no alarm, DAT-06 at 0 stale days', () => {
  const r = evaluateFxStaleness({ asOfDay: '2026-08-30', pins: PIN_TODAY });
  assert.strictEqual(r.state, STATES.CURRENT);
  assert.strictEqual(r.alarm, null);
  assert.deepStrictEqual(r.latestPin, { day: '2026-08-30', staleDays: 0 });
  assert.strictEqual(r.dat06.id, FX_ID);
  assert.strictEqual(r.dat06.value, 0);
  assert.strictEqual(r.dat06.owner, FX_OWNER);
});
test('a late pin raises FX_STALE: the task names staleDays and the pinnedFor day, owner DTA', () => {
  const r = evaluateFxStaleness({ asOfDay: '2026-08-30', pins: PIN_LATE });
  assert.strictEqual(r.state, STATES.STALE);
  assert.strictEqual(r.alarm.code, ALARM_CODES.FX_STALE);
  assert.strictEqual(r.alarm.staleDays, 3);
  assert.strictEqual(r.alarm.owner, 'DTA');
  assert.strictEqual(r.alarm.task.type, 'DATA_HEALTH');
  assert.strictEqual(r.alarm.task.field, 'fx.pinCoverage');
  assert.ok(r.alarm.task.detail.includes('3 day(s)'));
  assert.ok(r.alarm.task.detail.includes('2026-08-27'));
  assert.ok(r.alarm.banner.text.includes('stale'));
  assert.strictEqual(r.dat06.value, 3);
  assert.strictEqual(r.dat06.state, STATES.STALE);
});
test('the fallback picks the LATEST pin ≤ the day — an older pin beside it changes nothing', () => {
  const r = evaluateFxStaleness({ asOfDay: '2026-08-30', pins: { usdToLocalByDay: { '2026-08-20': 0.37, '2026-08-29': 0.3765 } } });
  assert.strictEqual(r.state, STATES.STALE);
  assert.strictEqual(r.alarm.staleDays, 1);
  assert.strictEqual(r.latestPin.day, '2026-08-29');
});
test('never pinned: FX_NEVER_PINNED names the refusing consequence; the coverage value is null (no silent number)', () => {
  const r = evaluateFxStaleness({ asOfDay: '2026-08-30', pins: { usdToLocalByDay: {} } });
  assert.strictEqual(r.state, STATES.NEVER_PINNED);
  assert.strictEqual(r.alarm.code, ALARM_CODES.FX_NEVER_PINNED);
  assert.ok(r.alarm.task.detail.includes('RATE_NOT_PINNED'));
  assert.strictEqual(r.latestPin, null);
  assert.strictEqual(r.dat06.value, null);
  assert.strictEqual(r.dat06.state, STATES.NEVER_PINNED);
});
test('a FUTURE pin is not a candidate and not an error — tomorrow\'s rate must not excuse today\'s gap', () => {
  const r = evaluateFxStaleness({ asOfDay: '2026-08-30', pins: { usdToLocalByDay: { '2026-08-31': 0.4 } } });
  assert.strictEqual(r.state, STATES.NEVER_PINNED);
  const r2 = evaluateFxStaleness({ asOfDay: '2026-08-30', pins: { usdToLocalByDay: { '2026-08-31': 0.4, '2026-08-28': 0.374 } } });
  assert.strictEqual(r2.state, STATES.STALE);          // the future pin is ignored, the earlier one decides
  assert.strictEqual(r2.alarm.staleDays, 2);
});
test('refusals: malformed asOfDay and malformed pins throw (fail-closed wiring posture)', () => {
  assert.throws(() => evaluateFxStaleness({ asOfDay: '2026-8-30', pins: PIN_TODAY }), /INVALID_ASODAY/);
  assert.throws(() => evaluateFxStaleness({ asOfDay: '2026-08-30', pins: null }), TypeError);
  assert.throws(() => evaluateFxStaleness({ asOfDay: '2026-08-30', pins: { usdToLocalByDay: { 'bad': 1 } } }), TypeError);
  assert.throws(() => evaluateFxStaleness(null), /INVALID_ASODAY/);
});
test('determinism: identical inputs → deep-equal outputs, JSON round-trip stable', () => {
  const a = evaluateFxStaleness({ asOfDay: '2026-08-30', pins: PIN_LATE });
  const b = evaluateFxStaleness({ asOfDay: '2026-08-30', pins: PIN_LATE });
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
