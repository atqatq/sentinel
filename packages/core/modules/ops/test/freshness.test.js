'use strict';
/* ============================================================================
 * ops/freshness suite — the M9 freshness SLO + missing-deliveries alarm.
 *
 * Zero dependencies, no clock: every asOf/sealedAt is injected. Every test
 * is named after the requirement it pins (delivery spec §5.1 — the name is
 * the traceability link). The two binding tests (kpi-catalog DAT-01 text,
 * ingestion manifest kinds) are the spec-drift tripwires: the bands and the
 * dataset vocabulary cannot drift from their sources without failing CI.
 * ==========================================================================*/
const assert = require('assert');
const path = require('path');

const OPS = require(path.join(__dirname, '..'));
const F = OPS.freshness;
const ING = require(path.join(__dirname, '..', '..', 'ingestion'));
const KPI = require(path.join(__dirname, '..', '..', 'kpi-catalog'));

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } }

function throwsWith(fn, prefix) {
  try { fn(); } catch (e) {
    assert.ok(String(e.message).startsWith(prefix),
      `expected throw '${prefix}…' but got: ${e.message}`);
    return;
  }
  throw new Error(`expected throw starting '${prefix}' — nothing was thrown`);
}

const HOUR = F.HOUR;
const T0 = 1700000000000;                 // an arbitrary injected "now"
const ASOF = T0 + 100 * HOUR;             // asOf far from real wall-time

const KINDS = ING.DATASET_KINDS;          // canonical order (8 kinds)

/* All eight kinds freshly sealed 5h before asOf; callers override per kind. */
function freshSeals(overrides) {
  const overridesByKind = overrides || {};
  return KINDS.map((kind) => {
    const o = overridesByKind[kind];
    if (o === 'never') return { kind, sealedAt: null };
    return { kind, sealedAt: o === undefined ? ASOF - 5 * HOUR : o };
  });
}

function evalWith(overrides, extra) {
  return F.evaluateFreshness(Object.assign({ asOf: ASOF, seals: freshSeals(overrides) }, extra || {}));
}

/* ---------------------------------------------------------------- bands -- */

test('bands: exactly at the 26h SLO is FRESH; past it is DEGRADED', () => {
  const at26 = evalWith({ items: ASOF - 26 * HOUR });
  const over = evalWith({ items: ASOF - 26 * HOUR - 1 });
  const itemsAt = at26.perDataset.find((e) => e.kind === 'items');
  const itemsOver = over.perDataset.find((e) => e.kind === 'items');
  assert.strictEqual(itemsAt.state, 'FRESH');
  assert.strictEqual(itemsAt.ageHours, 26);
  assert.strictEqual(itemsAt.reason, null);
  assert.strictEqual(itemsOver.state, 'DEGRADED');
});

test('bands: exactly at 36h is still DEGRADED; past 36h is ALARM (DAT-01: > 36h red + alarm)', () => {
  const at36 = evalWith({ items: ASOF - 36 * HOUR });
  const over = evalWith({ items: ASOF - 36 * HOUR - 1 });
  const itemsAt = at36.perDataset.find((e) => e.kind === 'items');
  const itemsOver = over.perDataset.find((e) => e.kind === 'items');
  assert.strictEqual(itemsAt.state, 'DEGRADED');
  assert.strictEqual(itemsAt.ageHours, 36);
  assert.strictEqual(itemsOver.state, 'ALARM');
  assert.strictEqual(itemsOver.reason, 'SLO_BREACH_ALARM_36H');
});

test('a dataset never sealed is ALARM with NO_SEAL_EVER and a null age — silence is never freshness', () => {
  const r = evalWith({ suppliers: 'never' });
  const sup = r.perDataset.find((e) => e.kind === 'suppliers');
  assert.strictEqual(sup.state, 'ALARM');
  assert.strictEqual(sup.ageHours, null);
  assert.strictEqual(sup.reason, 'NO_SEAL_EVER');
  assert.strictEqual(sup.lastSealedAt, null);
  const fresh = r.perDataset.find((e) => e.kind === 'items');
  assert.strictEqual(fresh.state, 'FRESH');
});

/* --------------------------------------------------------------- DAT-01 -- */

test('DAT-01 value is the worst age across file types', () => {
  const r = evalWith({
    items: ASOF - 10 * HOUR,
    open_pos: ASOF - 40 * HOUR,          // the worst — and an ALARM
    consumption_balances: ASOF - 30 * HOUR,
  });
  assert.strictEqual(r.worst.kind, 'open_pos');
  assert.strictEqual(r.worst.ageHours, 40);
  assert.strictEqual(r.worst.state, 'ALARM');
  assert.deepStrictEqual(r.dat01, { id: 'DAT-01', value: 40, state: 'ALARM', owner: 'DTA' });
});

test('DAT-01 value is null and state ALARM when ANY file type has never sealed — no silent number', () => {
  const r = evalWith({ suppliers: 'never' });
  assert.strictEqual(r.worst.kind, 'suppliers');
  assert.strictEqual(r.dat01.value, null);
  assert.strictEqual(r.dat01.state, 'ALARM');
  assert.strictEqual(r.dat01.owner, 'DTA');
});

/* ------------------------------------------------------------ fail-closed -- */

test('unknown dataset kind throws UNKNOWN_DATASET_KIND (fail-closed binding to ingestion kinds)', () => {
  throwsWith(() => F.evaluateFreshness({ asOf: ASOF, seals: [{ kind: 'not_a_kind', sealedAt: ASOF }] }),
    'UNKNOWN_DATASET_KIND');
});

test('a seal in the future of asOf throws; non-numeric asOf throws; non-array seals throw', () => {
  throwsWith(() => F.evaluateFreshness({ asOf: ASOF, seals: [{ kind: 'items', sealedAt: ASOF + 1 }] }),
    'FUTURE_SEAL');
  throwsWith(() => F.evaluateFreshness({ asOf: 'now', seals: [] }), 'INVALID_ASOF');
  throwsWith(() => F.evaluateFreshness({ asOf: ASOF, seals: 'nope' }), 'INVALID_SEALS');
  throwsWith(() => F.evaluateFreshness({ seals: [] }), 'INVALID_ASOF');
});

test('invalid seal entries throw: non-object and non-numeric sealedAt', () => {
  throwsWith(() => F.evaluateFreshness({ asOf: ASOF, seals: [null] }), 'INVALID_SEAL_ENTRY');
  throwsWith(() => F.evaluateFreshness({ asOf: ASOF, seals: [{ kind: 'items', sealedAt: 'yesterday' }] }),
    'INVALID_SEAL_ENTRY');
});

test('invalid deliveries cadence throws (finite positive hours only)', () => {
  for (const bad of [0, -1, 'weekly', Infinity, NaN]) {
    throwsWith(() => evalWith({}, { missingDeliveriesCadenceHours: bad }), 'INVALID_DELIVERIES_CADENCE');
  }
});

test('multiple seals per kind take the last successful (max) — DAT-01: now − last sealed ingest', () => {
  const r = F.evaluateFreshness({
    asOf: ASOF,
    seals: [
      { kind: 'items', sealedAt: ASOF - 9 * HOUR },
      { kind: 'items', sealedAt: ASOF - 2 * HOUR },   // the last successful seal
    ],
  });
  const items = r.perDataset.find((e) => e.kind === 'items');
  assert.strictEqual(items.ageHours, 2);
  assert.strictEqual(items.state, 'FRESH');
});

/* ------------------------------------------------- missing-deliveries -- */

test('missing-deliveries: fresh deliveries raise nothing', () => {
  const r = evalWith({});
  assert.deepStrictEqual(r.missingDeliveries, { raised: false });
  assert.strictEqual(r.alarms.length, 0);
});

test('missing-deliveries: deliveries past the accepted cadence raise MISSING_DELIVERIES with the H8 task + banner', () => {
  const r = evalWith({ deliveries: ASOF - 30 * HOUR });   // 26 < 30 ≤ 36 → DEGRADED
  const md = r.missingDeliveries;
  assert.strictEqual(md.raised, true);
  assert.strictEqual(md.code, 'MISSING_DELIVERIES');
  assert.strictEqual(md.ageHours, 30);
  assert.strictEqual(md.state, 'DEGRADED');
  assert.strictEqual(md.owner, 'DTA');
  assert.strictEqual(md.task.type, 'DATA_HEALTH');
  assert.strictEqual(md.task.field, 'deliveriesHistory');
  assert.ok(md.task.detail.includes('30h'), 'task detail names the age');
  assert.ok(md.task.detail.includes('H8'), 'task detail names the H8 refusal consequence');
  assert.ok(md.banner.text.includes('30h'), 'banner names the age');
  assert.ok(md.banner.text.includes('H8'), 'banner names the H8 consequence');
  /* DEGRADED is not a DAT-01 alarm: the red line is > 36h. */
  assert.strictEqual(r.alarms.length, 0);
});

test('missing-deliveries: a tenant on a weekly deliveries cadence passes 182 and stays quiet at 30h', () => {
  const r = evalWith({ deliveries: ASOF - 30 * HOUR }, { missingDeliveriesCadenceHours: 182 });
  assert.deepStrictEqual(r.missingDeliveries, { raised: false });
  /* DAT-01's pipeline bands do NOT move with the tenant cadence: 30h is
   * still DEGRADED on the per-kind envelope (named, never silent). */
  const del = r.perDataset.find((e) => e.kind === 'deliveries');
  assert.strictEqual(del.state, 'DEGRADED');
});

test('missing-deliveries: never-sealed deliveries raise with a null age and the never-sealed texts', () => {
  const r = evalWith({ deliveries: 'never' });
  const md = r.missingDeliveries;
  assert.strictEqual(md.raised, true);
  assert.strictEqual(md.ageHours, null);
  assert.strictEqual(md.state, 'ALARM');
  assert.ok(md.task.detail.includes('never sealed'), 'task names the never-sealed case');
  assert.ok(md.banner.text.includes('never sealed'), 'banner names the never-sealed case');
  /* The freshness alarm for the same kind also exists — two channels, one fact. */
  const alarms = r.alarms.filter((a) => a.dataset === 'deliveries');
  assert.strictEqual(alarms.length, 1);
  assert.strictEqual(alarms[0].reason, 'NO_SEAL_EVER');
});

/* ---------------------------------------------------------------- alarms -- */

test('alarms array: one FRESHNESS_ALARM per breaching dataset, deterministic dataset-asc order', () => {
  const r = evalWith({
    items: ASOF - 50 * HOUR,
    suppliers: ASOF - 40 * HOUR,
    planning_params: ASOF - 36 * HOUR,     // exactly 36 → DEGRADED, no alarm
  });
  assert.deepStrictEqual(r.alarms.map((a) => a.dataset), ['items', 'suppliers']);
  assert.strictEqual(r.alarms[0].code, 'FRESHNESS_ALARM');
  assert.strictEqual(r.alarms[0].ageHours, 50);
  assert.strictEqual(r.alarms[0].reason, 'SLO_BREACH_ALARM_36H');
  assert.strictEqual(r.alarms[1].ageHours, 40);
  /* the deterministic order holds across a fresh evaluation of the same input */
  const again = evalWith({
    items: ASOF - 50 * HOUR,
    suppliers: ASOF - 40 * HOUR,
    planning_params: ASOF - 36 * HOUR,
  });
  assert.deepStrictEqual(r.alarms, again.alarms);
});

test('every alarm carries the DATA_HEALTH task + banner conventions (type, field, detail / text)', () => {
  const r = evalWith({ items: ASOF - 50 * HOUR });
  const a = r.alarms[0];
  assert.strictEqual(a.owner, 'DTA');
  assert.strictEqual(a.task.type, 'DATA_HEALTH');
  assert.strictEqual(a.task.field, 'freshness.items');
  assert.ok(typeof a.task.detail === 'string' && a.task.detail.length > 0);
  assert.ok(typeof a.banner.text === 'string' && a.banner.text.length > 0);
  assert.ok(a.banner.text.includes('50h'), 'banner names the age');
  assert.ok(a.banner.text.includes('36h'), 'banner names the DAT-01 red line');
});

/* ------------------------------------------------- binding tripwires -- */

test('binding: the 26/36 bands are extracted from the kpi-catalog DAT-01 target text — spec drift fails here', () => {
  const entry = KPI.kpiById('DAT-01');
  assert.ok(entry, 'the catalog exposes DAT-01');
  const slo = /≤\s*(\d+)h/.exec(entry.target);
  const alarm = /(?:>|>\s*|=)\s*(\d+)h\s*(?:red|\+)?/.exec(entry.target.split(';')[1] || '');
  assert.ok(slo, 'DAT-01 target text carries the "≤ Nn h" SLO form');
  assert.ok(alarm, 'DAT-01 target text carries the "> N h red + alarm" form');
  assert.strictEqual(Number(slo[1]), F.DAT01_SLO_HOURS, 'SLO constant matches the catalog text');
  assert.strictEqual(Number(alarm[1]), F.DAT01_ALARM_HOURS, 'alarm constant matches the catalog text');
  assert.strictEqual(entry.owner, 'DTA');
  assert.strictEqual(F.DAT01_OWNER, 'DTA');
  assert.strictEqual(entry.cadence, 'hourly');
});

test('binding: DATASET_KINDS matches the ingestion manifest 1:1 and the ops module evaluates all eight', () => {
  const manifest = require(path.join(__dirname, '..', '..', 'ingestion', 'sentinel.module.json'));
  assert.deepStrictEqual([...KINDS], manifest.ingestionKinds);
  assert.strictEqual(KINDS.length, 8);
  assert.ok(KINDS.includes('deliveries'), 'the demand primitive is one of the kinds');
  const r = evalWith({});
  assert.strictEqual(r.perDataset.length, 8);
  assert.ok(r.perDataset.every((e) => e.state === 'FRESH'));
});

test('determinism: identical inputs produce deep-equal output', () => {
  const a = evalWith({ items: ASOF - 50 * HOUR, suppliers: 'never' });
  const b = evalWith({ items: ASOF - 50 * HOUR, suppliers: 'never' });
  assert.deepStrictEqual(a, b);
  /* and the whole envelope is canonical JSON round-trip stable (seal-hash discipline) */
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
});

test('binding: the freshness surface re-exports the ingestion-derived kind list unmutated', () => {
  /* The app's data-health composition builds its seal-stamp array from the
   * re-export (one core surface for the whole freshness contract). It must
   * be the SAME list the evaluator enforces — a copy would let the surface
   * and the validation vocabulary drift apart silently. */
  assert.deepStrictEqual([...F.DATASET_KINDS], [...KINDS]);
  assert.ok(Object.isFrozen(F.DATASET_KINDS), 'the re-export stays frozen');
});

/* ---------------------------------------------------------------- report -- */

console.log(`\n  ops/freshness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
